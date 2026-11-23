// 各工具的会话正文解析（jsonl / 单 JSON → 统一消息数组）
// 统一消息结构: { role:"user"|"assistant", time, text, tool, sidechain? }
const fs = require("fs");
const { MAX_MSG_CHARS } = require("../config");
const { textFromContent, isInject, isoTs, tryJson, firstText, readLines } = require("../utils");

// 工具调用块的简短描述：name(参数摘要)
function toolHint(b) {
  let a = b.arguments || b.input || {};
  if (typeof a === "string") a = tryJson(a) || {}; // codex arguments 是 JSON 字符串
  const hint = a.cmd || a.command || a.file_path || a.path || a.pattern || a.url || "";
  return `${b.name}(${firstText(JSON.stringify(hint), 70)})`;
}

// 截断超长消息
function truncate(msgs) {
  for (const m of msgs) {
    if (m.text && m.text.length > MAX_MSG_CHARS) {
      m.text = m.text.slice(0, MAX_MSG_CHARS) + "\n…[已截断]";
    }
  }
  return msgs;
}

// hermes 消息 content 可能是字符串或 OpenAI 风格数组
function hermesText(m) {
  const c = m.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) return textFromContent(c);
  return "";
}

function parseHermes(content) {
  const msgs = [];
  for (const m of (content.messages || [])) {
    const t = hermesText(m);
    const time = m.timestamp ? new Date(m.timestamp * 1000).toISOString() : "";
    if (m.role === "user") {
      if (!t) continue;
      msgs.push({ role: "user", time, text: t, tool: "" });
    } else if (m.role === "assistant") {
      const calls = [];
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || tc;
          calls.push(`${fn.name || "?"}(${firstText(String(fn.arguments || ""), 70)})`);
        }
      }
      msgs.push({ role: "assistant", time, text: t, tool: calls.join("  ") });
    }
    // role=tool 是工具结果，跳过（工具调用已在 assistant 行展示）
  }
  return msgs;
}

function parseClaudeLine(o, msgs) {
  if (!["user", "assistant"].includes(o.type) || !o.message) return;
  const time = o.timestamp ? String(o.timestamp) : isoTs(o.ts);
  const content = o.message.content;
  const t = textFromContent(content);
  const tools = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "tool_use") tools.push(toolHint(b));
    }
    // 纯 tool_result 的 user 回包，跳过
    if (o.type === "user" && content.some((b) => b && b.type === "tool_result") && !t) return;
  }
  if (o.type === "user" && (!t || isInject(t) || t.startsWith("<command-name>"))) return;
  if (!t && !tools.length) return;
  msgs.push({
    role: o.type === "user" ? "user" : "assistant",
    time, text: t, tool: tools.join("  "), sidechain: !!o.isSidechain,
  });
}

function parseCodexLine(o, msgs) {
  if (o.type !== "response_item" || !o.payload) return;
  const p = o.payload;
  const time = o.timestamp ? String(o.timestamp) : isoTs(o.ts);
  if (p.type === "function_call") {
    msgs.push({ role: "assistant", time, text: "", tool: toolHint(p) });
    return;
  }
  if (p.type !== "message") return;
  const t = textFromContent(p.content);
  if (!t) return;
  if (p.role === "user" && isInject(t)) return;
  if (!["user", "assistant"].includes(p.role)) return;
  msgs.push({ role: p.role === "user" ? "user" : "assistant", time, text: t, tool: "" });
}

function parsePiLine(o, msgs) {
  if (o.type !== "message" || !o.message) return;
  const m = o.message;
  if (!["user", "assistant"].includes(m.role)) return; // toolResult 等跳过
  const time = o.timestamp ? String(o.timestamp) : isoTs(o.ts);
  const t = textFromContent(m.content);
  const tools = [];
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === "toolCall") tools.push(toolHint(b));
    }
  }
  if (!t && !tools.length) return;
  if (m.role === "user" && isInject(t)) return;
  msgs.push({ role: m.role, time, text: t, tool: tools.join("  ") });
}

const LINE_PARSERS = { claude: parseClaudeLine, codex: parseCodexLine, pi: parsePiLine };

async function parseSession(file, tool) {
  // hermes 是整份 JSON，不是 jsonl
  if (tool === "hermes") {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
    return truncate(parseHermes(o));
  }
  const parseLine = LINE_PARSERS[tool] || parsePiLine;
  const lines = await readLines(file);
  const msgs = [];
  for (const l of lines) {
    const o = tryJson(l);
    if (!o) continue;
    parseLine(o, msgs);
  }
  return truncate(msgs);
}

module.exports = { parseSession, toolHint };
