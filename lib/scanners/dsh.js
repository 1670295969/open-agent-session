// dsh（DeepSeek Harness，@deepseek-ai/dsh）会话扫描
//
// 存储布局：
//   ~/.dsh/sessions/--<cwd 转义>--/session-<uuid>/session.v4.jsonl.zstd
//   ~/.dsh/sessions/--<cwd 转义>--/session-<uuid>/session.lock      （锁文件，忽略）
//
// 三处与其它工具不同的地方，都实测过：
//
// 1. **多帧 zstd**。每追加一批事件就压一个新帧拼到文件尾，单文件可能 3–6 帧。
//    Node 内置 zstdDecompressSync 只解第一帧（143KB 文件只出 169 字节），
//    必须走 lib/zstd.js 的多帧解析。
//
// 2. **cwd 藏在首行 session 事件里**，不在目录名上。目录名是转义过的，
//    反解容易出错（`.` `-` `_` 都会被转义，无法无损还原），所以读首行拿原文。
//
// 3. **标题优先取 session/title 事件**（dsh 自己生成，比首条用户消息干净），
//    没有才退回首条用户消息。首条消息常带 `[Workspace::v1: /path]` 前缀，要剥掉。
const fs = require("fs");
const path = require("path");
const { HOME, EMPTY_TITLE, DSH_INJECT_PATTERNS } = require("../config");
const { cleanTitle, tryJson, textFromContent } = require("../utils");
const { decompressAll } = require("../zstd");

// 扫描阶段只看前面这么多行就够拿到 cwd / 标题 / 首条消息。
// 会话是追加写的，标题在最前面，没必要为列表把整个文件解出来。
const SCAN_MAX_LINES = 200;

function stripInject(t) {
  let s = String(t || "").trim();
  for (const re of DSH_INJECT_PATTERNS) s = s.replace(re, "").trim();
  return s;
}

// 会话目录名 → 无从反解，只能读首行；但列表阶段仍需一个兜底 cwd
function scanDsh() {
  const root = path.join(HOME, ".dsh", "sessions");
  let projectDirs;
  try { projectDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }

  const sessions = [];
  for (const pd of projectDirs) {
    if (!pd.isDirectory()) continue;
    const pdir = path.join(root, pd.name);
    let entries;
    try { entries = fs.readdirSync(pdir, { withFileTypes: true }); } catch { continue; }

    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith("session-")) continue;
      const dir = path.join(pdir, e.name);
      const file = path.join(dir, "session.v4.jsonl.zstd");
      if (!fs.existsSync(file)) continue;

      let st;
      try { st = fs.statSync(file); } catch { continue; }

      let cwd = "", title = "", hasBody = false, mtime = st.mtimeMs;
      try {
        const text = decompressAll(fs.readFileSync(file)).toString("utf8");
        const lines = text.split("\n").slice(0, SCAN_MAX_LINES);
        let firstUser = "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          const o = tryJson(ln);
          if (!o) continue;
          const d = o.data || {};
          if (o.type === "session") {
            if (o.cwd) cwd = o.cwd;
            if (o.createdAt) mtime = Math.max(mtime, o.createdAt);
          } else if (o.type === "session/title") {
            if (d.title) title = d.title;
          } else if (o.type === "user/message") {
            const t = stripInject(textFromContent(d.content));
            if (t) {
              hasBody = true;
              if (!firstUser) firstUser = t;
            }
          } else if (o.type === "assistant/message") {
            const m = d.message || d;
            if (textFromContent(m.content)) hasBody = true;
          } else if (o.type === "turn/end" && d.time) {
            mtime = Math.max(mtime, d.time);
          }
        }
        if (!title) title = firstUser;
      } catch { /* 解压失败就当空会话，不让整个列表挂掉 */ }

      // dsh 的会话 id 目录名自带 `session-` 前缀，页面链接用去掉前缀的 uuid
      const fullId = e.name;
      sessions.push({
        tool: "dsh",
        id: fullId,
        fullId,
        file,
        cwd,
        title: cleanTitle(title, hasBody ? fullId : EMPTY_TITLE),
        empty: !hasBody,
        mtime,
        size: st.size,
        // dsh 恢复必须在会话记录的 cwd 下执行，否则报
        //   session "…" was recorded in "<x>", not "<y>"
        // 所以命令里显式 cd 进去，用户从任何目录粘贴都能用。
        resumeCmd: cwd
          ? `cd ${JSON.stringify(cwd)} && dsh --profile headless --session-id ${fullId}`
          : `dsh --profile headless --session-id ${fullId}`,
      });
    }
  }
  return sessions;
}

module.exports = { scanDsh, stripInject };
