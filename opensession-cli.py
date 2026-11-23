#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
opensession —— 统一查看 / 搜索 / 恢复 claude code / codex / pi 三个 CLI 的历史会话

支持的会话存储（2026-11 实测格式）:
  claude  ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
          行: {type:"user"|"assistant"|"summary"|"attachment"|..., message:{role,content:[blocks]}, cwd, sessionId, timestamp}
  codex   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
          行: {type:"session_meta"|"response_item"|"event_msg"|..., payload:{...}}
          response_item.payload = {type:"message", role, content:[{type:"input_text"|"output_text", text}]}
  pi      ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<id>.jsonl
          行: {type:"session"| "message"|...}, message.message = {role, content:[{type:"text"|"toolCall"}]}

命令:
  list    [--agent claude|codex|pi] [--cwd STR] [--limit N]     列出会话（默认命令）
  show    <ID前缀> [--full] [--tail N] [--raw]                  看一场对话
  search  <关键词> [--agent ...] [--limit N]                    全文搜索所有会话
  export  <ID前缀> [-o FILE] [--format md|txt]                  导出 Markdown/纯文本
  resume  <ID前缀> [--fork] [--exec]                            打印(或执行)恢复命令
  tui                                                   交互式选择器 ↑↓ 选择 Enter 恢复

零依赖，Python 3.8+。
"""
import sys, os, json, glob, time, argparse, re

HOME = os.path.expanduser("~")
AGENTS = ("claude", "codex", "pi")
CLR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

def c(code, s):
    return f"\033[{code}m{s}\033[0m" if CLR else s

# ---------------------------------------------------------------- 通用结构
class Msg:
    __slots__ = ("ts", "role", "text", "tool", "sidechain")
    def __init__(self, ts, role, text="", tool="", sidechain=False):
        self.ts, self.role, self.text, self.tool = ts, role, text, tool
        self.sidechain = sidechain

class Session:
    __slots__ = ("agent", "id", "path", "cwd", "start", "end", "title",
                 "n_user", "n_asst", "size")
    def __init__(self):
        self.agent, self.path = "", ""
        self.id, self.cwd, self.title = "", "", ""
        self.start, self.end = "", ""
        self.n_user, self.n_asst, self.size = 0, 0, 0
    def __repr__(self):
        return f"<{self.agent} {self.id[:8]} {self.title[:40]!r}>"

# ---------------------------------------------------------------- 解析器
INJECT_PREFIXES = (  # codex 注入型 user 消息，非真人输入
    "<skills_instructions", "<user_instructions", "<environment_context",
    "<turn_context", "# AGENTS.md instructions", "<ENVIRONMENT",
    "# GitHub MCP preference", "<permissions", "<app_context",
)

def _first_text(s, n=90):
    s = re.sub(r"\s+", " ", s).strip()
    return s[:n] + ("…" if len(s) > n else "")

def parse_claude(path):
    ses, msgs = Session(), []
    ses.agent, ses.path = "claude", path
    ses.id = os.path.basename(path)[:-6]  # 去 .jsonl
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
                        tools.append(f"{b.get('name','?')}({_first_text(str(hint),60)})")
                    elif bt == "tool_result":
                        tools.append("tool_result")
            if t == "user" and texts and texts[0].startswith("<command-name>"):
                continue  # 斜杠命令展开，跳过
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
    if not ses.start and msgs:
        ses.start = msgs[0].ts
    ses.start = ses.start or ses.end
    ses.size = os.path.getsize(path) if os.path.exists(path) else 0
    return ses, msgs

def parse_codex(path):
    ses, msgs = Session(), []
    ses.agent, ses.path = "codex", path
    with open(path, encoding="utf-8", errors="replace") as f:
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
            if p.get("type") != "message":
                pt = p.get("type")
                if pt == "function_call":
                    msgs.append(Msg(ts, "assistant", "",
                                    f"{p.get('name','?')}({_first_text(str(p.get('arguments','')),60)})"))
                continue
            role = p.get("role")
            if role not in ("user", "assistant"):
                continue  # developer/system 注入全部跳过
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

def parse_pi(path):
    ses, msgs = Session(), []
    ses.agent, ses.path = "pi", path
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            t = o.get("type")
            ts = o.get("timestamp")
            if t == "session":
                ses.id = o.get("id") or ses.id
                ses.cwd = o.get("cwd") or ses.cwd
                ses.start = o.get("timestamp") or ses.start
                continue
            if t != "message":
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
                    tools.append(f"{b.get('name','?')}({_first_text(str(hint),60)})")
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
                msgs.append(Msg(_iso(ts), role or "?", body, " ".join(tools)))
    ses.end = msgs[-1].ts if msgs else ses.start
    ses.size = os.path.getsize(path) if os.path.exists(path) else 0
    return ses, msgs

def _iso(ts):
    """pi 时间戳可能是毫秒数或 ISO 字符串，统一成 ISO。"""
    if ts is None:
        return ""
    if isinstance(ts, str):
        return ts
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(int(ts) / 1000)) + "Z"
    except Exception:
        return ""

PARSERS = {"claude": parse_claude, "codex": parse_codex, "pi": parse_pi}

# ---------------------------------------------------------------- 扫描
def load(agents=AGENTS):
    """返回 [(Session, [Msg])]，按最后活动时间倒序。"""
    out = []
    if "claude" in agents:
        for p in glob.glob(f"{HOME}/.claude/projects/*/*.jsonl"):
            out.append(parse_claude(p))
    if "codex" in agents:
        for p in glob.glob(f"{HOME}/.codex/sessions/**/*.jsonl", recursive=True):
            out.append(parse_codex(p))
    if "pi" in agents:
        for p in glob.glob(f"{HOME}/.pi/agent/sessions/*/*.jsonl"):
            out.append(parse_pi(p))
    out.sort(key=lambda sm: sm[0].end or "", reverse=True)
    return out

def find(index, prefix, agents=AGENTS):
    hits = [sm for sm in index
            if sm[0].id.startswith(prefix) and sm[0].agent in agents]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        sys.exit(f"未找到会话: {prefix}")
    sys.exit(f"ID 前缀 {prefix} 命中 {len(hits)} 个会话，请用更长前缀:\n" +
             "\n".join(f"  {s.agent}  {s.id}" for s, _ in hits[:8]))

# ---------------------------------------------------------------- 展示
def _loc(ts):
    if not ts:
        return ""
    try:
        t = time.mktime(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
        return time.strftime("%m-%d %H:%M", time.localtime(t))
    except Exception:
        return ts[:16]

def fmt_dur(ses):
    try:
        a = time.mktime(time.strptime(ses.start[:19], "%Y-%m-%dT%H:%M:%S"))
        b = time.mktime(time.strptime(ses.end[:19], "%Y-%m-%dT%H:%M:%S"))
        d = int(b - a)
        return f"{d//3600}h{d%3600//60:02d}m" if d >= 3600 else f"{d//60}m{d%60:02d}s"
    except Exception:
        return "?"

def cmd_list(args):
    agents = [args.agent] if args.agent else list(AGENTS)
    index = load(agents)
    if args.cwd:
        index = [sm for sm in index if args.cwd.lower() in (sm[0].cwd or "").lower()]
    if args.limit:
        index = index[:args.limit]
    print(c("1;33", f"{'AGENT':<7} {'ID':<9} {'时长':<7} {'条数':<5} {'最后活动':<12} 项目 / 标题"))
    for s, _ in index:
        proj = (s.cwd or "?").replace(HOME, "~")
        title = s.title or "(空会话)"
        line = (f"{s.agent:<7} {s.id[:8]:<9} {fmt_dur(s):<7} "
                f"{s.n_user + s.n_asst:<5} {_loc(s.end):<12} ")
        txt = f"{proj}  ┃  {title}"
        print(line + c("36", proj) + c("2", "  ┃  ") + txt.split("  ┃  ")[1])

def cmd_show(args):
    ses, msgs = find(load(), args.id)
    if args.raw:
        os.system(f"cat {json.dumps(ses.path)} | less -R" if CLR else f"cat {json.dumps(ses.path)}")
        return
    if args.tail:
        msgs = msgs[-args.tail:]
    print(c("1;33", f"===== {ses.agent} {ses.id}"))
    print(c("2", f"cwd={ses.cwd or '?'}  消息={ses.n_user}+{s.n_asst if (s:=ses) else 0}"
                 f"  时长={fmt_dur(ses)}  文件={ses.path}"))
    last_day = ""
    for m in msgs:
        day = (m.ts or "")[:10]
        if day and day != last_day:
            print(c("2", f"—— {day} ——"))
            last_day = day
        who = {"user": c("1;36", "【用户】"), "assistant": c("1;32", "【助手】")}.get(
            m.role, c("1;35", f"【{m.role}】"))
        ts = c("2", _loc(m.ts)[6:] or "  --  ")
        tag = c("2", " (sidechain)") if m.sidechain else ""
        print(f"{ts} {who}{tag}")
        if m.text:
            print(m.text)
        if m.tool:
            print(c("2", f"    ⚙ {m.tool}" + ("  (--full 查看全部)" if not args.full else "")))

def cmd_search(args):
    agents = [args.agent] if args.agent else list(AGENTS)
    kw = args.keyword.lower()
    n = 0
    for ses, msgs in load(agents):
        for m in msgs:
            hay = (m.text + "\n" + m.tool).lower()
            pos = hay.find(kw)
            if pos < 0:
                continue
            n += 1
            snippet = (m.text or m.tool)
            start = max(0, pos - 50)
            frag = snippet[start:pos + len(args.keyword) + 70].replace("\n", " ")
            if start:
                frag = "…" + frag
            print(f"{c('1;33', ses.agent + ' ' + ses.id[:8])} {c('2', _loc(m.ts))} "
                  f"{c('36', (ses.title or '')[:40])}")
            print("   " + (c("1;36", frag) if m.role == "user" else frag))
            if n >= args.limit:
                print(c("2", f"(已到 --limit {args.limit})"))
                return
    if not n:
        print("无匹配")

def cmd_export(args):
    ses, msgs = find(load(), args.id)
    fmt, out = args.format, args.output
    if not out:
        safe = re.sub(r"[^\w.-]", "_", ses.title or ses.id)[:40]
        out = f"{ses.agent}-{safe}-{ses.id[:8]}.{fmt}"
    lines = [f"# {ses.title or ses.id}", "",
             f"- agent: **{ses.agent}**  id: `{ses.id}`",
             f"- cwd: `{ses.cwd}`  时间: {_loc(ses.start)} → {_loc(ses.end)}  时长: {fmt_dur(ses)}",
             f"- 来源: `{ses.path}`", ""]
    for m in msgs:
        who = "🧑 用户" if m.role == "user" else "🤖 助手"
        lines.append(f"## {who}  ({_loc(m.ts)})")
        if m.text:
            lines.append(m.text)
        if m.tool:
            lines.append(f"> 工具: `{m.tool}`")
        lines.append("")
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"已导出 {len(msgs)} 条 → {out}")

def resume_cmd(ses, fork=False):
    if ses.agent == "claude":
        cmd = f"claude --resume {ses.id}" + (" --fork-session" if fork else "")
        return f"cd {json.dumps(ses.cwd)} && {cmd}" if ses.cwd else cmd
    if ses.agent == "codex":
        return f"codex resume {ses.id}" + (" --fork" if fork else "")
    return f"pi --session {json.dumps(ses.path)}"  # pi 按文件路径恢复最稳

def cmd_resume(args):
    ses, _ = find(load(), args.id)
    cmd = resume_cmd(ses, args.fork)
    print(c("1;32", cmd))
    if args.exec:
        cwd = ses.cwd or os.getcwd()
        os.chdir(cwd)
        if ses.agent == "claude":
            argv = ["claude", "--resume", ses.id] + (["--fork-session"] if args.fork else [])
        elif ses.agent == "codex":
            argv = ["codex", "resume", ses.id] + (["--fork"] if args.fork else [])
        else:
            argv = ["pi", "--session", ses.path]
        print(c("2", f"→ 在 {cwd} 启动，Ctrl+C 退出后回到本工具"))
        os.execvp(argv[0], argv)

# ---------------------------------------------------------------- TUI
def cmd_tui(args):
    index = load()
    if not index:
        sys.exit("没有会话")
    items = index[:60]
    sel, off = 0, 0
    fd = sys.stdin
    if not sys.stdin.isatty():
        for i, (s, _) in enumerate(items):
            print(f"{i+1:>3}. {s.agent:<7} {s.id[:8]}  {_loc(s.end)}  "
                  f"{(s.cwd or '?').replace(HOME,'~')}  ┃  {s.title or ''}")
        print("输入编号选择，回车恢复（或留空退出）:")
        raw = input("> ").strip()
        if raw.isdigit() and 1 <= int(raw) <= len(items):
            ses = items[int(raw) - 1][0]
            print(c("1;32", resume_cmd(ses)))
        return
    import termios, tty
    old = termios.tcgetattr(fd.fileno())
    try:
        tty.setraw(fd.fileno())
        while True:
            h, w = 12, min(120, os.get_terminal_size().columns - 2)
            rows = [c("1;33", "↑↓/jk 移动  Enter 恢复  s 查看  q 退出")]
            for i in range(off, min(off + h - 2, len(items))):
                s = items[i][0]
                cur = c("7", "▶") + c("7", f" {s.agent:<6} {s.id[:8]} {_loc(s.end)} "
                        f"{(s.cwd or '?').replace(HOME,'~')}") + c("0", "")
                row = cur if i == sel else (f"  {s.agent:<6} {s.id[:8]} {_loc(s.end)} "
                        f"{(s.cwd or '?').replace(HOME,'~')}")
                rows.append(row[:w])
            sys.stdout.write("\033[H\033[2J" + "\n".join(rows) + "\r")
            sys.stdout.flush()
            key = fd.read(1)
            if key in ("\x1b", "q"):
                sys.stdout.write("\033[H\033[2J")
                return
            if key == "A" or key == "k":
                sel = max(0, sel - 1); off = min(off, sel)
            elif key == "B" or key == "j":
                sel = min(len(items) - 1, sel + 1)
                if sel >= off + h - 2:
                    off = sel - (h - 3)
            elif key == "\r" or key == "\n":
                ses = items[sel][0]
                sys.stdout.write("\033[H\033[2J")
                termios.tcsetattr(fd.fileno(), termios.TCSADRAIN, old)
                cmd = resume_cmd(ses)
                print(c("1;32", cmd))
                cwd = ses.cwd or os.getcwd()
                os.chdir(cwd)
                if ses.agent == "claude":
                    os.execvp("claude", ["claude", "--resume", ses.id])
                elif ses.agent == "codex":
                    os.execvp("codex", ["codex", "resume", ses.id])
                else:
                    os.execvp("pi", ["pi", "--session", ses.path])
                return
            elif key == "s":
                ses, msgs = items[sel]
                termios.tcsetattr(fd.fileno(), termios.TCSADRAIN, old)
                for m in msgs[:20]:
                    print(f"{_loc(m.ts)[6:]:>11} "
                          f"{c('1;36','用户') if m.role=='user' else c('1;32','助手')}: "
                          f"{(m.text or m.tool)[:100]}")
                print(c("2", f"… 共 {len(msgs)} 条。完整查看: opensession show {ses.id[:8]}"))
                print(c("2", "按回车返回选择器"))
                input()
                tty.setraw(fd.fileno())
    finally:
        termios.tcsetattr(fd.fileno(), termios.TCSADRAIN, old)

# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(prog="opensession",
        description="claude code / codex / pi 历史会话统一查看与恢复")
    sub = ap.add_subparsers(dest="cmd")
    p = sub.add_parser("list", help="列出会话")
    p.add_argument("--agent", choices=AGENTS); p.add_argument("--cwd")
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("show", help="查看一场对话")
    p.add_argument("id"); p.add_argument("--full", action="store_true")
    p.add_argument("--tail", type=int); p.add_argument("--raw", action="store_true")
    p.set_defaults(fn=cmd_show)
    p = sub.add_parser("search", help="全文搜索")
    p.add_argument("keyword"); p.add_argument("--agent", choices=AGENTS)
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(fn=cmd_search)
    p = sub.add_parser("export", help="导出 Markdown")
    p.add_argument("id"); p.add_argument("-o", "--output")
    p.add_argument("--format", choices=("md", "txt"), default="md")
    p.set_defaults(fn=cmd_export)
    p = sub.add_parser("resume", help="打印/执行恢复命令")
    p.add_argument("id"); p.add_argument("--fork", action="store_true")
    p.add_argument("--exec", action="store_true", help="直接启动对应 CLI")
    p.set_defaults(fn=cmd_resume)
    sub.add_parser("tui", help="交互式选择恢复").set_defaults(fn=cmd_tui)
    args = ap.parse_args()
    if not args.cmd:
        args.cmd, args.fn, args.agent, args.cwd, args.limit = \
            "list", cmd_list, None, None, 30
    args.fn(args)

if __name__ == "__main__":
    main()
