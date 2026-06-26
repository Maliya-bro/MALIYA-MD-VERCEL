import express from "express";
import { getAdminPw, getMongoUri, getMongoDb, getSessionCollection } from "./security.js";
import { MongoClient } from "mongodb";

const router = express.Router();

function getDb() {
    const uri = getMongoUri();
    if (!uri) throw new Error("MONGODB_URI missing");
    const client = new MongoClient(uri, { maxPoolSize: 2, family: 4, serverSelectionTimeoutMS: 8000 });
    return client;
}

function checkPw(req, res) {
    const pw = req.query.pw || req.body?.pw || "";
    const correct = getAdminPw();
    if (!correct || pw !== correct) {
        res.status(403).send(`<!DOCTYPE html><html><head><title>403</title></head><body style="background:#000;color:#fff;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>403 — Not Found</h2></body></html>`);
        return false;
    }
    return true;
}

router.get("/", async (req, res) => {
    if (!checkPw(req, res)) return;

    const pw = req.query.pw;
    let sessions = [];
    let totalSessions = 0;
    let pairCount = 0;
    let qrCount = 0;
    let error = null;

    let client;
    try {
        client = getDb();
        await client.connect();
        const db = client.db(getMongoDb());
        const col = db.collection(getSessionCollection());
        sessions = await col.find({}, {
            projection: { "primaryFile.data": 0 },
            sort: { createdAt: -1 },
            limit: 200
        }).toArray();
        totalSessions = sessions.length;
        pairCount = sessions.filter(s => s.source === "pair-code").length;
        qrCount = sessions.filter(s => s.source === "qr").length;
    } catch (e) {
        error = e.message;
    } finally {
        try { await client?.close(); } catch (_) {}
    }

    const sessionRows = sessions.map(s => {
        const created = s.createdAt ? new Date(s.createdAt).toLocaleString("en-GB", { timeZone: "Asia/Colombo" }) : "—";
        const updated = s.updatedAt ? new Date(s.updatedAt).toLocaleString("en-GB", { timeZone: "Asia/Colombo" }) : "—";
        const sourceBadge = s.source === "pair-code"
            ? `<span class="badge badge-pair">PAIR</span>`
            : s.source === "qr"
            ? `<span class="badge badge-qr">QR</span>`
            : `<span class="badge badge-other">${s.source || "?"}</span>`;
        const phone = s.phone || "—";
        const sid = s.sessionId ? s.sessionId.substring(0, 20) + "…" : "—";
        return `
        <tr>
          <td class="mono" title="${s.sessionId || ''}">${sid}</td>
          <td class="phone">${phone}</td>
          <td>${sourceBadge}</td>
          <td>${created}</td>
          <td>${updated}</td>
          <td><span class="status-dot ${s.status === 'ready' ? 'dot-green' : 'dot-grey'}"></span>${s.status || "?"}</td>
          <td>
            <button class="del-btn" onclick="deleteSession('${encodeURIComponent(s.sessionId || '')}', this)" title="Delete session">🗑</button>
          </td>
        </tr>`;
    }).join("");

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MALIYA-MD · Admin Panel</title>
<style>
  :root{--bg:#050d1a;--bg2:#071428;--card:rgba(10,25,50,0.9);--border:rgba(0,180,255,0.15);--accent:#00b4ff;--accent2:#0066ff;--accent3:#00ffd5;--text:#e8f4ff;--muted:rgba(150,200,255,0.6);--danger:#ff3366;--success:#00ffd5}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:"Segoe UI",Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:0}
  body::before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(0,100,255,.04) 1px,transparent 1px),linear-gradient(90deg,rgba(0,100,255,.04) 1px,transparent 1px);background-size:50px 50px;pointer-events:none;z-index:0}
  .wrap{max-width:1200px;margin:0 auto;padding:24px 20px;position:relative;z-index:1}
  header{display:flex;align-items:center;justify-content:space-between;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--border)}
  .logo{font-size:22px;font-weight:900;letter-spacing:2px}.logo span{color:var(--accent)}
  .badge-admin{background:rgba(255,51,102,.12);border:1px solid rgba(255,51,102,.35);color:#ff3366;font-size:11px;font-weight:800;padding:3px 10px;border-radius:999px;letter-spacing:1px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px}
  .stat{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:18px 20px;backdrop-filter:blur(10px)}
  .stat .num{font-size:32px;font-weight:900;color:var(--accent)}
  .stat .lbl{font-size:11px;color:var(--muted);font-weight:700;margin-top:4px;letter-spacing:.5px}
  .section-title{font-size:16px;font-weight:900;margin-bottom:14px;display:flex;align-items:center;gap:10px}
  .section-title span{font-size:12px;font-weight:600;color:var(--muted)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;backdrop-filter:blur(10px);margin-bottom:28px}
  .card-head{padding:14px 20px;border-bottom:1px solid var(--border);background:rgba(0,40,90,.4);display:flex;align-items:center;justify-content:space-between}
  .card-head h3{font-size:14px;font-weight:800}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th{padding:10px 14px;text-align:left;font-size:11px;font-weight:800;color:var(--muted);letter-spacing:.5px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:10px 14px;border-bottom:1px solid rgba(0,180,255,.06);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:rgba(0,180,255,.04)}
  .mono{font-family:monospace;font-size:12px;color:rgba(150,200,255,.7)}
  .phone{font-weight:700;color:var(--accent3)}
  .badge{font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;letter-spacing:.5px}
  .badge-pair{background:rgba(0,180,255,.12);border:1px solid rgba(0,180,255,.3);color:var(--accent)}
  .badge-qr{background:rgba(0,255,180,.1);border:1px solid rgba(0,255,180,.3);color:#00ffd5}
  .badge-other{background:rgba(150,150,150,.12);border:1px solid rgba(150,150,150,.2);color:#aaa}
  .status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot-green{background:#00ffd5;box-shadow:0 0 5px #00ffd5}
  .dot-grey{background:#666}
  .del-btn{background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.25);color:#ff3366;padding:4px 9px;border-radius:7px;cursor:pointer;font-size:13px;transition:all .2s}
  .del-btn:hover{background:rgba(255,51,102,.22)}
  .error-box{background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.3);border-radius:10px;padding:14px 18px;color:#ff8899;font-size:13px;margin-bottom:20px}
  .empty{text-align:center;padding:40px;color:var(--muted);font-size:13px}
  .search-bar{padding:8px 14px;background:rgba(0,20,50,.7);border:1px solid rgba(0,180,255,.2);border-radius:9px;color:#fff;font-size:13px;outline:none;width:220px}
  .search-bar::placeholder{color:rgba(150,200,255,.35)}
  .search-bar:focus{border-color:var(--accent)}
  .logout-btn{background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.25);color:#ff3366;padding:7px 16px;border-radius:9px;cursor:pointer;font-size:13px;font-weight:700;text-decoration:none}
  .toast{position:fixed;bottom:24px;right:24px;background:#0a1e3c;border:1px solid var(--accent);border-radius:12px;padding:14px 20px;font-size:13px;font-weight:700;color:var(--accent);opacity:0;transition:opacity .3s;z-index:9999;pointer-events:none}
  .toast.show{opacity:1}
  @media(max-width:600px){.stats{grid-template-columns:1fr 1fr}.search-bar{width:140px}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">MALIYA<span>-MD</span></div>
    <div style="display:flex;align-items:center;gap:12px">
      <span class="badge-admin">ADMIN</span>
      <a href="/" class="logout-btn">← Exit</a>
    </div>
  </header>

  ${error ? `<div class="error-box">⚠️ MongoDB error: ${error}</div>` : ""}

  <div class="stats">
    <div class="stat"><div class="num">${totalSessions}</div><div class="lbl">TOTAL SESSIONS</div></div>
    <div class="stat"><div class="num" style="color:var(--accent)">${pairCount}</div><div class="lbl">PAIR CODE</div></div>
    <div class="stat"><div class="num" style="color:var(--accent3)">${qrCount}</div><div class="lbl">QR CODE</div></div>
    <div class="stat"><div class="num" style="color:#00ff88">${sessions.filter(s=>s.status==="ready").length}</div><div class="lbl">ACTIVE</div></div>
  </div>

  <div class="card">
    <div class="card-head">
      <h3>📦 Sessions</h3>
      <input class="search-bar" type="text" placeholder="Search phone / session…" oninput="filterTable(this.value)" id="searchInput">
    </div>
    <div class="table-wrap">
      ${sessions.length === 0 && !error ? `<div class="empty">No sessions found in MongoDB.</div>` : `
      <table id="sessionTable">
        <thead><tr>
          <th>SESSION ID</th><th>PHONE</th><th>SOURCE</th><th>CREATED (LK)</th><th>UPDATED (LK)</th><th>STATUS</th><th></th>
        </tr></thead>
        <tbody id="tableBody">${sessionRows}</tbody>
      </table>`}
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const PW = ${JSON.stringify(pw)};

function showToast(msg, color) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.style.borderColor = color || "var(--accent)";
  t.style.color = color || "var(--accent)";
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2800);
}

async function deleteSession(sessionId, btn) {
  if (!confirm("Delete this session from MongoDB?")) return;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const res = await fetch("/x-admin/delete?pw=" + encodeURIComponent(PW), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: decodeURIComponent(sessionId) })
    });
    const data = await res.json();
    if (data.ok) {
      btn.closest("tr").remove();
      showToast("✅ Session deleted", "#00ffd5");
      const numEl = document.querySelector(".stat:first-child .num");
      if (numEl) numEl.textContent = parseInt(numEl.textContent) - 1;
    } else {
      showToast("❌ " + (data.error || "Failed"), "#ff3366");
      btn.disabled = false;
      btn.textContent = "🗑";
    }
  } catch (e) {
    showToast("❌ Network error", "#ff3366");
    btn.disabled = false;
    btn.textContent = "🗑";
  }
}

function filterTable(q) {
  const rows = document.querySelectorAll("#tableBody tr");
  const lq = q.toLowerCase();
  rows.forEach(r => {
    r.style.display = r.textContent.toLowerCase().includes(lq) ? "" : "none";
  });
}
</script>
</body>
</html>`);
});

router.post("/delete", async (req, res) => {
    if (!checkPw(req, res)) return;
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ ok: false, error: "sessionId required" });

    let client;
    try {
        client = getDb();
        await client.connect();
        const db = client.db(getMongoDb());
        const col = db.collection(getSessionCollection());
        const result = await col.deleteOne({ sessionId });
        res.json({ ok: result.deletedCount > 0, deleted: result.deletedCount });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    } finally {
        try { await client?.close(); } catch (_) {}
    }
});

export default router;
