// 协议翻译：chat / responses / anthropic 三族互转
//
// 为什么需要这一层：magpie 的核心价值是「任何 agent 用任何供应商」。
// claude 只会发 Anthropic Messages，codex 只会发 Responses，但供应商可能
// 只给 Chat Completions。没有翻译就只能同族对接，池子的意义就没了。
//
// 设计：以 **OpenAI Chat** 作为内部中间格式（canonical）。
//   入口：客户端协议 → canonical
//   出口：canonical → 上游协议
//   回程：上游响应 → canonical → 客户端协议
// 这样 N 个协议只需 2N 个转换函数，而不是 N² 个。
//
// 覆盖面（这些是实测会遇到的，不是照抄规范）：
//   - system 提示：chat 用 role:system 消息；anthropic 用顶层 system；responses 用 instructions
//   - 工具调用：chat 的 tool_calls ↔ anthropic 的 tool_use/tool_result ↔ responses 的 function_call
//   - 图片：chat 的 image_url ↔ anthropic 的 image/source.base64 ↔ responses 的 input_image
//   - 推理强度：chat 的 reasoning_effort ↔ anthropic 的 thinking.budget_tokens
//   - 流式：三家的 SSE 事件结构完全不同，见 streamTranslate
//
// 明确**不**支持的：Gemini 原生（contents/parts）。本机没有 agent 走 gemini 原生，
// 翻译它等于白写一套四不像。遇到就报错，让人知道边界在哪。
const { PROTOCOL_LABEL } = require("./store");

// ---- 工具 ----

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!b) return "";
      if (typeof b === "string") return b;
      if (typeof b.text === "string") return b.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

// anthropic 的 thinking 档位 → 预算 token。
// 三家里只有 anthropic 用绝对 token 数表示推理预算，chat 用档位字符串。
// 这些数字取自 anthropic 官方档位，不是随手估的。
const THINK_BUDGET = { low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 64000 };
function budgetToEffort(n) {
  const b = Number(n) || 0;
  if (!b) return "";
  if (b <= 3072) return "low";
  if (b <= 10000) return "medium";
  if (b <= 20000) return "high";
  if (b <= 40000) return "xhigh";
  return "max";
}

// ---- 图片 ----

function chatImageToAnthropic(block) {
  const url = (block && block.image_url && (block.image_url.url || block.image_url)) || "";
  const m = String(url).match(/^data:([^;]+);base64,(.*)$/);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

function anthropicImageToChat(block) {
  const s = (block && block.source) || {};
  if (s.type === "base64") return { type: "image_url", image_url: { url: `data:${s.media_type || "image/png"};base64,${s.data || ""}` } };
  if (s.type === "url" && s.url) return { type: "image_url", image_url: { url: s.url } };
  return null;
}

// ---- 入口：客户端协议 → canonical(chat) ----

// anthropic Messages → chat
function anthropicToChat(body) {
  const msgs = [];
  // anthropic 的 system 是顶层字段（可字符串可块数组），chat 里必须变成一条消息
  const sys = textOf(body.system);
  if (sys) msgs.push({ role: "system", content: sys });

  for (const m of body.messages || []) {
    if (m.role === "assistant") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b, i) => ({
        id: b.id || "call_" + i,
        type: "function",
        function: { name: b.name || "", arguments: JSON.stringify(b.input || {}) },
      }));
      const think = blocks.filter((b) => b.type === "thinking").map((b) => b.thinking).join("");
      const out = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length) out.tool_calls = toolCalls;
      // 思考内容放进 reasoning_content：万一转回 anthropic 能还原；
      // 转给 chat 系上游时会带过去，多数中转站会忽略这个字段
      if (think) out.reasoning_content = think;
      msgs.push(out);
    } else if (m.role === "user") {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content || "") }];
      // tool_result 必须变成独立的 role:tool 消息，不能混在 user 里
      const results = blocks.filter((b) => b.type === "tool_result");
      const rest = blocks.filter((b) => b.type !== "tool_result");
      for (const r of results) {
        msgs.push({
          role: "tool",
          tool_call_id: r.tool_use_id || "",
          content: textOf(r.content) || (typeof r.content === "string" ? r.content : ""),
        });
      }
      if (rest.length) {
        const parts = [];
        for (const b of rest) {
          if (b.type === "text") parts.push({ type: "text", text: b.text || "" });
          else if (b.type === "image") {
            const c = anthropicImageToChat(b);
            if (c) parts.push(c);
          }
        }
        const onlyText = parts.every((p) => p.type === "text");
        msgs.push({ role: "user", content: onlyText ? parts.map((p) => p.text).join("\n") : parts });
      }
    }
  }

  const out = { model: body.model, messages: msgs, stream: !!body.stream };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop_sequences) out.stop = body.stop_sequences;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter((t) => t.name).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
    const tc = body.tool_choice;
    if (tc && tc.type === "any") out.tool_choice = "required";
    else if (tc && tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc && tc.type === "auto") out.tool_choice = "auto";
  }

  // thinking → reasoning_effort
  if (body.thinking && body.thinking.budget_tokens) {
    const e = budgetToEffort(body.thinking.budget_tokens);
    if (e) out.reasoning_effort = e;
  }
  return out;
}

// responses → chat
function responsesToChat(body) {
  const msgs = [];
  if (body.instructions) msgs.push({ role: "system", content: textOf(body.instructions) });

  // responses 的 input 可以是字符串，也可以是 item 数组
  if (typeof body.input === "string") {
    msgs.push({ role: "user", content: body.input });
  } else {
    for (const item of body.input || []) {
      const type = item.type || (item.role ? "message" : "");
      if (type === "message") {
        const c = item.content;
        const parts = [];
        for (const b of Array.isArray(c) ? c : [{ type: "text", text: String(c || "") }]) {
          if (b.type === "input_text" || b.type === "text" || b.type === "output_text") {
            parts.push({ type: "text", text: b.text || "" });
          } else if (b.type === "input_image") {
            const url = b.image_url || b.url || "";
            if (url) parts.push({ type: "image_url", image_url: { url } });
          }
        }
        const onlyText = parts.every((p) => p.type === "text");
        msgs.push({
          role: item.role === "assistant" ? "assistant" : "user",
          content: onlyText ? parts.map((p) => p.text).join("\n") : parts,
        });
      } else if (type === "function_call") {
        // 连续多个 function_call 要合并到同一条 assistant 消息的 tool_calls 里
        const last = msgs[msgs.length - 1];
        const call = {
          id: item.call_id || item.id || "",
          type: "function",
          function: { name: item.name || "", arguments: item.arguments || "{}" },
        };
        if (last && last.role === "assistant" && last.tool_calls) last.tool_calls.push(call);
        else msgs.push({ role: "assistant", content: null, tool_calls: [call] });
      } else if (type === "function_call_output") {
        msgs.push({ role: "tool", tool_call_id: item.call_id || "", content: textOf(item.output) || String(item.output ?? "") });
      } else if (type === "reasoning") {
        const t = (item.summary || []).map((s) => s.text).join("\n");
        if (t) {
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") last.reasoning_content = t;
        }
      }
    }
  }

  const out = { model: body.model, messages: msgs, stream: !!body.stream };
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter((t) => t.name || (t.function && t.function.name)).map((t) => {
      const f = t.function || t;
      return {
        type: "function",
        function: { name: f.name, description: f.description || "", parameters: f.parameters || { type: "object", properties: {} } },
      };
    });
  }
  if (body.reasoning && body.reasoning.effort) out.reasoning_effort = body.reasoning.effort;
  return out;
}

// 统一入口：把客户端请求体转成 canonical(chat)
function toCanonical(protocol, body) {
  if (protocol === "chat") return body;
  if (protocol === "anthropic") return anthropicToChat(body);
  if (protocol === "responses") return responsesToChat(body);
  throw new Error("不支持的入口协议: " + protocol);
}

// ---- 出口：canonical(chat) → 上游协议 ----

function chatToAnthropic(body, { model } = {}) {
  const out = { model: model || body.model, messages: [], max_tokens: body.max_tokens || 8192 };

  for (const m of body.messages || []) {
    if (m.role === "system") {
      // 多条 system 合并成顶层 system，anthropic 只认一个
      const t = textOf(m.content);
      out.system = out.system ? out.system + "\n\n" + t : t;
      continue;
    }
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.tool_call_id || "", content: textOf(m.content) };
      // 连续的 tool 结果要合并进同一条 user 消息
      const last = out.messages[out.messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.messages.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const blocks = [];
      if (m.reasoning_content) blocks.push({ type: "thinking", thinking: String(m.reasoning_content) });
      const t = textOf(m.content);
      if (t) blocks.push({ type: "text", text: t });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function && tc.function.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: tc.id || "", name: (tc.function && tc.function.name) || "", input });
      }
      if (blocks.length) out.messages.push({ role: "assistant", content: blocks });
      continue;
    }
    // user
    const content = m.content;
    if (typeof content === "string") { out.messages.push({ role: "user", content }); continue; }
    const blocks = [];
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === "text") blocks.push({ type: "text", text: b.text || "" });
      else if (b.type === "image_url") {
        const c = chatImageToAnthropic(b);
        if (c) blocks.push(c);
      }
    }
    out.messages.push({ role: "user", content: blocks.length === 1 && blocks[0].type === "text" ? blocks[0].text : blocks });
  }

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter((t) => t.function && t.function.name).map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
    const tc = body.tool_choice;
    if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc && tc.type === "function") out.tool_choice = { type: "tool", name: tc.function && tc.function.name };
  }

  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream) out.stream = true;

  // reasoning_effort → thinking.budget_tokens
  const eff = body.reasoning_effort;
  if (eff === "none") { /* 关了就不加 thinking */ }
  else if (eff && THINK_BUDGET[eff]) {
    out.thinking = { type: "enabled", budget_tokens: THINK_BUDGET[eff] };
    // anthropic 要求 budget 小于 max_tokens，否则 400
    if (out.max_tokens <= out.thinking.budget_tokens) {
      out.max_tokens = out.thinking.budget_tokens + 4096;
    }
  }
  return out;
}

function chatToResponses(body, { model } = {}) {
  const out = { model: model || body.model, input: [], stream: !!body.stream };
  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;

  const sysParts = [];
  for (const m of body.messages || []) {
    if (m.role === "system") { sysParts.push(textOf(m.content)); continue; }
    if (m.role === "tool") {
      out.input.push({ type: "function_call_output", call_id: m.tool_call_id || "", output: textOf(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      const t = textOf(m.content);
      if (t) out.input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: t }] });
      for (const tc of m.tool_calls || []) {
        out.input.push({
          type: "function_call", call_id: tc.id || "", name: (tc.function && tc.function.name) || "",
          arguments: (tc.function && tc.function.arguments) || "{}",
        });
      }
      continue;
    }
    const content = m.content;
    if (typeof content === "string") {
      out.input.push({ type: "message", role: "user", content: [{ type: "input_text", text: content }] });
    } else {
      const parts = [];
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === "text") parts.push({ type: "input_text", text: b.text || "" });
        else if (b.type === "image_url") parts.push({ type: "input_image", image_url: b.image_url && b.image_url.url || "" });
      }
      out.input.push({ type: "message", role: "user", content: parts });
    }
  }
  if (sysParts.filter(Boolean).length) out.instructions = sysParts.filter(Boolean).join("\n\n");

  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.filter((t) => t.function && t.function.name).map((t) => ({
      type: "function", name: t.function.name, description: t.function.description || "",
      parameters: t.function.parameters || { type: "object", properties: {} },
    }));
  }
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort };
  return out;
}

// canonical(chat) → 上游协议
function fromCanonical(protocol, body, opts) {
  if (protocol === "chat") {
    // chat 直连：只换模型名
    if (opts && opts.model && body.model !== opts.model) return { ...body, model: opts.model };
    return body;
  }
  if (protocol === "anthropic") return chatToAnthropic(body, opts);
  if (protocol === "responses") return chatToResponses(body, opts);
  throw new Error("不支持的上游协议: " + protocol);
}

// ---- 响应：上游 → canonical → 客户端 ----

// 上游 anthropic 非流式响应 → chat 格式
function anthropicRespToChat(obj, model) {
  const content = obj.content || [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const think = content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("");
  const toolCalls = content.filter((b) => b.type === "tool_use").map((b, i) => ({
    id: b.id || "call_" + i, type: "function",
    function: { name: b.name || "", arguments: JSON.stringify(b.input || {}) },
  }));
  const stopMap = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  const msg = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (think) msg.reasoning_content = think;
  const u = obj.usage || {};
  return {
    id: obj.id || "chatcmpl-magpie",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || obj.model || "",
    choices: [{ index: 0, message: msg, finish_reason: stopMap[obj.stop_reason] || "stop" }],
    usage: {
      prompt_tokens: Number(u.input_tokens) || 0,
      completion_tokens: Number(u.output_tokens) || 0,
      total_tokens: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0),
      prompt_tokens_details: { cached_tokens: Number(u.cache_read_input_tokens) || 0 },
    },
  };
}

// 上游 responses 非流式响应 → chat 格式
function responsesRespToChat(obj, model) {
  const items = obj.output || [];
  const text = items.filter((i) => i.type === "message")
    .map((i) => (i.content || []).filter((c) => c.type === "output_text").map((c) => c.text).join("")).join("");
  const toolCalls = items.filter((i) => i.type === "function_call").map((i) => ({
    id: i.call_id || i.id || "", type: "function",
    function: { name: i.name || "", arguments: i.arguments || "{}" },
  }));
  const u = obj.usage || {};
  const msg = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const incomplete = obj.status === "incomplete";
  return {
    id: obj.id || "chatcmpl-magpie",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || obj.model || "",
    choices: [{
      index: 0, message: msg,
      finish_reason: toolCalls.length ? "tool_calls" : incomplete ? "length" : "stop",
    }],
    usage: {
      prompt_tokens: Number(u.input_tokens) || 0,
      completion_tokens: Number(u.output_tokens) || 0,
      total_tokens: Number(u.total_tokens) || ((Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0)),
      prompt_tokens_details: { cached_tokens: Number((u.input_tokens_details || {}).cached_tokens) || 0 },
    },
  };
}

// canonical(chat) → 客户端 anthropic
function chatToAnthropicResp(obj, model) {
  const ch = (obj.choices || [])[0] || {};
  const m = ch.message || {};
  const blocks = [];
  if (m.reasoning_content) blocks.push({ type: "thinking", thinking: String(m.reasoning_content) });
  if (m.content) blocks.push({ type: "text", text: String(m.content) });
  for (const tc of m.tool_calls || []) {
    let input = {};
    try { input = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch { input = {}; }
    blocks.push({ type: "tool_use", id: tc.id || "", name: (tc.function && tc.function.name) || "", input });
  }
  const stopMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
  const u = obj.usage || {};
  return {
    id: obj.id || "msg_magpie",
    type: "message",
    role: "assistant",
    model: model || obj.model || "",
    content: blocks,
    stop_reason: stopMap[ch.finish_reason] || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(u.prompt_tokens) || 0,
      output_tokens: Number(u.completion_tokens) || 0,
      cache_read_input_tokens: Number((u.prompt_tokens_details || {}).cached_tokens) || 0,
      cache_creation_input_tokens: 0,
    },
  };
}

// canonical(chat) → 客户端 responses
function chatToResponsesResp(obj, model) {
  const ch = (obj.choices || [])[0] || {};
  const m = ch.message || {};
  const output = [];
  if (m.content) {
    output.push({
      type: "message", id: "msg_" + Date.now(), role: "assistant", status: "completed",
      content: [{ type: "output_text", text: String(m.content), annotations: [] }],
    });
  }
  for (const tc of m.tool_calls || []) {
    output.push({
      type: "function_call", id: "fc_" + Date.now(), call_id: tc.id || "",
      name: (tc.function && tc.function.name) || "", arguments: (tc.function && tc.function.arguments) || "{}",
      status: "completed",
    });
  }
  const u = obj.usage || {};
  return {
    id: obj.id || "resp_magpie",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model || obj.model || "",
    status: ch.finish_reason === "length" ? "incomplete" : "completed",
    output,
    usage: {
      input_tokens: Number(u.prompt_tokens) || 0,
      output_tokens: Number(u.completion_tokens) || 0,
      total_tokens: Number(u.total_tokens) || 0,
      input_tokens_details: { cached_tokens: Number((u.prompt_tokens_details || {}).cached_tokens) || 0 },
      output_tokens_details: { reasoning_tokens: Number((u.completion_tokens_details || {}).reasoning_tokens) || 0 },
    },
  };
}

// 上游响应体（任一协议）→ canonical(chat)
function respToCanonical(protocol, obj, model) {
  if (protocol === "chat") {
    if (model && obj.model !== model) obj.model = model;
    return obj;
  }
  if (protocol === "anthropic") return anthropicRespToChat(obj, model);
  if (protocol === "responses") return responsesRespToChat(obj, model);
  return obj;
}

// canonical(chat) → 客户端响应体
function canonicalToResp(protocol, obj, model) {
  if (protocol === "chat") return obj;
  if (protocol === "anthropic") return chatToAnthropicResp(obj, model);
  if (protocol === "responses") return chatToResponsesResp(obj, model);
  return obj;
}

module.exports = {
  toCanonical, fromCanonical, respToCanonical, canonicalToResp,
  anthropicToChat, responsesToChat, chatToAnthropic, chatToResponses,
  anthropicRespToChat, responsesRespToChat, chatToAnthropicResp, chatToResponsesResp,
  textOf, THINK_BUDGET, PROTOCOL_LABEL,
};
