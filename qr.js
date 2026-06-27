import express from "express";
import fs from "fs";
import pino from "pino";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { saveSessionState } from "./mongodb.js";
import { setSessionId } from "./session-store.js";

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error("Error removing file:", e);
    }
}

function generateMegaStyleId() {
    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    function randomString(len) {
        let str = "";
        for (let i = 0; i < len; i++) {
            str += chars[Math.floor(Math.random() * chars.length)];
        }
        return str;
    }
    return `${randomString(8)}#${randomString(43)}`;
}

router.get("/", async (req, res) => {
    const tempId =
        Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const sessionId = generateMegaStyleId();
    const dirs = `/tmp/qr_sessions/session_${tempId}`;

    if (!fs.existsSync("/tmp/qr_sessions")) {
        fs.mkdirSync("/tmp/qr_sessions", { recursive: true });
    }

    removeFile(dirs);

    let responseSent = false;
    let sessionDone = false;
    let reconnecting = false;

    async function initiateSession() {
        if (sessionDone) return;

        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        const safeSaveCreds = async () => {
            try {
                await saveCreds();
            } catch (e) {
                console.error("creds.update write error (non-fatal):", e.message);
            }
        };

        let KnightBot;
        try {
            let version;
            try {
                const fetched = await fetchLatestWaWebVersion();
                version = fetched.version;
            } catch (_) {
                version = [2, 3000, 1042015614];
            }

            KnightBot = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(
                        state.keys,
                        pino({ level: "fatal" }).child({ level: "fatal" }),
                    ),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.macOS("Safari"),
                markOnlineOnConnect: false,
                generateHighQualityLinkPreview: false,
                syncFullHistory: false,
                getMessage: async () => ({ conversation: "hello" }),
                patchMessageBeforeSending: (m) => m,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                retryRequestDelayMs: 250,
                maxRetries: 5,
            });
        } catch (err) {
            console.error("Error creating socket:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            if (!responseSent) removeFile(dirs);
            return;
        }

        const timeoutHandle = setTimeout(() => {
            if (!responseSent) {
                responseSent = true;
                sessionDone = true;
                if (!res.headersSent) {
                    res.status(408).send({ code: "QR generation timeout" });
                }
                KnightBot.ev.removeAllListeners();
                try { KnightBot.ws.close(); } catch (_) {}
                removeFile(dirs);
            }
        }, 30000);

        KnightBot.ev.on("connection.update", async (update) => {
            if (sessionDone) return;

            const { connection, lastDisconnect, isNewLogin, isOnline, qr } = update;

            if (responseSent) clearTimeout(timeoutHandle);

            if (qr && !responseSent) {
                console.log("QR Code Generated!");
                try {
                    const qrDataURL = await QRCode.toDataURL(qr, {
                        errorCorrectionLevel: "M",
                        type: "image/png",
                        quality: 0.92,
                        margin: 1,
                        color: { dark: "#000000", light: "#FFFFFF" },
                    });
                    if (!responseSent) {
                        responseSent = true;
                        clearTimeout(timeoutHandle);
                        console.log("QR Code sent to client");
                        res.send({
                            qr: qrDataURL,
                            message: "QR Code Generated! Scan it with your WhatsApp app.",
                            instructions: [
                                "1. Open WhatsApp on your phone",
                                "2. Go to Settings > Linked Devices",
                                '3. Tap "Link a Device"',
                                "4. Scan the QR code above",
                            ],
                        });
                    }
                } catch (qrError) {
                    console.error("Error generating QR code:", qrError);
                    if (!responseSent) {
                        responseSent = true;
                        sessionDone = true;
                        clearTimeout(timeoutHandle);
                        res.status(500).send({ code: "Failed to generate QR code" });
                    }
                }
            }

            if (connection === "open") {
                sessionDone = true;
                clearTimeout(timeoutHandle);
                console.log("Connected successfully!");

                try {
                    const credsPath = dirs + "/creds.json";
                    const savedSessionId = await saveSessionState({
                        sessionId,
                        filePath: credsPath,
                        fileName: `creds_qr_${tempId}.json`,
                        source: "qr",
                    });
                    console.log("Session uploaded. Session ID:", savedSessionId);
                    setSessionId(savedSessionId);
                } catch (error) {
                    console.error("Error uploading to MongoDB:", error);
                }

                await delay(1000);
                KnightBot.ev.removeAllListeners();
                try { await KnightBot.ws.close(); } catch (_) {}
                removeFile(dirs);
                console.log("Process completed successfully!");
                return;
            }

            if (isNewLogin) console.log("New login via QR code");
            if (isOnline) console.log("Client is online");

            if (connection === "close") {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const reason = lastDisconnect?.error?.message || "unknown";
                console.log(`Connection closed. Code: ${statusCode}, Reason: ${reason}`);

                if (statusCode === 401 || sessionDone) {
                    console.log("Session ended — not reconnecting.");
                    sessionDone = true;
                    return;
                }

                if (reconnecting) {
                    console.log("Reconnect already in progress — skipping.");
                    return;
                }

                KnightBot.ev.removeAllListeners();
                try { KnightBot.ws.close(); } catch (_) {}

                const reconnectDelay = String(reason).toLowerCase().includes("conflict") ? 8000 : 3000;
                console.log(`Reconnecting in ${reconnectDelay / 1000}s...`);
                reconnecting = true;
                await delay(reconnectDelay);
                reconnecting = false;

                try {
                    await initiateSession();
                } catch (e) {
                    console.error("initiateSession error:", e);
                }
            }
        });

        KnightBot.ev.on("creds.update", safeSaveCreds);
    }

    await initiateSession();
});

export default router;
