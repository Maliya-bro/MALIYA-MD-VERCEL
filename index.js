import { redactSensitive } from "./security.js";

import express    from "express";
import helmet     from "helmet";
import cors       from "cors";
import jwt        from "jsonwebtoken";
import { fileURLToPath } from "url";
import path       from "path";
import { createRequire } from "module";
import { getUnbanCode } from "./security.js";

const require      = createRequire(import.meta.url);
const hpp          = require("hpp");
const cookieParser = require("cookie-parser");

import "./logger.js";
import { addLogClient }            from "./logger.js";
import { warmupDb, keepAlivePing } from "./mongodb.js";
import securityLogger              from "./lib/securityLogger.js";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (non-fatal):", reason?.message || reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (non-fatal):", err?.message || err);
});

import pairRouter       from "./pair.js";
import qrRouter         from "./qr.js";
import adminPanelRouter from "./admin-panel.js";
import { getSessionId, setSessionId } from "./session-store.js";

const app        = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PORT       = process.env.PORT || 3000;

import("events").then((m) => { m.EventEmitter.defaultMaxListeners = 500; });

app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy:     false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: true,
  methods:       ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials:   true,
}));

app.use(express.json({ limit: "10kb" }));
app.use(express.urlencoded({ extended: true, limit: "10kb" }));
app.use(hpp());
app.use(cookieParser());

function getClientIP(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
}

function sanitizeMongo(obj, ip = "") {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") || key.includes(".")) {
      const safeKey = key.replace(/\$/g, "_").replace(/\./g, "_");
      obj[safeKey]  = obj[key];
      delete obj[key];
      console.warn(`NoSQL injection key blocked: "${key}" → "${safeKey}"`);
      securityLogger.warn(`NOSQL_INJECTION_BLOCKED ip=${ip} key="${key}"`);
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      sanitizeMongo(obj[key], ip);
    }
  }
}

app.use((req, _res, next) => {
  const ip = getClientIP(req);
  sanitizeMongo(req.body,   ip);
  sanitizeMongo(req.params, ip);
  next();
});

app.use(express.static(__dirname));

app.get(["/health", "/_health", "/ping"], (_req, res) => res.status(200).send("OK"));

app.get("/events", (req, res) => {
  res.set({
    "Content-Type":      "text/event-stream",
    "Cache-Control":     "no-cache",
    Connection:          "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const remove = addLogClient(res);
  const hb     = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => { clearInterval(hb); remove(); });
});

app.get("/", (_req, res) => {
  try {
    res.set({ "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" });
    res.sendFile(path.join(__dirname, "pair.html"));
  } catch (err) {
    console.error("UI load error:", err);
    res.status(500).send("Error loading UI");
  }
});

// ── Admin JWT auth ────────────────────────────────────────────────────────────
function requireJWT(req, res, next) {
  const secret = getUnbanCode();
  if (!secret) return res.status(503).json({ ok: false, error: "Auth not configured." });

  const fromCookie = req.cookies?.adminToken;
  const authHeader  = req.headers["authorization"] || "";
  const fromHeader  = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const token       = fromCookie || fromHeader;

  if (!token) {
    securityLogger.warn(`AUTH_MISSING ip=${getClientIP(req)} path=${req.path}`);
    return res.status(401).json({ ok: false, error: "Missing token." });
  }
  try {
    req.jwtPayload = jwt.verify(token, secret);
    next();
  } catch {
    securityLogger.warn(`AUTH_INVALID ip=${getClientIP(req)} path=${req.path}`);
    return res.status(403).json({ ok: false, error: "Invalid or expired token." });
  }
}

app.post("/admin/token", (req, res) => {
  const secret = getUnbanCode();
  if (!secret) return res.status(503).json({ ok: false, error: "Auth not configured." });

  const { code } = req.body || {};
  const ip       = getClientIP(req);

  if (!code || String(code).trim() !== String(secret).trim()) {
    securityLogger.warn(`ADMIN_TOKEN_WRONG_CODE ip=${ip}`);
    return res.status(403).json({ ok: false, error: "Invalid code." });
  }

  const token = jwt.sign({ role: "admin" }, secret, { expiresIn: "1h" });
  res.cookie("adminToken", token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge:   60 * 60 * 1000,
  });

  console.log(`Admin JWT issued for IP: ${ip}`);
  res.json({ ok: true, token });
});

app.post("/admin/logout", (_req, res) => {
  res.clearCookie("adminToken");
  res.json({ ok: true });
});

app.get("/session-id", (_req, res) => res.json({ sessionId: getSessionId() }));

app.post("/session-id/clear", requireJWT, (_req, res) => {
  setSessionId("");
  console.log(`Session cleared by admin (IP: ${getClientIP(_req)})`);
  res.json({ ok: true });
});

// ── Routes (no rate limiting) ─────────────────────────────────────────────────
app.use("/pair",    pairRouter);
app.use("/qr",      qrRouter);
app.use("/x-admin", adminPanelRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const safeMsg = redactSensitive(err?.message || "An unexpected error occurred.");
  console.error(`[${req.method} ${req.path}] ${safeMsg}`);
  securityLogger.warn(`SERVER_ERROR method=${req.method} path=${req.path} msg="${safeMsg.slice(0, 120)}"`);
  const status = typeof err?.status === "number" ? err.status : 500;
  res.status(status).json({ error: safeMsg });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  warmupDb().then(() => { setInterval(keepAlivePing, 30 * 1000); });
});

export default app;
