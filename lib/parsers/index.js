// 各工具的会话正文解析（jsonl / 单 JSON → 统一消息数组）
// 统一消息结构: { role:"user"|"assistant", time, text, tool, sidechain? }
const fs = require("fs");
const { MAX_MSG_CHARS } = require("../config");
const { textFromContent, isInject, isoTs, tryJson, firstText, readLines } = require("../utils");
const { decompressAll } = require("../zstd");
const { DSH_INJECT_PATTERNS, DSH_INJECT_BLOCKS, DSH_DROP_PATTERNS } = require("../config");

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

// dsh（DeepSeek Harness）事件流。
// 只取 user/message 与 assistant/message 两类事件 —— 工具调用同时出现在
// assistant/message 的 tool-call 块和独立的 tool/call 事件里，后者重复，跳过。
// step/start、turn/*、system/message 都是控制流，界面上不需要。
//
// 注入剥两轮：
//   1) DSH_INJECT_PATTERNS —— 单向前缀（[Workspace::v1: …]）
//   2) DSH_INJECT_BLOCKS   —— 成对包裹块，形如
//        [OUT-OF-BAND USER MESSAGE — 说明]\n正文\n[/OUT-OF-BAND USER MESSAGE]
//      只剥开头会在尾部留 `[/OUT-OF-BAND USER MESSAGE]`（实测踩过：
//      137 条消息里有 1 条尾巴带残标），所以按「开标记 … 闭标记」整体替换，
//      保留中间的正文。闭标记前可能没有换行、说明文字长度也不定，用 [\s\S]*? 匹配。
function dshStrip(t) {
  let s = String(t || "").trim();
  for (const name of DSH_INJECT_BLOCKS) {
    const open = "\\[" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 开标记带说明：`[NAME — …]`；闭标记固定 `[/NAME]`
    const re = new RegExp(open + "[^\\]]*\\]\\s*([\\s\\S]*?)\\s*\\[/" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\]", "g");
    s = s.replace(re, "$1");
    // 开标记存在但没有闭标记（截断/流未结束）：只剥开标记，别把正文一起丢了
    s = s.replace(new RegExp(open + "[^\\]]*\\]\\s*"), "");
  }
  for (const re of DSH_INJECT_PATTERNS) s = s.replace(re, "").trim();
  return s.trim();
}

function parseDshLine(o, msgs) {
  if (o.type !== "user/message" && o.type !== "assistant/message") return;
  const d = o.data || {};
  // user/message 的字段在 data 上；assistant/message 多包一层 data.message
  const m = d.message || d;
  const time = isoTs(o.time);
  const t = textFromContent(m.content);

  // 上下文压缩 / 历史交接摘要：整条丢弃（见 config.js 的 DSH_DROP_PATTERNS 说明）
  if (t && DSH_DROP_PATTERNS.some((re) => re.test(t))) return;

  const tools = [];
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === "tool-call") tools.push(toolHint(b));
    }
  }
  if (o.type === "user/message") {
    const u = dshStrip(t);
    if (!u) return; // 纯注入（Workspace 前缀 / OUT-OF-BAND 等）不显示
    msgs.push({ role: "user", time, text: u, tool: "" });
    return;
  }
  if (!t && !tools.length) return;
  // assistant 也过一遍剥离：末尾常有 `[Workspace::v1: …]` + 再次重述的活跃请求
  const a = dshStrip(t);
  if (!a && !tools.length) return;
  msgs.push({ role: "assistant", time, text: a, tool: tools.join("  ") });
}

const LINE_PARSERS = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
  pi: parsePiLine,
  dsh: parseDshLine,
};

async function parseSession(file, tool) {
  // hermes 是整份 JSON，不是 jsonl
  if (tool === "hermes") {
    let o = null;
    try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
    return truncate(parseHermes(o));
  }
  // dsh 是 zstd 压缩的多帧 jsonl，且不是普通文本文件，不能走 readLines
  if (tool === "dsh") {
    let text = "";
    try { text = decompressAll(fs.readFileSync(file)).toString("utf8"); }
    catch { return []; }
    const msgs = [];
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      const o = tryJson(l);
      if (!o) continue;
      parseDshLine(o, msgs);
    }
    return truncate(msgs);
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
