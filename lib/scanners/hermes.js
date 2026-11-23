// Hermes 会话扫描：webui 索引 + CLI 单文件 JSON
const fs = require("fs");
const path = require("path");
const { HOME, EMPTY_TITLE } = require("../config");
const { cleanTitle, readJsonFile } = require("../utils");

// webui 索引 ~/.hermes/webui/sessions/_index.json: [{session_id,title,workspace,message_count,...}]
function scanHermesWebui(seen) {
  const sessions = [];
  const idx = readJsonFile(path.join(HOME, ".hermes", "webui", "sessions", "_index.json"));
  if (!Array.isArray(idx)) return sessions;
  for (const e of idx) {
    if (!e.session_id || seen.has(e.session_id)) continue;
    seen.add(e.session_id);
    const file = path.join(HOME, ".hermes", "webui", "sessions", e.session_id + ".json");
    if (!fs.existsSync(file)) continue;
    const st = fs.statSync(file);
    // _index 里带 message_count，为 0 就是空会话
    const empty = Number(e.message_count) === 0;
    sessions.push({
      tool: "hermes", id: e.session_id, file,
      cwd: e.workspace || "",
      title: cleanTitle(e.title, empty ? EMPTY_TITLE : e.session_id),
      empty,
      mtime: e.updated_at ? e.updated_at * 1000 : st.mtimeMs,
      size: st.size,
      resumeCmd: `hermes -r ${e.session_id}`,
    });
  }
  return sessions;
}

// CLI 会话 ~/.hermes/sessions/session_*.json（无 cwd，只有 session_id/model/messages）
function scanHermesCli(seen) {
  const sessions = [];
  let files;
  try { files = fs.readdirSync(path.join(HOME, ".hermes", "sessions")); } catch { return sessions; }
  for (const file of files) {
    if (!file.startsWith("session_") || !file.endsWith(".json")) continue;
    const full = path.join(HOME, ".hermes", "sessions", file);
    try {
      const o = JSON.parse(fs.readFileSync(full, "utf8"));
      const sid = o.session_id || file.slice(8, -5);
      if (seen.has(sid)) continue;
      seen.add(sid);
      const firstUser = (o.messages || []).find((m) => m.role === "user" && m.content);
      const hasBody = (o.messages || []).some(
        (m) => (m.role === "user" || m.role === "assistant") && m.content
      );
      const st = fs.statSync(full);
      sessions.push({
        tool: "hermes", id: sid, file: full, cwd: "",
        title: cleanTitle(firstUser ? String(firstUser.content) : "", hasBody ? sid : EMPTY_TITLE),
        empty: !hasBody,
        mtime: o.last_updated ? new Date(o.last_updated).getTime() : st.mtimeMs,
        size: st.size,
        resumeCmd: `hermes -r ${sid}`,
      });
    } catch {}
  }
  return sessions;
}

function scanHermes() {
  const seen = new Set();
  return [...scanHermesWebui(seen), ...scanHermesCli(seen)];
}

module.exports = { scanHermes };
