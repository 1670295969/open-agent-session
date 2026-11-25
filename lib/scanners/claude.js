// Claude Code 会话扫描：~/.claude/projects/**/*.jsonl
const fs = require("fs");
const path = require("path");
const { HOME, EMPTY_TITLE } = require("../config");
const { walk, readLines, tryJson, textFromContent, isInject, firstText, cleanTitle } = require("../utils");

const SCAN_MAX_LINES = 300;

async function scanClaude() {
  const files = walk(path.join(HOME, ".claude", "projects"));
  const sessions = [];
  for (const file of files) {
    // 🔴 `.../<sessionId>/subagents/agent-xxx.jsonl` 是 Agent 工具派出去的子代理转录，
    // 里面每行都带**父会话**的 sessionId —— 扫进来就会在列表里变成同一个 id 的重复条目
    // （实测 7 个文件散落在 3 个会话下，其中一个会话因此占了 4 条）。
    // 子代理的产出本来就在父会话的 tool_result 里，不需要单独列，只打标记由上层过滤。
    const isSub = /[\\/]subagents[\\/]/.test(file);
    const lines = await readLines(file, SCAN_MAX_LINES);
    const truncated = lines.length >= SCAN_MAX_LINES;
    let id = "", cwd = "", title = "";
    let hasBody = false;
    for (const l of lines) {
      const o = tryJson(l);
      if (!o) continue;
      if (o.type === "summary" && o.summary && !title) title = o.summary;
      if (o.sessionId) id = o.sessionId;
      if (!cwd && o.cwd) cwd = o.cwd;
      if ((o.type === "user" || o.type === "assistant") && o.message) {
        const t = textFromContent(o.message.content);
        if (t && (o.type === "assistant" || (!isInject(t) && !t.startsWith("<command-name>")))) {
          hasBody = true;
          if (!title && o.type === "user") title = t;
        }
      }
      // 必须连 hasBody 一起判断：summary 单独就能给出标题，
      // 只按 id+cwd+title 提前退出会把「仅有 summary、无正文」的会话说成有内容
      if (id && cwd && title && hasBody) break;
    }
    if (!id) continue;
    const st = fs.statSync(file);
    const empty = !hasBody && !truncated;
    sessions.push({
      tool: "claude", id, file, cwd: cwd || "",
      title: cleanTitle(title, empty ? EMPTY_TITLE : firstText(path.basename(file, ".jsonl"), 60)),
      empty, sub: isSub,
      mtime: st.mtimeMs, size: st.size,
      resumeCmd: `claude --resume ${id}`,
    });
  }
  return sessions;
}

module.exports = { scanClaude };
