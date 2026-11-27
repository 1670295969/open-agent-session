// 网关转发：/gw/v1/* → 供应商，协议翻译 + 多 key 故障转移 + 流式转换 + 记账
//
// 与 magpie 的对应关系（2026-11-27 读其 README 与 docs/reference.md 校准）：
//   magpie /v1/chat/completions  ←→  这里 /gw/v1/chat/completions
//   magpie /v1/responses         ←→  这里 /gw/v1/responses
//   magpie /v1/messages          ←→  这里 /gw/v1/messages
//   magpie /v1/models            ←→  这里 /gw/v1/models
//   magpie 端口 3425 独立进程     ←→  这里挂在 OpenSession 同一端口 /gw 前缀下
//
// 为什么不分独立端口：OpenSession 本身就是常驻的 localhost 服务，
// 再开一个端口等于多一个要管的东西（防火墙、systemd、健康检查）。
// /gw 前缀同样能被任何 agent 配 base_url，功能上没有区别。
//
// 流式翻译是最容易出错的地方，这里统一走「上游事件 → canonical chunk →
// 客户端事件」三段：上游格式差异在 parseUpstreamChunk 里消化，客户端格式
// 差异在 emitClientChunk 里生成。非翻译（同协议直通）时整块透传，
// 避免无谓的解析开销与格式失真。
const http = require("http");
const https = require("https");
const { URL } = require("url");
const store = require("./store");
const tr = require("./translate");

// 上游整体超时。大模型排队 + 长上下文时首字节可能很久
// （实测 gpt-6.2 在 high effort 下 ttft 到过 54 秒），给得比常规宽。
const UPSTREAM_TIMEOUT_MS = Number(process.env.OPENSESSION_GW_TIMEOUT) || 300000;
// SSE 解析缓冲上限：只是为了捞 usage，捞不到就罢了，
// 绝不能因为记账把内存吃穿
const SSE_CAP = 8 * 1024 * 1024;

function buildUrl(base, protocol, model) {
  let b = String(base || "").replace(/\/+$/, "");
  if (protocol === "anthropic") {
    // anthropic 基址有两种写法：https://host 与 https://host/v1
    return /\/(v1|v1beta)$/i.test(b) ? b + "/messages" : b + "/v1/messages";
  }
  if (!/\/v\d+$/i.test(b)) b += "/v1";
  return protocol === "responses" ? b + "/responses" : b + "/chat/completions";
}

// 客户端头 → 上游头。白名单，不整包转发：
// Host / Content-Length / Connection 这类逐跳头带过去会让上游行为异常。
function upstreamHeaders(reqHeaders, provider, key) {
  const h = {};
  for (const k of ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"]) {
    if (reqHeaders[k]) h[k] = reqHeaders[k];
  }
  if (!h["content-type"]) h["content-type"] = "application/json";
  h["authorization"] = "Bearer " + key;
  // anthropic 系上游两种头都发：官方认 x-api-key，中转站常只认 Bearer
  if (provider.anthropic) h["x-api-key"] = key;
  if (provider.anthropic && !h["anthropic-version"]) h["anthropic-version"] = "2023-06-01";
  // 供应商自定义头（magpie 的 header.<Name>=<value>）
  for (const [k, v] of Object.entries(provider.headers || {})) {
    if (v === "" || v == null) delete h[k.toLowerCase()];
    else h[k] = String(v);
  }
  return h;
}

function request(urlStr, method, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error("上游 URL 无效: " + urlStr)); }
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method, headers,
    }, (res) => resolve({ status: res.statusCode || 0, headers: res.headers, stream: res }));
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error("上游超时（" + Math.round(UPSTREAM_TIMEOUT_MS / 1000) + "s）")));
    req.on("error", reject);
    if (bodyBuf && bodyBuf.length) req.write(bodyBuf);
    req.end();
  });
}

// ---- 用量提取 ----

function usageFromJson(protocol, obj) {
  const u = (obj && (obj.usage || (obj.response && obj.response.usage))) || null;
  if (!u) return null;
  if (protocol === "anthropic") {
    return {
      in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0,
      cache_read: Number(u.cache_read_input_tokens) || 0,
      cache_write: Number(u.cache_creation_input_tokens) || 0,
      reasoning: 0,
    };
  }
  const det = u.input_tokens_details || u.prompt_tokens_details || {};
  const odet = u.output_tokens_details || u.completion_tokens_details || {};
  return {
    in: Number(u.prompt_tokens ?? u.input_tokens) || 0,
    out: Number(u.completion_tokens ?? u.output_tokens) || 0,
    cache_read: Number(det.cached_tokens ?? u.cache_read_input_tokens) || 0,
    cache_write: Number(u.cache_creation_input_tokens) || 0,
    reasoning: Number(odet.reasoning_tokens) || 0,
  };
}

// 从 SSE 文本捞 usage。三家上报时机不同，必须全扫：
//   anthropic  message_start 给 input、message_delta 给 output（两处，都是完整值）
//   responses  response.completed 里给全量
//   chat       流式默认**不给**，需请求时带 stream_options.include_usage
function usageFromSse(protocol, text) {
  let inT = 0, outT = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0, found = false;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    const p = s.slice(5).trim();
    if (!p || p === "[DONE]") continue;
    let o;
    try { o = JSON.parse(p); } catch { continue; }
    const cand = o.usage || (o.message && o.message.usage) || (o.response && o.response.usage);
    if (!cand) continue;
    found = true;
    const g = usageFromJson(protocol, { usage: cand });
    // 直接覆盖不累加：这三家给的都是「当前总量的完整值」，不是增量
    if (g.in) inT = g.in;
    if (g.out) outT = g.out;
    if (g.cache_read) cacheRead = g.cache_read;
    if (g.cache_write) cacheWrite = g.cache_write;
    if (g.reasoning) reasoning = g.reasoning;
  }
  return found ? { in: inT, out: outT, cache_read: cacheRead, cache_write: cacheWrite, reasoning } : null;
}

// 流式且上游不给 usage 时的兜底：字符数 / 4。
// 精度不重要（不参与计费），只用于界面上的量级对比；
// 记账行里会标 estimated:true，避免和上游真值混淆。
function estimateTokens(buf) {
  const n = Math.round(String(buf || "").length / 4);
  return n;
}

// ---- 请求处理 ----

function checkToken(req) {
  const want = process.env.OPENSESSION_GW_TOKEN || "";
  if (!want) return true;   // 未设口令：本机自用，不校验
  const h = req.headers || {};
  const bearer = String(h.authorization || "").replace(/^Bearer\s+/i, "").trim();
  return bearer === want || String(h["x-api-key"] || "") === want;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); reject(new Error("请求体过大")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

function retriable(status) {
  // 只重试 429 / 408 / 5xx。
  // 401/403 是密钥问题、400 是请求问题 —— 重试只会把真正的错误
  // 拖到超时之后才返回，用户等半天看到「超时」而不是「密钥无效」。
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

function errBody(type, message, extra = {}) {
  return { error: { type, message, ...extra } };
}

// 主动解析一条上游协议。客户端协议与上游协议相同时走直通。
function parseClientProtocol(pathname) {
  if (pathname === "/gw/v1/messages" || pathname === "/messages") return "anthropic";
  if (pathname === "/gw/v1/responses" || pathname === "/responses") return "responses";
  return "chat";
}

// 主入口
async function forward(req, res, { protocol, apiPath }) {
  if (!checkToken(req)) return json(res, 401, errBody("unauthorized", "网关口令无效（OPENSESSION_GW_TOKEN）"));

  const cfg = store.load();
  if (!cfg.enabled) {
    return json(res, 503, errBody("gateway_disabled",
      "网关未启用：在「网关」页打开开关，或 PUT /api/gw/settings {enabled:true}"));
  }

  let bodyBuf;
  try { bodyBuf = await readBody(req); }
  catch (e) { return json(res, 413, errBody("bad_request", String(e.message || e))); }

  let clientBody;
  try { clientBody = JSON.parse(bodyBuf.toString("utf8") || "{}"); }
  catch { return json(res, 400, errBody("bad_request", "请求体不是合法 JSON")); }

  const model = String(clientBody.model || "");
  if (!model) return json(res, 400, errBody("bad_request", "请求体缺少 model 字段"));

  // 候选链：多 key / 多供应商 / 路由组都展开成一条扁平链，
  // 「额度用完换账号」和「换供应商」就是同一套遍历
  const chain = store.resolve(model);
  if (!chain.length) {
    return json(res, 404, errBody("model_not_found",
      `没有可用的供应商能提供 ${model}。检查供应商是否启用、模型清单是否包含它、密钥是否已配。`,
      { model }));
  }

  const wantStream = !!clientBody.stream;
  const canonicalReq = tr.toCanonical(protocol, clientBody);

  let lastErr = null;
  let lastStatus = 0;
  let triedCount = 0;

  for (let ci = 0; ci < chain.length; ci++) {
    const cand = chain[ci];
    const provider = cand.provider;
    // 按客户端要的协议挑上游基址；没有同协议的基址就走翻译
    const pick = store.baseFor(provider, protocol);
    if (!pick) continue;

    // 上游请求体：先按「客户端协议 → canonical」已经转好，
    // 再按「canonical → 上游协议」转出去。同协议时这两步都是恒等变换，
    // 但**还是走一遍**：模型名要换（裸名 → 真名），
    // 而且 responses 的 input 结构不能被 chat 直通污染。
    let upstreamBody;
    try {
      upstreamBody = tr.fromCanonical(pick.protocol, canonicalReq, { model: cand.model });
    } catch (e) {
      lastErr = e;
      continue;
    }
    // 流式请求统一要求上游回 usage，否则记账只能靠估
    if (wantStream && pick.protocol === "chat") {
      upstreamBody.stream_options = { ...(upstreamBody.stream_options || {}), include_usage: true };
    }
    const outBuf = Buffer.from(JSON.stringify(upstreamBody), "utf8");

    const url = buildUrl(pick.base, pick.protocol, cand.model);
    const headers = upstreamHeaders(req.headers, provider, cand.key);
    headers["content-length"] = outBuf.length;
    if (wantStream) headers["accept"] = "text/event-stream";

    const tries = 1 + (cfg.maxRetries || 0);
    for (let t = 0; t < tries; t++) {
      triedCount++;
      const started = Date.now();
      let up;
      try {
        up = await request(url, "POST", headers, outBuf);
      } catch (e) {
        lastErr = e;
        store.recordUsage({
          provider: provider.id, providerKeyName: cand.keyName, model: cand.model,
          status: 0, ms: Date.now() - started, err: String(e.message || e).slice(0, 120),
          err_type: "connect", wire: pick.protocol,
        });
        continue;   // 连接层失败：同一家重试
      }

      const canFallThrough = (t < tries - 1) || (ci < chain.length - 1);
      if (retriable(up.status) && canFallThrough) {
        store.recordUsage({
          provider: provider.id, providerKeyName: cand.keyName, model: cand.model,
          sent_model: cand.model, status: up.status, ms: Date.now() - started,
          err: "upstream " + up.status, err_type: "retriable",
          wire: pick.protocol, tries: triedCount, retried: triedCount > 1 ? 1 : 0,
        });
        up.stream.resume();
        lastStatus = up.status;
        lastErr = new Error(`上游 ${up.status}`);
        continue;
      }

      return pipeThrough(res, up, {
        provider, cand, protocol, upstreamProtocol: pick.protocol,
        started, wantStream, triedCount, chainLen: chain.length,
        reqBodyLen: bodyBuf.length,
      });
    }
  }

  return json(res, lastStatus >= 400 ? lastStatus : 502, errBody(
    "upstream_unavailable",
    lastErr ? String(lastErr.message || lastErr) : "所有供应商均不可用",
    { tried: chain.map((c) => c.providerId + "/" + c.model) }
  ));
}

// 把上游响应接到客户端，同时旁路记账。
//
// 关键：**不能先读完再回**。流式的价值就在首字节立刻到，
// await 整个响应体等于把流式变成非流式（用户长时间看空白）。
// 所以边转发边累积一份解析副本。
function pipeThrough(res, up, ctx) {
  const { provider, cand, protocol, upstreamProtocol, started, wantStream, triedCount } = ctx;
  const status = up.status || 0;
  const needTranslate = protocol !== upstreamProtocol;
  const isSse = String(up.headers["content-type"] || "").includes("text/event-stream");

  // 响应头照搬，剔除三类：
  //   content-length      —— 翻译后长度会变
  //   content-encoding    —— Node http 不自动解压，透传 gzip 客户端看到乱码
  //   transfer-encoding   —— 分块方式由我们决定
  const outHeaders = {};
  for (const [k, v] of Object.entries(up.headers || {})) {
    const lk = k.toLowerCase();
    if (["content-length", "content-encoding", "transfer-encoding", "connection"].includes(lk)) continue;
    outHeaders[k] = v;
  }
  if (needTranslate) {
    outHeaders["content-type"] = isSse ? "text/event-stream; charset=utf-8" : "application/json; charset=utf-8";
  }

  let collected = "";
  let capped = false;
  let finished = false;
  let firstByteMs = 0;

  const record = (err) => {
    if (finished) return;
    finished = true;
    const ms = Date.now() - started;
    if (err) {
      store.recordUsage({
        provider: provider.id, providerKeyName: cand.keyName, model: cand.model,
        sent_model: cand.model, status: status || 0, ms,
        err: String(err.message || err).slice(0, 200), err_type: "stream",
        wire: upstreamProtocol, tries: triedCount, ttft_ms: firstByteMs || 0,
      });
      return;
    }
    let u = null;
    if (!isSse) {
      try { u = usageFromJson(upstreamProtocol, JSON.parse(collected)); } catch { u = null; }
    } else {
      u = usageFromSse(upstreamProtocol, collected);
    }
    store.recordUsage({
      provider: provider.id, providerKeyName: cand.keyName, model: cand.model,
      sent_model: cand.model, wire: upstreamProtocol, status, ms,
      ttft_ms: firstByteMs || 0,
      in: u ? u.in : estimateTokens(ctxReqText(ctx)),
      out: u ? u.out : (isSse ? estimateTokens(collected) : 0),
      cache_read: u ? u.cache_read : 0,
      cache_write: u ? u.cache_write : 0,
      reasoning: u ? u.reasoning : 0,
      // 标记数字来源：上游给的 or 估的。界面要能区分，
      // 否则「网关统计和账单对不上」永远说不清
      estimated: !u,
      stream: !!wantStream,
      translated: needTranslate ? upstreamProtocol + ">" + protocol : "",
      tries: triedCount,
      retried: triedCount > 1 ? 1 : 0,
    });
  };

  // ---- 非流式：整包读完 → 翻译 → 回 ----
  if (!isSse) {
    const chunks = [];
    up.stream.on("data", (c) => { chunks.push(c); if (chunks.length === 1) firstByteMs = Date.now() - started; });
    up.stream.on("error", (e) => {
      record(e);
      if (!res.writableEnded) json(res, 502, errBody("upstream_error", String(e.message || e)));
    });
    up.stream.on("end", () => {
      const raw = Buffer.concat(chunks);
      collected = raw.toString("utf8");
      record(null);
      if (res.writableEnded) return;
      if (!needTranslate || status >= 400) {
        // 同协议直通，或上游报错：原样回，错误信息才有意义
        res.writeHead(status, outHeaders);
        res.end(raw);
        return;
      }
      let obj;
      try { obj = JSON.parse(collected); }
      catch {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(errBody("bad_upstream_response", "上游返回的不是合法 JSON")));
        return;
      }
      const canon = tr.respToCanonical(upstreamProtocol, obj, cand.model);
      const out = tr.canonicalToResp(protocol, canon, cand.model);
      const buf = Buffer.from(JSON.stringify(out), "utf8");
      outHeaders["content-length"] = buf.length;
      res.writeHead(status, outHeaders);
      res.end(buf);
    });
    return;
  }

  // ---- 流式 ----
  res.writeHead(status, outHeaders);
  if (!needTranslate) {
    // 同协议：整块透传。不做逐事件解析 —— 直通是最保真的，
    // 任何解析再序列化都会丢掉我们没建模的字段（上游 add 的新东西）
    up.stream.on("data", (c) => {
      if (!firstByteMs) firstByteMs = Date.now() - started;
      if (!capped && collected.length < SSE_CAP) {
        collected += c.toString("utf8");
        if (collected.length >= SSE_CAP) capped = true;
      }
      if (!res.writableEnded) res.write(c);
    });
    up.stream.on("end", () => { record(null); if (!res.writableEnded) res.end(); });
    up.stream.on("error", (e) => { record(e); if (!res.writableEnded) res.end(); });
    res.on("close", () => {
      if (!finished) { record(null); try { up.stream.destroy(); } catch { /* 已关 */ } }
    });
    return;
  }

  // 需要翻译：逐事件解析 → canonical → 客户端事件
  // 这里**必须**按行缓冲：SSE 事件可能跨 TCP chunk 边界，
  // 直接按 chunk 解析会把半截 JSON 当完整事件丢掉（表现为偶发内容缺失）
  const state = makeStreamState(protocol, cand.model);
  let buf = "";
  const onChunk = (chunk, flush) => {
    if (!firstByteMs) firstByteMs = Date.now() - started;
    const s = chunk.toString("utf8");
    if (!capped) {
      collected += s;
      if (collected.length >= SSE_CAP) capped = true;
    }
    buf += s;
    // 按 SSE 空行分帧；末尾残留留到下次（除非 flush）
    const frames = buf.split("\n\n");
    buf = flush ? "" : (frames.pop() || "");
    for (const frame of frames) {
      for (const out of translateFrame(frame, state)) {
        if (!res.writableEnded) res.write(out);
      }
    }
    if (flush && buf) {
      for (const out of translateFrame(buf, state)) {
        if (!res.writableEnded) res.write(out);
      }
      buf = "";
    }
  };

  up.stream.on("data", (c) => onChunk(c, false));
  up.stream.on("end", () => {
    onChunk(Buffer.from(""), true);
    for (const out of state.finish()) if (!res.writableEnded) res.write(out);
    record(null);
    if (!res.writableEnded) res.end();
  });
  up.stream.on("error", (e) => {
    record(e);
    if (!res.writableEnded) res.end();
  });
  res.on("close", () => {
    if (!finished) { record(null); try { up.stream.destroy(); } catch { /* 已关 */ } }
  });
}

function ctxReqText(ctx) { return ""; }

// 流式翻译状态机。
// 需要跨事件记住的东西：chat 的 tool_calls 要按 index 累积、
// anthropic 的 content_block 要按 index 累积、responses 的 output_item 要按 id 累积。
// 这些都不在单个事件里，所以必须留状态。
function makeStreamState(clientProtocol, model) {
  const id = (clientProtocol === "anthropic" ? "msg_" : clientProtocol === "responses" ? "resp_" : "chatcmpl-")
    + Math.random().toString(36).slice(2, 12);
  const created = Math.floor(Date.now() / 1000);
  // upstream 侧累积器
  const toolIdx = new Map();   // upstream tool index → 客户端 index
  const contentIdx = new Map();
  let started = false;         // 客户端首个事件是否已发
  let finished = false;        // 收尾事件是否已发（保证幂等）
  let textBuf = "";
  let thinkBuf = "";
  let finishReason = "stop";
  let usage = null;
  let nextToolIdx = 0;
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

  // ---- 客户端 anthropic 事件 ----
  function anthropicStart() {
    if (started) return "";
    started = true;
    return sse({
      type: "message_start",
      message: {
        id, type: "message", role: "assistant", model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  const api = {
    get model() { return model; },
    get id() { return id; },
    // chat 客户端：首个 delta 之前不需要前置事件，直接发就行
    begin() {
      if (clientProtocol === "anthropic") return anthropicStart();
      if (clientProtocol === "responses") {
        if (started) return "";
        started = true;
        return sse({ type: "response.created", response: { id, object: "response", model, status: "in_progress", output: [] } });
      }
      if (started) return "";
      started = true;
      // chat 的首个 chunk 带 role，客户端据此建消息
      return sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    },
    text(s) {
      if (!s) return [];
      textBuf += s;
      const out = [api.begin()].filter(Boolean);
      if (clientProtocol === "anthropic") {
        out.push(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: s } }));
      } else if (clientProtocol === "responses") {
        out.push(sse({ type: "response.output_text.delta", item_id: id + "_msg", output_index: 0, content_index: 0, delta: s }));
      } else {
        out.push(sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: s }, finish_reason: null }] }));
      }
      return out;
    },
    think(s) {
      if (!s) return [];
      thinkBuf += s;
      const out = [];
      if (clientProtocol === "anthropic") {
        out.push(sse({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: s } }));
      } else if (clientProtocol === "responses") {
        out.push(sse({ type: "response.reasoning_summary_text.delta", item_id: id + "_rs", output_index: 0, summary_index: 0, delta: s }));
      } else {
        // chat 系用 reasoning_content，多数客户端认这个字段
        out.push(sse({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { reasoning_content: s }, finish_reason: null }] }));
      }
      return out;
    },
    toolStart(upIdx, name) {
      if (!toolIdx.has(upIdx)) toolIdx.set(upIdx, nextToolIdx++);
      const i = toolIdx.get(upIdx);
      const out = [api.begin()].filter(Boolean);
      if (clientProtocol === "anthropic") {
        out.push(sse({ type: "content_block_start", index: i + 1, content_block: { type: "tool_use", id: "toolu_" + i, name, input: {} } }));
      } else if (clientProtocol === "responses") {
        out.push(sse({ type: "response.output_item.added", output_index: i + 1, item: { type: "function_call", id: "fc_" + i, call_id: "call_" + i, name, arguments: "" } }));
      } else {
        out.push(sse({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: "call_" + i, type: "function", function: { name, arguments: "" } }] }, finish_reason: null }],
        }));
      }
      return out;
    },
    toolArgs(upIdx, args) {
      if (!args) return [];
      const i = toolIdx.has(upIdx) ? toolIdx.get(upIdx) : 0;
      if (clientProtocol === "anthropic") {
        return [sse({ type: "content_block_delta", index: i + 1, delta: { type: "input_json_delta", partial_json: args } })];
      }
      if (clientProtocol === "responses") {
        return [sse({ type: "response.function_call_arguments.delta", item_id: "fc_" + i, output_index: i + 1, delta: args })];
      }
      return [sse({
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: args } }] }, finish_reason: null }],
      })];
    },
    setFinish(f) { finishReason = f || finishReason; },
    setUsage(u) { if (u) usage = u; },
    // anthropic 的 usage 分两段上报：message_start 只有 input（含 cache），
    // message_delta 只有 output。**不能整体覆盖** —— 覆盖会把 input 抹成 0，
    // 表现为流式请求的 prompt_tokens 永远是 0（非流式正常，所以很难发现）。
    mergeUsage(u) {
      if (!u) return;
      const cur = usage || { in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0 };
      usage = {
        in: u.in || cur.in,
        out: u.out || cur.out,
        cache_read: u.cache_read || cur.cache_read,
        cache_write: u.cache_write || cur.cache_write,
        reasoning: u.reasoning || cur.reasoning,
      };
    },
    // 结束：客户端各协议的收尾事件不一样，缺一个客户端就不会认为流结束。
    // 幂等 —— 上游可能在 [DONE] / message_stop 时结束，随后 stream 'end'
    // 还会再来一次；不幂等就会把整串收尾事件发两遍（客户端可能报错或重复统计）。
    finish() {
      if (finished) return [];
      finished = true;
      started = true;
      const out = [];
      if (clientProtocol === "anthropic") {
        // 关掉所有已开的块：0 是文本/思考块，1..n 是工具块
        out.push(sse({ type: "content_block_stop", index: 0 }));
        for (const i of toolIdx.values()) out.push(sse({ type: "content_block_stop", index: i + 1 }));
        const stopMap = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
        out.push(sse({
          type: "message_delta",
          delta: { stop_reason: stopMap[finishReason] || "end_turn", stop_sequence: null },
          usage: {
            input_tokens: usage ? usage.in : 0,
            output_tokens: usage ? usage.out : estimateTokens(textBuf),
            cache_read_input_tokens: usage ? usage.cache_read : 0,
          },
        }));
        out.push(sse({ type: "message_stop" }));
      } else if (clientProtocol === "responses") {
        if (textBuf) {
          out.push(sse({ type: "response.output_text.done", item_id: id + "_msg", output_index: 0, content_index: 0, text: textBuf }));
        }
        out.push(sse({
          type: "response.completed",
          response: {
            id, object: "response", model,
            status: finishReason === "length" ? "incomplete" : "completed",
            output: [], usage: usage ? {
              input_tokens: usage.in, output_tokens: usage.out,
              total_tokens: usage.in + usage.out,
              input_tokens_details: { cached_tokens: usage.cache_read },
              output_tokens_details: { reasoning_tokens: usage.reasoning },
            } : undefined,
          },
        }));
      } else {
        out.push(sse({
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: usage ? {
            prompt_tokens: usage.in, completion_tokens: usage.out,
            total_tokens: usage.in + usage.out,
            prompt_tokens_details: { cached_tokens: usage.cache_read },
          } : undefined,
        }));
        out.push("data: [DONE]\n\n");
      }
      return out;
    },
    contentIndex: contentIdx,
  };
  return api;
}

// 解析一帧上游 SSE，转成客户端事件
function translateFrame(frame, st) {
  const out = [];
  const lines = String(frame || "").split("\n");
  let eventName = "";
  let dataLines = [];
  for (const line of lines) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return out;
  const data = dataLines.join("\n");
  if (!data || data === "[DONE]") {
    if (data === "[DONE]") return st.finish();
    return out;
  }
  let o;
  try { o = JSON.parse(data); } catch { return out; }

  const type = o.type || eventName || "";

  // ---- 上游 chat 事件 ----
  if (o.choices) {
    const ch = o.choices[0] || {};
    const d = ch.delta || {};
    if (d.content) out.push(...st.text(d.content));
    if (d.reasoning_content) out.push(...st.think(d.reasoning_content));
    for (const tc of d.tool_calls || []) {
      const i = tc.index != null ? tc.index : 0;
      if (tc.function && tc.function.name) out.push(...st.toolStart(i, tc.function.name));
      if (tc.function && tc.function.arguments) out.push(...st.toolArgs(i, tc.function.arguments));
    }
    if (ch.finish_reason) st.setFinish(ch.finish_reason);
    if (o.usage) st.setUsage(usageFromJson("chat", o));
    return out;
  }

  // ---- 上游 anthropic 事件 ----
  if (type === "content_block_delta") {
    const d = o.delta || {};
    if (d.type === "text_delta" && d.text) out.push(...st.text(d.text));
    else if (d.type === "thinking_delta" && d.thinking) out.push(...st.think(d.thinking));
    else if (d.type === "input_json_delta" && d.partial_json) out.push(...st.toolArgs(o.index != null ? o.index : 0, d.partial_json));
    return out;
  }
  if (type === "content_block_start") {
    const b = o.content_block || {};
    if (b.type === "tool_use") out.push(...st.toolStart(o.index != null ? o.index : 0, b.name || ""));
    return out;
  }
  if (type === "message_delta") {
    const d = o.delta || {};
    const map = { end_turn: "stop", max_tokens: "length", tool_use: "tool_calls", stop_sequence: "stop" };
    if (d.stop_reason) st.setFinish(map[d.stop_reason] || "stop");
    if (o.usage) {
      // anthropic 的 input 在 message_start、output 在 message_delta，
      // 这里只补 output，input 必须保留 → 用 merge 而不是 set
      st.mergeUsage(usageFromJson("anthropic", { usage: o.usage }));
    }
    return out;
  }
  if (type === "message_start") {
    if (o.message && o.message.usage) {
      st.mergeUsage(usageFromJson("anthropic", { usage: o.message.usage }));
    }
    return out;
  }
  if (type === "message_stop") return st.finish();

  // ---- 上游 responses 事件 ----
  if (type === "response.output_text.delta") { out.push(...st.text(o.delta || "")); return out; }
  if (type === "response.reasoning_summary_text.delta") { out.push(...st.think(o.delta || "")); return out; }
  if (type === "response.output_item.added") {
    const it = o.item || {};
    if (it.type === "function_call") out.push(...st.toolStart(o.output_index != null ? o.output_index : 0, it.name || ""));
    return out;
  }
  if (type === "response.function_call_arguments.delta") {
    out.push(...st.toolArgs(o.output_index != null ? o.output_index : 0, o.delta || ""));
    return out;
  }
  if (type === "response.completed") {
    if (o.response && o.response.usage) {
      const u = usageFromJson("responses", o.response);
      if (u) st.setUsage(u);
    }
    return st.finish();
  }
  if (type === "response.failed" || type === "error") {
    return st.finish();
  }
  return out;
}

module.exports = {
  forward, checkToken, buildUrl, upstreamHeaders, usageFromJson, usageFromSse,
  readBody, json, parseClientProtocol, translateFrame, makeStreamState, retriable,
  UPSTREAM_TIMEOUT_MS,
};
