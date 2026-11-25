// 各工具的会话正文解析（jsonl / 单 JSON → 统一消息数组）
// 统一消息结构: { role:"user"|"assistant", time, text, tool, think, sidechain?, toolFull? }
//   think    = 思考过程（thinking / reasoning），前端默认折叠显示，可能是空串
//   tool     = 工具调用摘要（name(70字参数)），一眼认出做了什么
//   toolFull = [{name, body}] 完整命令原文，只有「摘要装不下」时才存在；
//              前端点开工具体展开看（可折叠，见 chat.js 的 toolHtml）
const fs = require("fs");
const { MAX_MSG_CHARS, MAX_THINK_CHARS, MAX_TOOL_CHARS } = require("../config");
const { textFromContent, isInject, isoTs, tryJson, firstText, readLines } = require("../utils");
const { decompressAll } = require("../zstd");
const { DSH_INJECT_PATTERNS, DSH_INJECT_BLOCKS, DSH_DROP_PATTERNS } = require("../config");

/* 工具调用块的简短描述：name(参数摘要)
   摘要固定压成单行、截到 70 字，只用于「一眼认出这是什么操作」。
   真实命令另存 msg.toolFull（见 toolText），前端点开才看。 */
function toolHint(b) {
  let a = b.arguments || b.input || {};
  if (typeof a === "string") a = tryJson(a) || {}; // codex arguments 是 JSON 字符串
  const hint = a.cmd || a.command || a.file_path || a.path || a.pattern || a.url || "";
  return `${b.name}(${firstText(JSON.stringify(hint), 70)})`;
}

/* 工具调用的原文：name(完整参数)，保留换行。
   🔴 为什么必须另存而不是放宽 toolHint 的 70 字上限：
     1. firstText 会把 \s+ 压成单个空格 —— shell 的 for/if 多行脚本压完就是一行乱麻，
        折叠展开后看到的仍然不是原命令，等于没修。
     2. m.tool 是既有契约：chip 摘要、全文搜索命中、导出 MD、单条复制都在用，
        把长命令塞进去会让列表 chip 撑爆、搜索结果片段被大段脚本淹没。
   返回 null 表示「原文没比摘要多出什么信息」，前端就不给折叠入口 ——
   绝大多数调用（6888/7869 条摘要不足 200 字）本来一眼能看全，加个折叠反而多一次点击。 */
function toolFullOf(b) {
  let a = b.arguments || b.input || {};
  if (typeof a === "string") a = tryJson(a) || { raw: a };
  const cmd = a.cmd || a.command;
  const isCmd = typeof cmd === "string" && cmd.length > 0;
  let body;
  if (isCmd) {
    body = cmd;                       // 真命令：给原文，保住换行与缩进
  } else if (typeof a.file_path === "string" && Object.keys(a).length === 1) {
    body = a.file_path;               // 单文件路径：摘要已完整，不必折叠
  } else {
    // 没有命令字段：整个参数对象的 JSON 才有用（子代理参数、多字段编辑等）
    try { body = JSON.stringify(a, null, 2); } catch { body = String(a); }
  }
  let s = String(body == null ? "" : body);
  const need = isCmd ? (s.includes("\n") || s.length > 60) : s.length > 120;
  if (!need) return null;
  if (s.length > MAX_TOOL_CHARS) s = s.slice(0, MAX_TOOL_CHARS) + "\n…[命令过长，已截断]";
  return { name: b.name || "?", body: s };
}

/* 只在真有可折叠内容时才写 toolFull 字段。
   全量渲染 + 9513 条消息，给每条都塞一个空数组纯属浪费带宽，
   而且前端判断「要不要画折叠块」也要多绕一层。 */
function withFull(m, fulls) {
  const f = fulls.filter(Boolean);
  if (f.length) m.toolFull = f;
  return m;
}


// 截断超长消息
function truncate(msgs) {
  for (const m of msgs) {
    if (m.text && m.text.length > MAX_MSG_CHARS) {
      m.text = m.text.slice(0, MAX_MSG_CHARS) + "\n…[已截断]";
    }
    if (m.think && m.think.length > MAX_THINK_CHARS) {
      m.think = m.think.slice(0, MAX_THINK_CHARS) + "\n…[思考已截断]";
    }
  }
  return msgs;
}

// ---- 思考过程（点开才看，默认折叠）----
// 各家存法不同，统一抽成 msg.think 字符串，正文仍单独放 msg.text：
//   claude / pi  content 里的 {type:"thinking", thinking:"…"} 块
//   codex        payload.reasoning.summary[].text（content 是加密的，只有摘要可读）
//   hermes       message.reasoning_content
//   dsh          content 里的 {type:"reasoning", text:"…"} 块
//                （2026-11-23 更正：早前记为"dsh 没有"是错的 —— 那次只抽查了没开
//                 思考强度的会话。实测开高思考后会写 reasoning 块且是完整明文。）
function thinkFromBlocks(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "thinking" && b.thinking) parts.push(b.thinking);
    else if (b.type === "reasoning" && b.text) parts.push(b.text);
  }
  return parts.join("\n\n").trim();
}

// ---- 内联 <think> 标签（旧版 Claude CLI 的遗留写法）----
// 【实测】Claude Code 早期版本把思考**直接写进 text 块**，形如
//     <think>我在看日志…</think>\n\n我先看一下目录结构。
// 新版本改用 content 里的 {type:"thinking"} 块，但老会话不会重写。
// 不剥的话，页面上会直接显示 "<think>" 字样，且那一大段英文推理会被当成正文，
// 把真正的回答挤到下面 —— 排版最难看的就是这种。
//
// 🔴 三个坑：
//  1. **未闭合标签会跨消息**。实测 58 条含标签的消息里只有 8 条成对闭合，
//     其余是「这条结尾开了、下一条才关」。所以状态必须跨消息携带
//     （scanInlineThink 的 state.inThink），不能逐条独立判定。
//  2. 也有**孤立闭标签** `</think>` 自成一条消息（实测 1 条，长度 8）。
//     出现在非 inThink 状态下时它没有配对的起始，直接丢掉整条即可。
//  3. 标签名有 <think> 和 <thinking> 两种写法，都要认。
// 正文里偶尔会提到这个标签（比如在讲解析实现），但那属于极少数且会成对出现，
// 按块剥离不会误伤正文——被剥掉的只是标签内的内容，且内容本来就是思考。
function scanInlineThink(text, state) {
  if (!text || text.indexOf("think") < 0) {
    return { text, think: state.inThink ? text : "", swallowed: state.inThink };
  }
  let out = "";      // 重新拼出的正文
  let got = "";      // 本轮挖出来的思考
  let i = 0;
  const s = text;
  const RE = /<\/?think(?:ing)?>/i;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = rest.match(RE);
    if (!m) {
      if (state.inThink) got += rest;
      else out += rest;
      break;
    }
    const tag = m[0].toLowerCase();
    const before = rest.slice(0, m.index);
    if (state.inThink) got += before;
    else out += before;
    if (tag.startsWith("</")) {
      // 闭标签：只有在 inThink 状态下才算「一段思考结束」
      state.inThink = false;
    } else {
      // 开标签：已在 inThink 里说明是嵌套/误写，忽略即可
      state.inThink = true;
    }
    i += m.index + m[0].length;
  }
  const t = out.replace(/\n{3,}/g, "\n\n").trim();
  return { text: t, think: got.trim() };
}

// claude / pi 常把「只想、不答」的 assistant 行单独写成一条（claude 实测 871 条），
// 直接铺成卡片就是一堆空壳。这里把纯思考消息攒起来，并到**后面第一条**带正文或
// 工具的 assistant 消息上（时序上思考在前、回答在后，拼一起正好读得通）。
// 后面紧跟用户提问、并不过去时，才留作独立的「只有折叠思考」的消息 —— 内容不丢。
function mergeThink(msgs) {
  const out = [];
  let pending = "", pendingTime = "";
  const flush = () => {
    if (!pending) return;
    out.push({ role: "assistant", time: pendingTime, text: "", tool: "", think: pending });
    pending = ""; pendingTime = "";
  };
  for (const m of msgs) {
    const bare = m.role === "assistant" && !m.text && !m.tool;
    if (bare && m.think) {
      pending = pending ? pending + "\n\n" + m.think : m.think;
      if (!pendingTime) pendingTime = m.time || "";
      continue;
    }
    if (m.role === "assistant" && pending) {
      m.think = m.think ? pending + "\n\n" + m.think : pending;
      pending = ""; pendingTime = "";
    } else if (pending) {
      flush();
    }
    out.push(m);
  }
  flush();
  return out;
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
    // 推理模型会把思维链放在 reasoning_content（DeepSeek 原生字段），正文里没有
    const think = typeof m.reasoning_content === "string" ? m.reasoning_content.trim() : "";
    if (m.role === "user") {
      if (!t) continue;
      msgs.push({ role: "user", time, text: t, tool: "" });
    } else if (m.role === "assistant") {
      const calls = [];
      const fulls = [];
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || tc;
          calls.push(`${fn.name || "?"}(${firstText(String(fn.arguments || ""), 70)})`);
          fulls.push(toolFullOf({ name: fn.name, arguments: fn.arguments }));
        }
      }
      if (!t && !calls.length && !think) continue;
      msgs.push(withFull(
        { role: "assistant", time, text: t, tool: calls.join("  "), think }, fulls));
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
  const think = thinkFromBlocks(content);
  const tools = [];
  const fulls = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b === "object" && b.type === "tool_use") {
        tools.push(toolHint(b));
        fulls.push(toolFullOf(b));
      }
    }
    // 纯 tool_result 的 user 回包，跳过
    if (o.type === "user" && content.some((b) => b && b.type === "tool_result") && !t) return;
  }
  if (o.type === "user" && (!t || isInject(t) || t.startsWith("<command-name>"))) return;
  if (!t && !tools.length && !think) return;
  const m = {
    role: o.type === "user" ? "user" : "assistant",
    time, text: t, tool: tools.join("  "), think, sidechain: !!o.isSidechain,
  };
  msgs.push(withFull(m, fulls));
}

function parseCodexLine(o, msgs) {
  if (o.type !== "response_item" || !o.payload) return;
  const p = o.payload;
  const time = o.timestamp ? String(o.timestamp) : isoTs(o.ts);
  // reasoning 事件：正文 content 是加密的（encrypted_content），只有 summary
  // 里的 summary_text 可读，拿它当思考过程。空 summary 直接丢弃。
  if (p.type === "reasoning") {
    const think = Array.isArray(p.summary)
      ? p.summary.map((x) => (x && x.text) || "").join("\n").trim() : "";
    if (think) msgs.push({ role: "assistant", time, text: "", tool: "", think });
    return;
  }
  if (p.type === "function_call") {
    const m = { role: "assistant", time, text: "", tool: toolHint(p) };
    msgs.push(withFull(m, [toolFullOf(p)]));
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
  const think = thinkFromBlocks(m.content);
  const tools = [];
  const fulls = [];
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === "toolCall") {
        tools.push(toolHint(b));
        fulls.push(toolFullOf(b));
      }
    }
  }
  if (!t && !tools.length && !think) return;
  if (m.role === "user" && isInject(t)) return;
  msgs.push(withFull({ role: m.role, time, text: t, tool: tools.join("  "), think }, fulls));
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
  // 思考：content 里 {type:"reasoning", text:"…"}（明文，需该轮开了思考强度）
  const think = o.type === "assistant/message" ? thinkFromBlocks(m.content) : "";

  // 上下文压缩 / 历史交接摘要：整条丢弃（见 config.js 的 DSH_DROP_PATTERNS 说明）
  if (t && DSH_DROP_PATTERNS.some((re) => re.test(t))) return;

  const tools = [];
  const fulls = [];
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b && b.type === "tool-call") {
        tools.push(toolHint(b));
        fulls.push(toolFullOf(b));
      }
    }
  }
  if (o.type === "user/message") {
    const u = dshStrip(t);
    if (!u) return; // 纯注入（Workspace 前缀 / OUT-OF-BAND 等）不显示
    msgs.push({ role: "user", time, text: u, tool: "" });
    return;
  }
  if (!t && !tools.length && !think) return;
  // assistant 也过一遍剥离：末尾常有 `[Workspace::v1: …]` + 再次重述的活跃请求
  const a = dshStrip(t);
  if (!a && !tools.length && !think) return;
  msgs.push(withFull({ role: "assistant", time, text: a, tool: tools.join("  "), think }, fulls));
}

// 整条流水线统一收尾：先剥内联 <think> 标签，再合并纯思考消息，最后限长。
// 顺序不能反 —— 剥完标签才会暴露出「只剩思考、没有正文」的消息，
// 这类正是 mergeThink 要并到下一条回答上的。
function finish(msgs) {
  return truncate(mergeThink(stripInlineThink(msgs)));
}

/* 按消息顺序扫内联 <think> 标签，把标签内内容挪进 msg.think。
   状态跨消息携带（实测大部分标签是跨条闭合的，逐条独立判定会漏）。
   扫完 text 为空的处理交给 mergeThink —— 它专门收这种纯思考卡。 */
function stripInlineThink(msgs) {
  const state = { inThink: false };
  const out = [];
  for (const m of msgs) {
    if (!m.text || m.text.indexOf("think") < 0) {
      // 没有标签字样：若正处在未闭合的思考块里，整条都是思考正文
      if (state.inThink && m.text) {
        m.think = m.think ? m.think + "\n\n" + m.text : m.text;
        m.text = "";
      }
      out.push(m);
      continue;
    }
    const r = scanInlineThink(m.text, state);
    m.text = r.text;
    if (r.think) m.think = m.think ? r.think + "\n\n" + m.think : r.think;
    // 标签内内容为空、正文也被吃光时这条就没意义了（孤立 </think> 就是这种）
    if (!m.text && !m.think && !m.tool) continue;
    out.push(m);
  }
  return out;
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
    return finish(parseHermes(o));
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
    return finish(msgs);
  }
  const parseLine = LINE_PARSERS[tool] || parsePiLine;
  const lines = await readLines(file);
  const msgs = [];
  for (const l of lines) {
    const o = tryJson(l);
    if (!o) continue;
    parseLine(o, msgs);
  }
  return finish(msgs);
}

module.exports = { parseSession, toolHint };
