import cp from "child_process";

const BLOCKED_FN  = (..._args) => { throw new Error("child_process execution is disabled on this server."); };
const BLOCKED_OBJ = { stdout: null, stderr: null, stdin: null, pid: -1, killed: false, on: () => {}, kill: () => {} };

const DANGER_METHODS = [
  "exec", "execSync",
  "spawn", "spawnSync",
  "execFile", "execFileSync",
  "fork",
];

for (const method of DANGER_METHODS) {
  if (typeof cp[method] === "function") {
    try {
      Object.defineProperty(cp, method, {
        value: BLOCKED_FN,
        writable: false,
        configurable: false,
        enumerable: true,
      });
    } catch (_) {
      cp[method] = BLOCKED_FN;
    }
  }
}

try { Object.freeze(cp); } catch (_) {}

const _MONGODB_URI          = process.env.MONGODB_URI          || "";
const _UNBAN_CODE           = process.env.UNBAN_CODE           || "";
const _ADMIN_PW             = process.env.ADMIN_PW             || "";
const _MONGODB_DB           = process.env.MONGODB_DB           || "maliya_md";
const _SESSION_COLLECTION   = process.env.SESSION_COLLECTION   || "wa_sessions";

delete process.env.MONGODB_URI;
delete process.env.UNBAN_CODE;
delete process.env.ADMIN_PW;

export function getMongoUri()         { return _MONGODB_URI; }
export function getUnbanCode()        { return _UNBAN_CODE; }
export function getAdminPw()          { return _ADMIN_PW; }
export function getMongoDb()          { return _MONGODB_DB; }
export function getSessionCollection(){ return _SESSION_COLLECTION; }

const SENSITIVE_PATTERNS = [_MONGODB_URI, _UNBAN_CODE, _ADMIN_PW].filter(Boolean);

export function redactSensitive(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const val of SENSITIVE_PATTERNS) {
    out = out.split(val).join("[REDACTED]");
  }
  return out;
}

const _origError = console.error.bind(console);
console.error = (...args) => {
  const sanitized = args.map(a =>
    typeof a === "string" ? redactSensitive(a) : a
  );
  _origError(...sanitized);
};

console.log("Security hardening active.");
