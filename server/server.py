#!/usr/bin/env python3
"""
IPvFoo Collector Server (Python 3, stdlib only — no pip required)
Accepts domain+IP entries from the browser extension and stores them in SQLite.
Also serves a web UI for browsing saved data.

Usage:
    python3 server.py [port]     (default port: 3456)
"""

import json
import os
import sqlite3
import sys
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 3456
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ipvfoo.db")

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def get_db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con

def init_db():
    with get_db() as con:
        con.executescript("""
            CREATE TABLE IF NOT EXISTS entries (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                domain   TEXT NOT NULL,
                ip       TEXT NOT NULL,
                version  TEXT,
                ssl      INTEGER DEFAULT 0,
                tab_url  TEXT,
                seen_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                UNIQUE(domain, ip)
            );
            CREATE TABLE IF NOT EXISTS visits (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                domain     TEXT NOT NULL,
                ip         TEXT NOT NULL,
                tab_url    TEXT,
                visited_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
            );
        """)

def db_upsert(records):
    with get_db() as con:
        for r in records:
            con.execute("""
                INSERT INTO entries (domain, ip, version, ssl, tab_url, seen_at)
                VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))
                ON CONFLICT(domain, ip) DO UPDATE SET
                    ssl     = excluded.ssl,
                    tab_url = excluded.tab_url,
                    seen_at = excluded.seen_at
            """, (r["domain"], r["ip"], r.get("version", "?"), 1 if r.get("ssl") else 0, r.get("tab_url")))
            con.execute("""
                INSERT INTO visits (domain, ip, tab_url)
                VALUES (?, ?, ?)
            """, (r["domain"], r["ip"], r.get("tab_url")))

def db_entries(page, limit, search):
    offset = (page - 1) * limit
    with get_db() as con:
        if search:
            like = f"%{search}%"
            total = con.execute(
                "SELECT COUNT(*) FROM entries WHERE domain LIKE ? OR ip LIKE ?", (like, like)
            ).fetchone()[0]
            rows = con.execute(
                "SELECT id,domain,ip,version,ssl,tab_url,seen_at FROM entries "
                "WHERE domain LIKE ? OR ip LIKE ? ORDER BY seen_at DESC LIMIT ? OFFSET ?",
                (like, like, limit, offset)
            ).fetchall()
        else:
            total = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
            rows = con.execute(
                "SELECT id,domain,ip,version,ssl,tab_url,seen_at FROM entries "
                "ORDER BY seen_at DESC LIMIT ? OFFSET ?", (limit, offset)
            ).fetchall()
    return total, [dict(r) for r in rows]

def db_visits(page, limit, search):
    offset = (page - 1) * limit
    with get_db() as con:
        if search:
            like = f"%{search}%"
            total = con.execute(
                "SELECT COUNT(*) FROM visits WHERE domain LIKE ? OR ip LIKE ?", (like, like)
            ).fetchone()[0]
            rows = con.execute(
                "SELECT id,domain,ip,tab_url,visited_at FROM visits "
                "WHERE domain LIKE ? OR ip LIKE ? ORDER BY visited_at DESC LIMIT ? OFFSET ?",
                (like, like, limit, offset)
            ).fetchall()
        else:
            total = con.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
            rows = con.execute(
                "SELECT id,domain,ip,tab_url,visited_at FROM visits "
                "ORDER BY visited_at DESC LIMIT ? OFFSET ?", (limit, offset)
            ).fetchall()
    return total, [dict(r) for r in rows]

def db_stats():
    with get_db() as con:
        total_entries = con.execute("SELECT COUNT(*) FROM entries").fetchone()[0]
        total_visits  = con.execute("SELECT COUNT(*) FROM visits").fetchone()[0]
        unique_ips    = con.execute("SELECT COUNT(DISTINCT ip) FROM entries").fetchone()[0]
        latest_row    = con.execute("SELECT seen_at FROM entries ORDER BY seen_at DESC LIMIT 1").fetchone()
    return {
        "total_entries": total_entries,
        "total_visits":  total_visits,
        "unique_ips":    unique_ips,
        "latest":        latest_row[0] if latest_row else None,
    }

# ---------------------------------------------------------------------------
# Web UI (single-file, no external deps)
# ---------------------------------------------------------------------------
WEB_UI = """<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>IPvFoo Collector</title>
<style>
  :root {
    --bg:#0f1117;--surface:#1a1d27;--border:#2a2d3a;
    --accent:#4f8ef7;--text:#e2e4ec;--muted:#7a7d8e;
    --green:#4caf82;--red:#e05c5c;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;min-height:100vh}
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:16px}
  header h1{font-size:16px;font-weight:600}
  header h1 span{color:var(--accent)}
  .stats{display:flex;gap:24px;margin-left:auto}
  .stat .val{font-size:18px;font-weight:700;color:var(--accent)}
  .stat .lbl{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
  .tabs{display:flex;gap:2px;padding:16px 24px 0;border-bottom:1px solid var(--border)}
  .tab{padding:8px 18px;cursor:pointer;border-radius:6px 6px 0 0;color:var(--muted);font-weight:500;transition:.15s;border:1px solid transparent;border-bottom:none}
  .tab:hover{color:var(--text)}
  .tab.active{background:var(--surface);border-color:var(--border);color:var(--accent)}
  .panel{display:none;padding:20px 24px}
  .panel.active{display:block}
  .toolbar{display:flex;gap:10px;margin-bottom:14px;align-items:center;flex-wrap:wrap}
  input[type=text]{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px;outline:none;width:260px}
  input[type=text]:focus{border-color:var(--accent)}
  button{background:var(--accent);color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;transition:.15s}
  button:hover{opacity:.85}
  .total{margin-left:auto;color:var(--muted);font-size:12px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:8px 10px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);white-space:nowrap}
  td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:hover td{background:var(--surface)}
  .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600}
  .v4{background:#3a1a1a;color:#e07070}
  .v6{background:#1a2e1a;color:#70c070}
  .vq{background:var(--border);color:var(--muted)}
  .ip{font-family:'Cascadia Code','Fira Code',monospace;color:var(--accent)}
  .domain{font-weight:500}
  .time{color:var(--muted);font-size:11px;white-space:nowrap}
  .url-cell{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted);font-size:11px}
  .pager{display:flex;gap:8px;align-items:center;margin-top:14px;justify-content:center}
  .pager button{min-width:36px}
  .pager .page-info{color:var(--muted);font-size:12px;padding:0 8px}
  .empty{text-align:center;padding:48px;color:var(--muted)}
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
    <input type="text" id="search-entries" placeholder="Поиск по домену или IP…" oninput="debounce(()=>loadEntries(1),300)()">
    <button onclick="loadEntries(currentPageE)">↻ Обновить</button>
    <div class="total" id="total-entries"></div>
  </div>
  <table>
    <thead><tr><th>Домен</th><th>IP</th><th>Ver</th><th>SSL</th><th>Последний URL</th><th>Последний визит</th></tr></thead>
    <tbody id="tbody-entries"></tbody>
  </table>
  <div class="pager" id="pager-entries"></div>
</div>
<div id="tab-visits" class="panel">
  <div class="toolbar">
    <input type="text" id="search-visits" placeholder="Поиск по домену или IP…" oninput="debounce(()=>loadVisits(1),300)()">
    <button onclick="loadVisits(currentPageV)">↻ Обновить</button>
    <div class="total" id="total-visits"></div>
  </div>
  <table>
    <thead><tr><th>Домен</th><th>IP</th><th>Вкладка (URL)</th><th>Время</th></tr></thead>
    <tbody id="tbody-visits"></tbody>
  </table>
  <div class="pager" id="pager-visits"></div>
</div>
<script>
let currentPageE=1,currentPageV=1;
function showTab(n){
  document.querySelectorAll(".tab").forEach((t,i)=>t.classList.toggle("active",i===(n==="entries"?0:1)));
  document.getElementById("tab-entries").classList.toggle("active",n==="entries");
  document.getElementById("tab-visits").classList.toggle("active",n==="visits");
}
async function loadStats(){
  const d=await fetch("/api/stats").then(r=>r.json()).catch(()=>null);
  if(!d)return;
  document.getElementById("s-entries").textContent=d.total_entries??"—";
  document.getElementById("s-visits").textContent=d.total_visits??"—";
  document.getElementById("s-ips").textContent=d.unique_ips??"—";
}
function vBadge(v){const c=v==="4"?"v4":v==="6"?"v6":"vq";return`<span class="badge ${c}">IPv${v}</span>`;}
function esc(s){if(!s)return'<span style="color:var(--muted)">—</span>';return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}
async function loadEntries(page){
  currentPageE=page;
  const search=document.getElementById("search-entries").value.trim();
  const d=await fetch(`/api/entries?page=${page}&limit=50&search=${encodeURIComponent(search)}`).then(r=>r.json()).catch(()=>null);
  if(!d)return;
  document.getElementById("total-entries").textContent=`${d.total} записей`;
  const tb=document.getElementById("tbody-entries");
  if(!d.rows.length){tb.innerHTML='<tr><td colspan=6 class="empty">Нет данных</td></tr>';renderPager("entries",0,1,50);return;}
  tb.innerHTML=d.rows.map(r=>`<tr>
    <td class="domain">${esc(r.domain)}</td>
    <td class="ip">${esc(r.ip)}</td>
    <td>${vBadge(r.version)}</td>
    <td>${r.ssl?'<span style="color:var(--green)">🔒</span>':'<span style="color:var(--red)">🔓</span>'}</td>
    <td class="url-cell" title="${esc(r.tab_url)}">${esc(r.tab_url)}</td>
    <td class="time">${esc(r.seen_at)}</td>
  </tr>`).join("");
  renderPager("entries",d.total,page,50);
  loadStats();
}
async function loadVisits(page){
  currentPageV=page;
  const search=document.getElementById("search-visits").value.trim();
  const d=await fetch(`/api/visits?page=${page}&limit=50&search=${encodeURIComponent(search)}`).then(r=>r.json()).catch(()=>null);
  if(!d)return;
  document.getElementById("total-visits").textContent=`${d.total} записей`;
  const tb=document.getElementById("tbody-visits");
  if(!d.rows.length){tb.innerHTML='<tr><td colspan=4 class="empty">Нет данных</td></tr>';renderPager("visits",0,1,50);return;}
  tb.innerHTML=d.rows.map(r=>`<tr>
    <td class="domain">${esc(r.domain)}</td>
    <td class="ip">${esc(r.ip)}</td>
    <td class="url-cell" title="${esc(r.tab_url)}">${esc(r.tab_url)}</td>
    <td class="time">${esc(r.visited_at)}</td>
  </tr>`).join("");
  renderPager("visits",d.total,page,50);
}
function renderPager(key,total,page,limit){
  const pages=Math.max(1,Math.ceil(total/limit));
  const el=document.getElementById(`pager-${key}`);
  if(pages<=1){el.innerHTML="";return;}
  const fn=key==="entries"?"loadEntries":"loadVisits";
  el.innerHTML=
    `<button ${page<=1?"disabled":""} onclick="${fn}(${page-1})">&laquo;</button>`+
    `<span class="page-info">стр. ${page} / ${pages}</span>`+
    `<button ${page>=pages?"disabled":""} onclick="${fn}(${page+1})">&raquo;</button>`;
}
let _dt={};
function debounce(fn,ms){return(...a)=>{clearTimeout(_dt[fn]);_dt[fn]=setTimeout(()=>fn(...a),ms);};}
window.loadEntries=loadEntries;
window.loadVisits=loadVisits;
loadStats();
loadEntries(1);
setInterval(loadStats,10000);
</script>
</body>
</html>"""

# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def send_html(self, html):
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        def qint(key, default, mn=1, mx=200):
            try:
                return max(mn, min(mx, int(qs.get(key, [str(default)])[0])))
            except ValueError:
                return default

        def qstr(key):
            return qs.get(key, [""])[0].strip()

        if path in ("/", "/index.html"):
            self.send_html(WEB_UI)

        elif path == "/api/stats":
            self.send_json(200, db_stats())

        elif path == "/api/entries":
            page   = qint("page", 1)
            limit  = qint("limit", 50, 1, 200)
            search = qstr("search")
            total, rows = db_entries(page, limit, search)
            self.send_json(200, {"total": total, "page": page, "limit": limit, "rows": rows})

        elif path == "/api/visits":
            page   = qint("page", 1)
            limit  = qint("limit", 50, 1, 200)
            search = qstr("search")
            total, rows = db_visits(page, limit, search)
            self.send_json(200, {"total": total, "page": page, "limit": limit, "rows": rows})

        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/collect":
            self.send_json(404, {"error": "not found"})
            return

        try:
            body = json.loads(self.read_body())
        except Exception:
            self.send_json(400, {"error": "invalid JSON"})
            return

        records = body if isinstance(body, list) else [body]
        sanitized = []
        for r in records:
            if not isinstance(r, dict):
                continue
            domain = str(r.get("domain", "")).strip()[:255]
            ip     = str(r.get("ip", "")).strip()[:64]
            if not domain or not ip:
                continue
            sanitized.append({
                "domain":  domain,
                "ip":      ip,
                "version": str(r.get("version", "?"))[:1],
                "ssl":     bool(r.get("ssl")),
                "tab_url": str(r.get("tab_url", ""))[:512] or None,
            })

        if not sanitized:
            self.send_json(400, {"error": "no valid records"})
            return

        try:
            db_upsert(sanitized)
            self.send_json(200, {"saved": len(sanitized)})
        except Exception as e:
            print(f"DB error: {e}")
            self.send_json(500, {"error": "db error"})


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    init_db()
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"IPvFoo Collector (Python) running at http://127.0.0.1:{PORT}")
    print(f"  Web UI:   http://127.0.0.1:{PORT}/")
    print(f"  API:      http://127.0.0.1:{PORT}/api/collect  (POST)")
    print(f"  Database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
