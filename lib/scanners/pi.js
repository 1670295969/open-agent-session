// Pi CLI 会话扫描：$PI_CODING_AGENT_SESSION_DIR 或 ~/.pi/agent/sessions/**/*.jsonl
const fs = require("fs");
const path = require("path");
const { HOME, EMPTY_TITLE } = require("../config");
const { walk, readLines, tryJson, textFromContent, isInject, isoTs, cleanTitle } = require("../utils");

const SCAN_MAX_LINES = 300;

async function scanPi() {
  const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  const dirs = [envDir, path.join(HOME, ".pi", "agent", "sessions")].filter(Boolean);
  const files = [];
  for (const d of dirs) walk(d, files);
  const sessions = [];
  for (const file of files) {
    const lines = await readLines(file, SCAN_MAX_LINES);
    const truncated = lines.length >= SCAN_MAX_LINES;
    let title = "", cwd = "", hasBody = false;
    for (const l of lines) {
      const o = tryJson(l);
      if (!o) continue;
      if (!cwd && o.cwd) cwd = o.cwd;
      if (o.type === "message" && o.message && ["user", "assistant"].includes(o.message.role)) {
        const t = textFromContent(o.message.content);
        const okUser = o.message.role === "user" && t && !isInject(t);
        const okAsst = o.message.role === "assistant" && t;
        if (okUser || okAsst) {
          hasBody = true;
          if (!title && okUser) title = t;
        }
      }
      if (title && cwd) break;
    }
    const st = fs.statSync(file);
    const fullId = path.basename(file, ".jsonl");
    const empty = !hasBody && !truncated;
    sessions.push({
      tool: "pi", id: fullId.slice(-8), fullId, file, cwd: cwd || "",
      title: cleanTitle(title, empty ? EMPTY_TITLE : fullId),
      empty,
      mtime: st.mtimeMs, size: st.size,
      resumeCmd: `pi --session "${file}"`,
    });
  }
  return sessions;
}

module.exports = { scanPi };
