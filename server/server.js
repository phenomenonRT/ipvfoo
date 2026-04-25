/**
 * IPvFoo Collector Server
 * Accepts domain+IP entries from the browser extension and stores them in SQLite.
 * Also serves a simple web UI for browsing saved data.
 *
 * Usage:
 *   npm install
 *   node server.js [port]        (default port: 3456)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Database } = require("better-sqlite3");

const PORT = parseInt(process.argv[2] || "3456", 10);
const DB_PATH = path.join(__dirname, "ipvfoo.db");

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    domain    TEXT    NOT NULL,
    ip        TEXT    NOT NULL,
    version   TEXT,
    ssl       INTEGER DEFAULT 0,
    tab_url   TEXT,
    seen_at   TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(domain, ip)
  );

  CREATE TABLE IF NOT EXISTS visits (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    domain    TEXT NOT NULL,
    ip        TEXT NOT NULL,
    tab_url   TEXT,
    visited_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

const stmtUpsert = db.prepare(`
  INSERT INTO entries (domain, ip, version, ssl, tab_url, seen_at)
  VALUES (@domain, @ip, @version, @ssl, @tab_url, datetime('now','localtime'))
  ON CONFLICT(domain, ip) DO UPDATE SET
    ssl    = excluded.ssl,
    tab_url = excluded.tab_url,
    seen_at = excluded.seen_at
`);

const stmtVisit = db.prepare(`
  INSERT INTO visits (domain, ip, tab_url)
  VALUES (@domain, @ip, @tab_url)
`);

const insertMany = db.transaction((records) => {
  for (const r of records) {
    stmtUpsert.run(r);
    stmtVisit.run(r);
  }
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function send(res, status, contentType, body) {
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": buf.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(buf);
}

function sendJSON(res, status, obj) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** POST /api/collect  — called by the extension */
async function handleCollect(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { error: "invalid JSON" });
  }

  const records = Array.isArray(body) ? body : [body];
  const sanitized = [];
  for (const r of records) {
    if (!r.domain || !r.ip) continue;
    sanitized.push({
      domain:  String(r.domain).slice(0, 255),
      ip:      String(r.ip).slice(0, 64),
      version: String(r.version || "?").slice(0, 1),
      ssl:     r.ssl ? 1 : 0,
      tab_url: r.tab_url ? String(r.tab_url).slice(0, 512) : null,
    });
  }

  if (!sanitized.length) {
    return sendJSON(res, 400, { error: "no valid records" });
  }

  try {
    insertMany(sanitized);
    sendJSON(res, 200, { saved: sanitized.length });
  } catch (e) {
    console.error(e);
    sendJSON(res, 500, { error: "db error" });
  }
}

/** GET /api/entries?page=1&limit=50&search=... */
function handleEntries(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const page   = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
  const search = (url.searchParams.get("search") || "").trim();
  const offset = (page - 1) * limit;

  let where = "";
  let params = [];
  if (search) {
    where = "WHERE domain LIKE ? OR ip LIKE ?";
    params = [`%${search}%`, `%${search}%`];
  }

  const total = db.prepare(`SELECT COUNT(*) as n FROM entries ${where}`).get(...params).n;
  const rows  = db.prepare(
    `SELECT id, domain, ip, version, ssl, tab_url, seen_at
     FROM entries ${where}
     ORDER BY seen_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  sendJSON(res, 200, { total, page, limit, rows });
}

/** GET /api/visits?page=1&limit=50&search=... */
function handleVisits(req, res) {
  const url = new URL(req.url, `http://localhost`);
  const page   = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit  = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10)));
  const search = (url.searchParams.get("search") || "").trim();
  const offset = (page - 1) * limit;

  let where = "";
  let params = [];
  if (search) {
    where = "WHERE domain LIKE ? OR ip LIKE ?";
    params = [`%${search}%`, `%${search}%`];
  }

  const total = db.prepare(`SELECT COUNT(*) as n FROM visits ${where}`).get(...params).n;
  const rows  = db.prepare(
    `SELECT id, domain, ip, tab_url, visited_at
     FROM visits ${where}
     ORDER BY visited_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  sendJSON(res, 200, { total, page, limit, rows });
}

/** GET /api/stats */
function handleStats(req, res) {
  const total_entries = db.prepare("SELECT COUNT(*) as n FROM entries").get().n;
  const total_visits  = db.prepare("SELECT COUNT(*) as n FROM visits").get().n;
  const unique_ips    = db.prepare("SELECT COUNT(DISTINCT ip) as n FROM entries").get().n;
  const latest        = db.prepare("SELECT seen_at FROM entries ORDER BY seen_at DESC LIMIT 1").get();
  sendJSON(res, 200, { total_entries, total_visits, unique_ips, latest: latest?.seen_at || null });
}

/** GET / — web UI */
function handleUI(req, res) {
  send(res, 200, "text/html; charset=utf-8", WEB_UI);
}

// ---------------------------------------------------------------------------
// Minimal web UI (single-file, no external deps)
// ---------------------------------------------------------------------------
const WEB_UI = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IPvFoo Collector</title>
<style>
  :root {
    --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
    --accent: #4f8ef7; --accent2: #7c5cbf;
    --text: #e2e4ec; --muted: #7a7d8e; --green: #4caf82; --red: #e05c5c;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; min-height: 100vh; }
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 14px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; font-weight: 600; letter-spacing: .5px; }
  header h1 span { color: var(--accent); }
  .stats { display: flex; gap: 24px; margin-left: auto; }
  .stat { text-align: center; }
  .stat .val { font-size: 18px; font-weight: 700; color: var(--accent); }
  .stat .lbl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; }
  .tabs { display: flex; gap: 2px; padding: 16px 24px 0; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 18px; cursor: pointer; border-radius: 6px 6px 0 0; color: var(--muted); font-weight: 500; transition: .15s; border: 1px solid transparent; border-bottom: none; }
  .tab:hover { color: var(--text); }
  .tab.active { background: var(--surface); border-color: var(--border); color: var(--accent); }
  .panel { display: none; padding: 20px 24px; }
  .panel.active { display: block; }
  .toolbar { display: flex; gap: 10px; margin-bottom: 14px; align-items: center; flex-wrap: wrap; }
  input[type=text] { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 13px; outline: none; width: 260px; }
  input[type=text]:focus { border-color: var(--accent); }
  button { background: var(--accent); color: #fff; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: .15s; }
  button:hover { opacity: .85; }
  button.secondary { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
  .total { margin-left: auto; color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 10px; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tr:hover td { background: var(--surface); }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .v4 { background: #3a1a1a; color: #e07070; }
  .v6 { background: #1a2e1a; color: #70c070; }
  .vq { background: var(--border); color: var(--muted); }
  .ssl-yes { color: var(--green); }
  .ssl-no  { color: var(--red); }
  .domain { font-weight: 500; }
  .ip { font-family: 'Cascadia Code', 'Fira Code', monospace; color: var(--accent); }
  .time { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .url-cell { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
  .pager { display: flex; gap: 8px; align-items: center; margin-top: 14px; justify-content: center; }
  .pager button { min-width: 36px; }
  .pager .page-info { color: var(--muted); font-size: 12px; padding: 0 8px; }
  .empty { text-align: center; padding: 48px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>IPv<span>Foo</span> Collector</h1>
  <div class="stats">
    <div class="stat"><div class="val" id="s-entries">—</div><div class="lbl">уникальных пар</div></div>
    <div class="stat"><div class="val" id="s-visits">—</div><div class="lbl">всего визитов</div></div>
    <div class="stat"><div class="val" id="s-ips">—</div><div class="lbl">уникальных IP</div></div>
  </div>
</header>

<div class="tabs">
  <div class="tab active" onclick="showTab('entries')">Уникальные пары</div>
  <div class="tab" onclick="showTab('visits')">История визитов</div>
</div>

<div id="tab-entries" class="panel active">
  <div class="toolbar">
    <input type="text" id="search-entries" placeholder="Поиск по домену или IP…" oninput="debounce(() => loadEntries(1), 300)()">
    <button onclick="loadEntries(currentPageE)">↻ Обновить</button>
    <div class="total" id="total-entries"></div>
  </div>
  <table>
    <thead><tr>
      <th>Домен</th><th>IP</th><th>Ver</th><th>SSL</th><th>Последний URL</th><th>Последний визит</th>
    </tr></thead>
    <tbody id="tbody-entries"></tbody>
  </table>
  <div class="pager" id="pager-entries"></div>
</div>

<div id="tab-visits" class="panel">
  <div class="toolbar">
    <input type="text" id="search-visits" placeholder="Поиск по домену или IP…" oninput="debounce(() => loadVisits(1), 300)()">
    <button onclick="loadVisits(currentPageV)">↻ Обновить</button>
    <div class="total" id="total-visits"></div>
  </div>
  <table>
    <thead><tr>
      <th>Домен</th><th>IP</th><th>Вкладка (URL)</th><th>Время</th>
    </tr></thead>
    <tbody id="tbody-visits"></tbody>
  </table>
  <div class="pager" id="pager-visits"></div>
</div>

<script>
const BASE = "";
let currentPageE = 1, currentPageV = 1;

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t,i) => t.classList.toggle("active", i === (name==="entries"?0:1)));
  document.getElementById("tab-entries").classList.toggle("active", name==="entries");
  document.getElementById("tab-visits").classList.toggle("active", name==="visits");
}

async function loadStats() {
  const d = await fetch(BASE+"/api/stats").then(r=>r.json()).catch(()=>null);
  if (!d) return;
  document.getElementById("s-entries").textContent = d.total_entries ?? "—";
  document.getElementById("s-visits").textContent  = d.total_visits  ?? "—";
  document.getElementById("s-ips").textContent     = d.unique_ips    ?? "—";
}

function vBadge(v) {
  const cls = v==="4"?"v4":v==="6"?"v6":"vq";
  return \`<span class="badge \${cls}">IPv\${v}</span>\`;
}
function esc(s) {
  if (!s) return '<span style="color:var(--muted)">—</span>';
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

async function loadEntries(page) {
  currentPageE = page;
  const search = document.getElementById("search-entries").value.trim();
  const url = \`\${BASE}/api/entries?page=\${page}&limit=50&search=\${encodeURIComponent(search)}\`;
  const d = await fetch(url).then(r=>r.json()).catch(()=>null);
  if (!d) return;
  document.getElementById("total-entries").textContent = \`\${d.total} записей\`;
  const tb = document.getElementById("tbody-entries");
  if (!d.rows.length) { tb.innerHTML='<tr><td colspan=6 class="empty">Нет данных</td></tr>'; renderPager("entries",0,1,50); return; }
  tb.innerHTML = d.rows.map(r => \`<tr>
    <td class="domain">\${esc(r.domain)}</td>
    <td class="ip">\${esc(r.ip)}</td>
    <td>\${vBadge(r.version)}</td>
    <td>\${r.ssl ? '<span class="ssl-yes">🔒</span>' : '<span class="ssl-no">🔓</span>'}</td>
    <td class="url-cell" title="\${esc(r.tab_url)}">\${esc(r.tab_url)}</td>
    <td class="time">\${esc(r.seen_at)}</td>
  </tr>\`).join("");
  renderPager("entries", d.total, page, 50);
  loadStats();
}

async function loadVisits(page) {
  currentPageV = page;
  const search = document.getElementById("search-visits").value.trim();
  const url = \`\${BASE}/api/visits?page=\${page}&limit=50&search=\${encodeURIComponent(search)}\`;
  const d = await fetch(url).then(r=>r.json()).catch(()=>null);
  if (!d) return;
  document.getElementById("total-visits").textContent = \`\${d.total} записей\`;
  const tb = document.getElementById("tbody-visits");
  if (!d.rows.length) { tb.innerHTML='<tr><td colspan=4 class="empty">Нет данных</td></tr>'; renderPager("visits",0,1,50); return; }
  tb.innerHTML = d.rows.map(r => \`<tr>
    <td class="domain">\${esc(r.domain)}</td>
    <td class="ip">\${esc(r.ip)}</td>
    <td class="url-cell" title="\${esc(r.tab_url)}">\${esc(r.tab_url)}</td>
    <td class="time">\${esc(r.visited_at)}</td>
  </tr>\`).join("");
  renderPager("visits", d.total, page, 50);
}

function renderPager(key, total, page, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const load = key === "entries" ? loadEntries : loadVisits;
  const el = document.getElementById(\`pager-\${key}\`);
  if (pages <= 1) { el.innerHTML = ""; return; }
  let html = \`<button \${page<=1?"disabled":""} onclick="(\${load.name}||\`+\`window['load'+'\${key[0].toUpperCase()+key.slice(1)}'])(\${page-1})">&laquo;</button>\`;
  html += \`<span class="page-info">стр. \${page} / \${pages}</span>\`;
  html += \`<button \${page>=pages?"disabled":""} onclick="(\${load.name}||\`+\`window['load'+'\${key[0].toUpperCase()+key.slice(1)}'])(\${page+1})">&raquo;</button>\`;
  el.innerHTML = html;
}

let _debTimers = {};
function debounce(fn, ms) {
  return (...args) => {
    clearTimeout(_debTimers[fn]);
    _debTimers[fn] = setTimeout(() => fn(...args), ms);
  };
}

// Pager buttons need global refs
window.loadEntries = loadEntries;
window.loadVisits  = loadVisits;

loadStats();
loadEntries(1);
setInterval(loadStats, 10000);
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "OPTIONS") {
    return send(res, 204, "text/plain", "");
  }

  if (req.method === "POST" && url === "/api/collect") return handleCollect(req, res);
  if (req.method === "GET"  && url === "/api/entries") return handleEntries(req, res);
  if (req.method === "GET"  && url === "/api/visits")  return handleVisits(req, res);
  if (req.method === "GET"  && url === "/api/stats")   return handleStats(req, res);
  if (req.method === "GET"  && (url === "/" || url === "/index.html")) return handleUI(req, res);

  sendJSON(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`IPvFoo Collector running at http://127.0.0.1:${PORT}`);
  console.log(`  Web UI:   http://127.0.0.1:${PORT}/`);
  console.log(`  API:      http://127.0.0.1:${PORT}/api/collect  (POST)`);
  console.log(`  Database: ${DB_PATH}`);
});
