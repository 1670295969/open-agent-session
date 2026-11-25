// Codex CLI 会话扫描：~/.codex/sessions/**/*.jsonl
// 命名索引 ~/.codex/session_index.jsonl: id -> 最近 thread_name
const fs = require("fs");
const path = require("path");
const { HOME, EMPTY_TITLE } = require("../config");
const { walk, readLines, tryJson, textFromContent, isInject, cleanTitle } = require("../utils");

const CODEX_NAMES = (() => {
  const m = {};
  try {
    const idx = path.join(HOME, ".codex", "session_index.jsonl");
    for (const l of fs.readFileSync(idx, "utf8").split("\n")) {
      const o = tryJson(l);
      if (o && o.id && o.thread_name) m[o.id] = o.thread_name;
    }
  } catch {}
  return m;
})();

// 扫描时最多读这么多行来找 id / 标题 / 是否有正文
const SCAN_MAX_LINES = 400;

async function scanCodex() {
  const files = walk(path.join(HOME, ".codex", "sessions"));
  const sessions = [];
  for (const file of files) {
    const lines = await readLines(file, SCAN_MAX_LINES);
    // 读满上限说明文件可能还有后续内容，此时不能断定「无对话」
    const truncated = lines.length >= SCAN_MAX_LINES;
    let id = "", cwd = "", title = "";
    let hasBody = false; // 存在非注入的 user / assistant 正文
    let isSub = false, metaSeen = false;
    for (const l of lines) {
      const o = tryJson(l);
      if (!o) continue;
      // 🔴 只认第一条 session_meta。codex 0.171 起派生 subagent/fork 时，会把自己那条
      // session_meta 写在最前面（payload.id = 自己的 thread id，payload.session_id = 父会话），
      // 紧接着再把父会话的 session_meta 抄一遍。原来每遇一次就赋值 → 最后一条（父 id）胜出，
      // 18 个子代理文件全被标成父会话，列表里同一个 id 冒出十几条重复。
      if (o.type === "session_meta" && o.payload && !metaSeen) {
        metaSeen = true;
        const pl = o.payload;
        id = pl.id || pl.session_id || "";
        cwd = pl.cwd || "";
        // source.subagent = 主代理派出去干活的分身，内容已经在父会话的工具调用里，
        // 单独列出来只会把列表刷满同名条目，默认不展示。
        // 只有 forked_from_id / parent_thread_id（用户主动 /fork 出来的真会话）不算子代理。
        if (pl.source && pl.source.subagent) isSub = true;
      }
      if (o.type === "response_item" && o.payload && o.payload.type === "message") {
        const role = o.payload.role;
        if (role === "user" || role === "assistant") {
          const t = textFromContent(o.payload.content);
          if (t && (role === "assistant" || !isInject(t))) {
            hasBody = true;
            if (!title && role === "user") title = t;
          }
        }
      }
      if (id && title) break;
    }
    if (!id) continue;
    const st = fs.statSync(file);
    // 没有任何正文且文件已读完 → 这是个空壳会话（常见于 codex exec 启动后立刻被中断）
    const empty = !hasBody && !truncated;
    sessions.push({
      tool: "codex", id, file, cwd: cwd || "",
      title: cleanTitle(
        title,
        CODEX_NAMES[id] || (empty ? EMPTY_TITLE : path.basename(file))
      ),
      empty, sub: isSub,
      mtime: st.mtimeMs, size: st.size,
      resumeCmd: `codex resume --no-daemon ${id}`,
    });
  }
  return sessions;
}

module.exports = { scanCodex, CODEX_NAMES };
