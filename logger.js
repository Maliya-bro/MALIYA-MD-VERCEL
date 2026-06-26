const clients = new Set();

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

function broadcast(level, args) {
    const msg = args.map(a => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === "object" && a !== null) {
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        }
        return String(a);
    }).join(" ");
    const payload = `data: ${JSON.stringify({ level, msg, ts: Date.now() })}\n\n`;
    for (const res of clients) {
        try { res.write(payload); } catch (_) { clients.delete(res); }
    }
}

console.log = (...args) => { origLog(...args); broadcast("info", args); };
console.error = (...args) => { origError(...args); broadcast("error", args); };
console.warn = (...args) => { origWarn(...args); broadcast("warn", args); };

export function addLogClient(res) {
    clients.add(res);
    return () => clients.delete(res);
}
