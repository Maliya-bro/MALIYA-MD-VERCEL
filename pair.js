import express from "express";
import fs from "fs";
import pino from "pino";
import { z } from "zod";
import {
    makeWASocket,
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestWaWebVersion,
} from "@whiskeysockets/baileys";
import { phone as validatePhone } from "phone";
import { saveSessionState, checkSessionReady } from "./mongodb.js";
import { setSessionId } from "./session-store.js";

const phoneQuerySchema = z.object({
    number: z
        .string({ required_error: "Phone number is required." })
        .min(7, "Phone number too short — minimum 7 digits.")
        .max(15, "Phone number too long — maximum 15 digits.")
        .regex(/^[0-9]+$/, "Phone number must contain digits only."),
});

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
        for (let i = 0; i < len; i++)
            str += chars[Math.floor(Math.random() * chars.length)];
        return str;
    }
    return `${randomString(8)}#${randomString(43)}`;
}

// ── NEW: Polling endpoint — frontend calls this every 2s after getting the code ──
// Rate limiter automatically skipped for this path (see index.js skip fn)
router.get("/check-status", async (req, res) => {
    const parsed = phoneQuerySchema.safeParse({
        number: String(req.query.number ?? "").replace(/[^0-9]/g, ""),
    });
    if (!parsed.success) {
        return res.status(400).json({ ready: false });
    }

    try {
        const ready = await checkSessionReady(parsed.data.number);
        return res.json({ ready });
    } catch (err) {
        console.error("check-status error:", err);
        return res.status(500).json({ ready: false });
    }
});

router.get("/", async (req, res) => {
    const parsed = phoneQuerySchema.safeParse({
        number: String(req.query.number ?? "").replace(/[^0-9]/g, ""),
    });
    if (!parsed.success) {
        const msg = parsed.error.errors[0]?.message || "Invalid phone number.";
        return res.status(400).send({ code: msg });
    }

    let num = parsed.data.number;

    const phoneResult = validatePhone("+" + num);
    if (!phoneResult.isValid) {
        return res.status(400).send({
            code: "Invalid phone number. Please enter your full international number without + or spaces.",
        });
    }
    num = phoneResult.phoneNumber.replace("+", "");

    const dirs = "/tmp/" + num;
    removeFile(dirs);

    const sessionId = generateMegaStyleId();
    let codeSent = false;
    let sessionDone = false;

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

        try {
            let version;
            try {
                const fetched = await fetchLatestWaWebVersion();
                version = fetched.version;
            } catch (_) {
                version = [2, 3000, 1042015614];
            }
            let KnightBot = makeWASocket({
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
                maxRetries: 3,
            });

            KnightBot.ev.on("creds.update", safeSaveCreds);

            KnightBot.ev.on("connection.update", async (update) => {
                if (sessionDone) return;

                const { connection, lastDisconnect, isNewLogin } = update;

                if (connection === "open") {
                    sessionDone = true;
                    console.log("Connected — uploading session to MongoDB...");

                    try {
                        const credsPath = dirs + "/creds.json";
                        const savedSessionId = await saveSessionState({
                            sessionId,
                            phone: num,
                            filePath: credsPath,
                            fileName: `creds_${num}_${Date.now()}.json`,
                            source: "pair-code",
                        });

                        console.log("Session saved. ID:", savedSessionId);
                        setSessionId(savedSessionId);

                        await delay(1500);
                        KnightBot.ev.removeAllListeners();
                        try { await KnightBot.ws.close(); } catch (_) {}
                        removeFile(dirs);
                        console.log("Done!");
                    } catch (error) {
                        console.error("MongoDB upload error:", error);
                        KnightBot.ev.removeAllListeners();
                        try { await KnightBot.ws.close(); } catch (_) {}
                        removeFile(dirs);
                    }
                    return;
                }

                if (isNewLogin) console.log("New login via pair code");

                if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const reason = lastDisconnect?.error?.message || "unknown";
                    console.log(`Connection closed. Code: ${statusCode}, Reason: ${reason}`);

                    await safeSaveCreds();

                    if (statusCode === 401 || sessionDone) {
                        console.log("Session ended — not reconnecting.");
                        if (!sessionDone) removeFile(dirs);
                        return;
                    }

                    if (codeSent && statusCode === 408) {
                        console.log("Pair code session ended (408) — cleaning up.");
                        removeFile(dirs);
                        return;
                    }

                    if (codeSent) {
                        console.log("Code was already sent — reconnecting to await pairing confirmation.");
                    } else {
                        console.log("Reconnecting before code was sent...");
                    }

                    KnightBot.ev.removeAllListeners();
                    try { KnightBot.ws.close(); } catch (_) {}

                    const reconnectDelay = String(reason).toLowerCase().includes("conflict") ? 8000 : 3000;
                    await delay(reconnectDelay);

                    try {
                        await initiateSession();
                    } catch (e) {
                        console.error("Reconnect error:", e);
                    }
                }
            });

            if (!KnightBot.authState.creds.registered && !codeSent) {
                await delay(5000);
                num = num.replace(/[^\d+]/g, "");
                if (num.startsWith("+")) num = num.substring(1);

                try {
                    let code = await KnightBot.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join("-") || code;
                    codeSent = true;
                    if (!res.headersSent) {
                        console.log({ num, code });
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error("Error requesting pairing code:", error);
                    if (!res.headersSent) {
                        res.status(503).send({
                            code: "Failed to get pairing code. Please check your number and try again.",
                        });
                    }
                    sessionDone = true;
                    KnightBot.ev.removeAllListeners();
                    try { KnightBot.ws.close(); } catch (_) {}
                    removeFile(dirs);
                }
            }
        } catch (err) {
            console.error("Error initializing session:", err);
            if (!res.headersSent) {
                res.status(503).send({ code: "Service Unavailable" });
            }
            removeFile(dirs);
        }
    }

    await initiateSession();
});

export default router;
