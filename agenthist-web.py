#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
agenthist-web —— claude code / codex / pi 历史会话浏览器（本地 Web 版）

启动:  agenthist-web.py [--port 8377]
浏览器: http://localhost:8377

功能:
  - 侧栏列出全部历史会话（按 agent 过滤、按标题/项目过滤）
  - 点开会话看完整对话（工具调用折叠显示）
  - 全文搜索所有会话
  - 一键在终端中恢复会话（自动探测 gnome-terminal 等）
  - 导出 Markdown

零依赖（仅 Python 标准库）。
"""
import sys, os, json, glob, time, re, argparse, shutil, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

HOME = os.path.expanduser("~")
AGENTS = ("claude", "codex", "pi")

# ================================================================ 解析器（与 agenthist CLI 同源）
INJECT_PREFIXES = (
    "<skills_instructions", "<user_instructions", "<environment_context",
    "<turn_context", "# AGENTS.md instructions", "<ENVIRONMENT",
    "# GitHub MCP preference", "<permissions", "<app_context",
)

def _first_text(s, n=90):
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n] + ("…" if len(s) > n else "")

class Msg:
    __slots__ = ("ts", "role", "text", "tool", "sidechain")
    def __init__(self, ts, role, text="", tool="", sidechain=False):
        self.ts, self.role, self.text, self.tool = ts, role, text, tool
        self.sidechain = sidechain

class Session:
    __slots__ = ("agent", "id", "path", "cwd", "start", "end", "title",
                 "n_user", "n_asst", "size")
    def __init__(self):
        self.agent = self.path = self.id = self.cwd = self.title = ""
        self.start = self.end = ""
        self.n_user = self.n_asst = self.size = 0

def parse_claude(path):
    ses, msgs = Session(), []
    ses.agent, ses.path = "claude", path
    ses.id = os.path.basename(path)[:-6]
    try:
        f = open(path, encoding="utf-8")
    except OSError:
        return ses, msgs
    with f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = o.get("type")
            if t == "summary":
                ses.title = ses.title or o.get("summary", "")
                continue
            if t not in ("user", "assistant"):
                continue
            if not ses.cwd:
                ses.cwd = o.get("cwd", "")
            ts = o.get("timestamp", "")
            side = bool(o.get("isSidechain"))
            m = o.get("message") or {}
            content = m.get("content")
            texts, tools = [], []
            if isinstance(content, str):
                texts.append(content)
            elif isinstance(content, list):
                for b in content:
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        texts.append(b.get("text", ""))
                    elif bt == "tool_use":
                        inp = b.get("input") or {}
                        hint = inp.get("command") or inp.get("file_path") \
                            or inp.get("pattern") or inp.get("url") or ""
                        tools.append(f"{b.get('name','?')}({_first_text(str(hint),70)})")
            if t == "user" and texts and texts[0].startswith("<command-name>"):
                continue
            body = "\n".join(x for x in texts if x).strip()
            if t == "user":
                ses.n_user += 1
                if body and not ses.title:
                    ses.title = _first_text(body, 80)
            else:
                ses.n_asst += 1
            if body or tools:
                msgs.append(Msg(ts, "user" if t == "user" else "assistant",
                                body, " ".join(tools), side))
            if ts:
                ses.end = ts
    if msgs:
        ses.start = ses.start or msgs[0].ts
    ses.start = ses.start or ses.end
    ses.size = os.path.getsize(path) if os.path.exists(path) else 0
    return ses, msgs

def parse_codex(path):
    ses, msgs = Session(), []
    ses.agent, ses.path = "codex", path
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return ses, msgs
    with f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = o.get("type")
            ts = o.get("timestamp", "")
            if t == "session_meta":
                p = o.get("payload") or {}
                ses.id = p.get("id") or ses.id
                ses.cwd = p.get("cwd") or ses.cwd
                ses.start = p.get("timestamp") or ts
                continue
            if t != "response_item":
                continue
            p = o.get("payload") or {}
            if p.get("type") == "function_call":
                msgs.append(Msg(ts, "assistant", "",
                                f"{p.get('name','?')}({_first_text(str(p.get('arguments','')),70)})"))
                continue
            if p.get("type") != "message":
                continue
            role = p.get("role")
            if role not in ("user", "assistant"):
                continue
            texts = [ci.get("text", "") for ci in (p.get("content") or [])
                     if isinstance(ci, dict)]
            body = "\n".join(x for x in texts if x).strip()
            if role == "user":
                if not body or body.startswith(INJECT_PREFIXES):
                    continue
                ses.n_user += 1
                if not ses.title:
                    ses.title = _first_text(body, 80)
            else:
                ses.n_asst += 1
            if body:
                msgs.append(Msg(ts, role, body))
            if ts:
                ses.end = ts
    ses.id = ses.id or os.path.basename(path)
    ses.size = os.path.getsize(path) if os.path.exists(path) else 0
    return ses, msgs

def _iso(ts):
    if ts is None:
        return ""
    if isinstance(ts, str):
        return ts
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(int(ts) / 1000)) + "Z"
    except Exception:
        return ""

def parse_pi(path):
    ses, msgs = Session(), []
    ses.agent, ses.path = "pi", path
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return ses, msgs
    with f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("type") == "session":
                ses.id = o.get("id") or ses.id
                ses.cwd = o.get("cwd") or ses.cwd
                ses.start = _iso(o.get("timestamp")) or ses.start
                continue
            if o.get("type") != "message":
                continue
            m = o.get("message") or {}
            role = m.get("role")
            texts, tools = [], []
            for b in (m.get("content") or []):
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text":
                    texts.append(b.get("text", ""))
                elif b.get("type") == "toolCall":
                    args = b.get("arguments") or {}
                    hint = args.get("command") or args.get("path") or args.get("pattern") or ""
                    tools.append(f"{b.get('name','?')}({_first_text(str(hint),70)})")
            body = "\n".join(x for x in texts if x).strip()
            if role == "user":
                ses.n_user += 1
                if body and not ses.title:
                    ses.title = _first_text(body, 80)
            elif role == "assistant":
                ses.n_asst += 1
            elif role == "toolResult":
                continue
            if body or tools:
                msgs.append(Msg(_iso(o.get("timestamp")), role or "?", body, " ".join(tools)))
    ses.end = msgs[-1].ts if msgs else ses.start
    ses.size = os.path.getsize(path) if os.path.exists(path) else 0
    return ses, msgs

PARSERS = {"claude": parse_claude, "codex": parse_codex, "pi": parse_pi}

# codex 会话命名索引 ~/.codex/session_index.jsonl: id -> 最近 thread_name
_codex_names = {}
_idx = f"{HOME}/.codex/session_index.jsonl"
if os.path.exists(_idx):
    try:
        with open(_idx, encoding="utf-8") as f:
            for line in f:
                try:
                    o = json.loads(line)
                    if o.get("id") and o.get("thread_name"):
                        _codex_names[o["id"]] = o["thread_name"]
                except Exception:
                    continue
    except OSError:
        pass

_cache = {}  # path -> (mtime, size, ses, msgs)

def parse_cached(path):
    st = os.stat(path)
    key = (st.st_mtime, st.st_size)
    hit = _cache.get(path)
    if hit and hit[0] == key:
        return hit[1], hit[2]
    agent = None
    if "/.claude/projects/" in path:
        agent = "claude"
    elif "/.codex/sessions/" in path:
        agent = "codex"
    elif "/.pi/agent/sessions/" in path:
        agent = "pi"
    if not agent:
        return None, []
    ses, msgs = PARSERS[agent](path)
    if agent == "codex" and not ses.title:
        ses.title = _codex_names.get(ses.id, "")
    _cache[path] = (key, ses, msgs)
    return ses, msgs

def load_all():
    out = []
    for p in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl"):
        out.append(parse_cached(p))
    for p in glob.glob(f"{HOME}/.codex/sessions/**/*.jsonl", recursive=True):
        out.append(parse_cached(p))
    for p in glob.glob(f"{HOME}/.pi/agent/sessions/*/*.jsonl"):
        out.append(parse_cached(p))
    out = [x for x in out if x[0] is not None]
    out.sort(key=lambda sm: sm[0].end or "", reverse=True)
    return out

def find_session(prefix, agent=None):
    for ses, msgs in load_all():
        if ses.id.startswith(prefix) and (agent is None or ses.agent == agent):
            return ses, msgs
    return None, None

def ses_dict(ses):
    return {
        "agent": ses.agent, "id": ses.id, "cwd": ses.cwd,
        "title": ses.title or "(空会话)", "start": ses.start, "end": ses.end,
        "n": ses.n_user + ses.n_asst, "size": ses.size,
        "cmd": resume_cmd(ses),
    }

def msg_list(msgs):
    return [{"ts": m.ts, "role": m.role, "text": m.text, "tool": m.tool,
             "sidechain": m.sidechain} for m in msgs]

def fmt_dur(ses):
    try:
        a = time.mktime(time.strptime(ses.start[:19], "%Y-%m-%dT%H:%M:%S"))
        b = time.mktime(time.strptime(ses.end[:19], "%Y-%m-%dT%H:%M:%S"))
        d = int(b - a)
        return f"{d//3600}h{d%3600//60:02d}m" if d >= 3600 else f"{d//60}m{d%60:02d}s"
    except Exception:
        return "?"

def resume_cmd(ses):
    if ses.agent == "claude":
        cmd = f"claude --resume {ses.id}"
        return f"cd {json.dumps(ses.cwd)} && {cmd}" if ses.cwd else cmd
    if ses.agent == "codex":
        return f"codex resume {ses.id}"
    return f"pi --session {json.dumps(ses.path)}"

def open_in_terminal(ses):
    """在用户的默认终端里开一个窗口执行恢复命令。"""
    cwd = ses.cwd if os.path.isdir(ses.cwd or "") else HOME
    inner = f"cd {json.dumps(cwd)} && {resume_cmd(ses)}"
    for term, fmt in (("gnome-terminal", ["gnome-terminal", "--", "bash", "-lc", inner]),
                      ("konsole", ["konsole", "-e", "bash", "-lc", inner]),
                      ("xfce4-terminal", ["xfce4-terminal", "-e", f'bash -lc {json.dumps(inner)}']),
                      ("xterm", ["xterm", "-e", "bash", "-lc", inner])):
        if shutil.which(term):
            subprocess.Popen(fmt, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return term
    return None

def export_md(ses, msgs):
    def loc(ts):
        return (ts or "")[:16].replace("T", " ")
    lines = [f"# {ses.title or ses.id}", "",
             f"- agent: **{ses.agent}**  id: `{ses.id}`",
             f"- cwd: `{ses.cwd}`  时长: {fmt_dur(ses)}  来源: `{ses.path}`", ""]
    for m in msgs:
        who = "🧑 用户" if m.role == "user" else "🤖 助手"
        lines.append(f"## {who}  ({loc(m.ts)})")
        if m.text:
            lines.append(m.text)
        if m.tool:
            lines.append(f"> 工具: `{m.tool}`")
        lines.append("")
    return "\n".join(lines)

# ================================================================ HTTP
class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _html(self, html):
        data = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        g = lambda k, d="": (q.get(k, [d])[0])
        if u.path == "/":
            return self._html(PAGE)
        if u.path == "/api/sessions":
            agents = g("agents", "claude,codex,pi").split(",")
            kw = g("q").lower()
            out = []
            for ses, _ in load_all():
                if ses.agent not in agents:
                    continue
                if kw and kw not in (ses.title or "").lower() \
                        and kw not in (ses.cwd or "").lower():
                    continue
                out.append(ses_dict(ses))
            return self._json({"sessions": out})
        if u.path == "/api/session":
            ses, msgs = find_session(g("id"), g("agent") or None)
            if not ses:
                return self._json({"error": "not found"}, 404)
            d = ses_dict(ses)
            d["dur"] = fmt_dur(ses)
            d["messages"] = msg_list(msgs)
            return self._json(d)
        if u.path == "/api/search":
            kw = g("q").lower()
            agents = set(g("agents", "claude,codex,pi").split(","))
            hits = []
            for ses, msgs in load_all():
                if ses.agent not in agents:
                    continue
                sm = []
                for m in msgs:
                    hay = (m.text + "\n" + m.tool).lower()
                    pos = hay.find(kw)
                    if pos >= 0:
                        src = m.text or m.tool
                        start = max(0, pos - 50)
                        frag = src[start:pos + len(kw) + 80].replace("\n", " ")
                        sm.append({"ts": m.ts, "role": m.role, "frag": frag})
                if sm:
                    d = ses_dict(ses)
                    d["hits"] = sm[:8]
                    d["hit_total"] = len(sm)
                    hits.append(d)
                if len(hits) >= 60:
                    break
            return self._json({"hits": hits})
        if u.path == "/api/export":
            ses, msgs = find_session(g("id"), g("agent") or None)
            if not ses:
                return self._json({"error": "not found"}, 404)
            md = export_md(ses, msgs)
            fname = re.sub(r"[^\w.-]", "_", ses.title or ses.id)[:40]
            fname = fname.encode("ascii", "ignore").decode() or ses.id[:8]
            data = md.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition",
                             f'attachment; filename="{ses.agent}-{fname}.md"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self.send_response(404); self.end_headers()

    def do_POST(self):
        if urlparse(self.path).path != "/api/resume":
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        ses, _ = find_session(body.get("id", ""), body.get("agent"))
        if not ses:
            return self._json({"error": "not found"}, 404)
        term = open_in_terminal(ses)
        return self._json({"cmd": resume_cmd(ses), "terminal": term})

# ================================================================ 前端页面
PAGE = r"""<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agenthist · 会话历史</title>
<style>
:root{
  --bg:#16181d; --bg2:#1d2026; --bg3:#242830; --line:#2e3340;
  --fg:#dde1e8; --fg2:#8b93a3; --fg3:#5c6474;
  --acc:#4f8cff; --user:#3fb27f; --warn:#e0a53f;
  --claude:#d97757; --codex:#6f8f6a; --pi:#8f7fd9;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:14px/1.6 "HarmonyOS Sans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;height:100vh;display:flex;overflow:hidden}
/* ---- 侧栏 ---- */
#side{width:380px;min-width:280px;border-right:1px solid var(--line);display:flex;flex-direction:column;background:var(--bg2)}
#topbar{padding:10px 12px 6px}
h1{font-size:15px;font-weight:600;letter-spacing:.5px;display:flex;align-items:center;gap:8px;margin-bottom:10px}
h1 .dot{width:8px;height:8px;border-radius:50%;background:var(--acc);box-shadow:0 0 8px var(--acc)}
#filters{display:flex;gap:6px;margin-bottom:8px}
.chip{padding:3px 12px;border-radius:14px;border:1px solid var(--line);background:transparent;color:var(--fg2);cursor:pointer;font-size:12px;user-select:none}
.chip.on{color:#fff;border-color:transparent}
.chip.on.a-claude{background:var(--claude)} .chip.on.a-codex{background:var(--codex)} .chip.on.a-pi{background:var(--pi)}
#search{width:100%;padding:7px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg3);color:var(--fg);outline:none;font-size:13px}
#search:focus{border-color:var(--acc)}
#count{font-size:11px;color:var(--fg3);padding:6px 12px 2px}
#list{flex:1;overflow-y:auto;padding:4px 8px 12px}
.item{padding:9px 10px;border-radius:8px;cursor:pointer;margin:2px 0;border:1px solid transparent}
.item:hover{background:var(--bg3)}
.item.sel{background:var(--bg3);border-color:var(--line)}
.item .t{font-size:13px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.item .m{font-size:11px;color:var(--fg3);margin-top:2px;display:flex;gap:8px;align-items:center}
.tag{font-size:10px;padding:1px 7px;border-radius:8px;color:#fff;flex-shrink:0}
.tag.claude{background:var(--claude)} .tag.codex{background:var(--codex)} .tag.pi{background:var(--pi)}
.item .cwd{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
/* ---- 主区 ---- */
#main{flex:1;display:flex;flex-direction:column;background:var(--bg)}
#head{padding:12px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;min-height:58px}
#head .info{flex:1;min-width:0}
#head .title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#head .meta{font-size:11px;color:var(--fg3);margin-top:2px}
button.act{padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg3);color:var(--fg);cursor:pointer;font-size:12px}
button.act:hover{border-color:var(--acc);color:#fff}
button.act.primary{background:var(--acc);border-color:var(--acc);color:#fff}
#msgs{flex:1;overflow-y:auto;padding:20px 0 60px}
.wrap{max-width:900px;margin:0 auto;padding:0 24px}
.day{text-align:center;color:var(--fg3);font-size:11px;margin:18px 0 10px}
.bubble{margin:10px 0;border-radius:10px;padding:12px 16px;white-space:pre-wrap;word-break:break-word}
.bubble.user{background:rgba(63,178,127,.12);border-left:3px solid var(--user)}
.bubble.assistant{background:var(--bg2);border-left:3px solid var(--fg3)}
.bubble .who{font-size:11px;color:var(--fg3);margin-bottom:6px;display:flex;gap:8px}
.bubble .who b{color:var(--fg2)}
.tool{margin:4px 0 4px 0;font-family:"JetBrains Mono",Consolas,monospace;font-size:12px;color:var(--fg2);background:var(--bg3);border-radius:6px;padding:5px 10px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidechain{opacity:.55;font-style:italic}
#empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--fg3);gap:10px}
#empty .big{font-size:40px}
kbd{background:var(--bg3);border:1px solid var(--line);border-radius:4px;padding:1px 6px;font-size:11px}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg3);border:1px solid var(--line);padding:8px 18px;border-radius:8px;font-size:13px;opacity:0;transition:.25s;pointer-events:none;z-index:9}
#toast.show{opacity:1}
/* 搜索结果 */
.sr{padding:10px 12px;border-radius:8px;cursor:pointer;margin:4px 0;background:var(--bg2)}
.sr:hover{background:var(--bg3)}
.sr .st{font-size:13px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr .sf{font-size:12px;color:var(--warn);font-family:Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sr .sm{font-size:11px;color:var(--fg3);margin-top:3px}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
::-webkit-scrollbar-track{background:transparent}
</style></head><body>

<div id="side">
  <div id="topbar">
    <h1><span class="dot"></span>agenthist 会话历史</h1>
    <div id="filters">
      <span class="chip a-claude on" data-a="claude">Claude</span>
      <span class="chip a-codex on" data-a="codex">Codex</span>
      <span class="chip a-pi on" data-a="pi">Pi</span>
      <span style="flex:1"></span>
      <span class="chip" id="reload" title="重新扫描">⟳ 刷新</span>
    </div>
    <input id="search" placeholder="🔍 过滤标题/项目，或回车全文搜索…">
  </div>
  <div id="count"></div>
  <div id="list"></div>
</div>

<div id="main">
  <div id="head" style="display:none">
    <div class="info"><div class="title" id="h-title"></div><div class="meta" id="h-meta"></div></div>
    <button class="act primary" id="btn-resume">🚀 终端恢复</button>
    <button class="act" id="btn-copy">📋 复制命令</button>
    <button class="act" id="btn-export">⬇ 导出 MD</button>
  </div>
  <div id="empty"><div class="big">🗂</div><div>左侧选择一个会话，或输入关键词回车全文搜索</div>
    <div style="font-size:12px">恢复命令也可在终端用 <kbd>agenthist resume &lt;ID前缀&gt; --exec</kbd></div></div>
  <div id="msgs"><div class="wrap" id="msgwrap"></div></div>
</div>
<div id="toast"></div>

<script>
let agents = new Set(["claude","codex","pi"]);
let sessions = [], cur = null, timer = null;
const $ = s => document.querySelector(s);
const list = $("#list"), msgs = $("#msgs"), msgwrap = $("#msgwrap");
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const shortCwd = c => (c||"").replace(/^\/home\/[^/]+/,"~");
const loc = ts => (ts||"").slice(5,16).replace("T"," ");

function toast(s){const t=$("#toast");t.textContent=s;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1800)}

async function loadList(){
  const q = $("#search").value.trim();
  const isSearch = q.length >= 2;
  const url = isSearch ? "/api/search?q="+encodeURIComponent(q)+"&agents="+[...agents]
                       : "/api/sessions?q=&agents="+[...agents];
  const r = await fetch(url); const d = await r.json();
  list.innerHTML = ""; $("#head").style.display = cur ? "flex" : "none";
  if(isSearch){
    $("#count").textContent = `全文搜索 “${q}”：${d.hits.length} 个会话命中`;
    for(const s of d.hits){
      const el = document.createElement("div"); el.className="item";
      el.innerHTML = `<div class="t">${esc(s.title)}</div>`+
        s.hits.map(h=>`<div class="sf">…${esc(h.frag)}…</div>`).join("")+
        `<div class="m"><span class="tag ${s.agent}">${s.agent}</span>`+
        `<span class="cwd">${esc(shortCwd(s.cwd))}</span><span>${loc(s.end)}</span><span>${s.hit_total} 处</span></div>`;
      el.onclick = ()=>openSession(s);
      list.appendChild(el);
    }
    return;
  }
  sessions = d.sessions;
  $("#count").textContent = `共 ${sessions.length} 个会话`;
  for(const s of sessions){
    const el = document.createElement("div");
    el.className = "item" + (cur && cur.id===s.id && cur.agent===s.agent ? " sel":"");
    el.innerHTML = `<div class="t">${esc(s.title)}</div>
      <div class="m"><span class="tag ${s.agent}">${s.agent}</span>
      <span class="cwd" title="${esc(s.cwd)}">${esc(shortCwd(s.cwd))}</span>
      <span>${loc(s.end)}</span><span>${s.n}条</span></div>`;
    el.onclick = ()=>openSession(s);
    list.appendChild(el);
  }
}

async function openSession(s){
  cur = s;
  document.querySelectorAll(".item.sel").forEach(e=>e.classList.remove("sel"));
  event && event.currentTarget && event.currentTarget.classList.add("sel");
  const r = await fetch(`/api/session?id=${encodeURIComponent(s.id)}&agent=${s.agent}`);
  const d = await r.json();
  if(d.error){ toast("加载失败"); return; }
  $("#head").style.display = "flex";
  $("#h-title").textContent = d.title;
  $("#h-meta").textContent = `${d.agent} · ${shortCwd(d.cwd)} · ${d.dur} · ${d.messages.length} 条 · ${d.id.slice(0,8)}`;
  let html = "", day = "";
  for(const m of d.messages){
    const dy = (m.ts||"").slice(0,10);
    if(dy && dy!==day){ html += `<div class="day">${dy}</div>`; day=dy; }
    const who = m.role==="user" ? "<b>🧑 用户</b>" : "<b>🤖 助手</b>";
    html += `<div class="bubble ${m.role} ${m.sidechain?"sidechain":""}">
      <div class="who">${who}<span>${loc(m.ts)}</span>${m.sidechain?"<span>sidechain</span>":""}</div>`;
    if(m.text) html += esc(m.text);
    if(m.tool) html += `<div class="tool" title="${esc(m.tool)}">⚙ ${esc(m.tool)}</div>`;
    html += `</div>`;
  }
  msgwrap.innerHTML = html;
  msgs.scrollTop = 0;
}

$("#btn-resume").onclick = async ()=>{
  if(!cur) return;
  const r = await fetch("/api/resume",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({id:cur.id,agent:cur.agent})});
  const d = await r.json();
  toast(d.terminal ? `已在 ${d.terminal} 中启动恢复` : `无可用终端。命令已复制：${d.cmd}`);
  if(!d.terminal) navigator.clipboard.writeText(d.cmd).catch(()=>{});
};
$("#btn-copy").onclick = ()=>{
  if(!cur) return;
  navigator.clipboard.writeText(cur.cmd).then(()=>toast("已复制: "+cur.cmd)).catch(()=>toast(cur.cmd));
};
$("#btn-export").onclick = ()=>{
  if(!cur) return;
  location.href = `/api/export?id=${encodeURIComponent(cur.id)}&agent=${cur.agent}`;
};
document.querySelectorAll(".chip[data-a]").forEach(ch=>{
  ch.onclick = ()=>{ const a=ch.dataset.a;
    if(agents.has(a)&&agents.size>1){agents.delete(a);ch.classList.remove("on");}
    else{agents.add(a);ch.classList.add("on");}
    cur=null;$("#head").style.display="none";msgwrap.innerHTML="";
    $("#empty").style.display="flex"; loadList(); };
});
$("#reload").onclick = ()=>{ cur=null; msgwrap.innerHTML=""; $("#empty").style.display="flex";
  $("#head").style.display="none"; loadList(); toast("已重新扫描"); };
$("#search").addEventListener("input",()=>{clearTimeout(timer);timer=setTimeout(loadList,250)});
$("#search").addEventListener("keydown",e=>{if(e.key==="Enter")loadList()});
loadList();
</script></body></html>"""

# ================================================================ main
def main():
    ap = argparse.ArgumentParser(description="agenthist web UI")
    ap.add_argument("--port", type=int, default=8377)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"agenthist-web 已启动 → {url}  (Ctrl+C 停止)")
    try:
        import webbrowser
        webbrowser.open(url)
    except Exception:
        pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")

if __name__ == "__main__":
    main()
