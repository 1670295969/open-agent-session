// 网关管理 API（/api/gw/*）
//
// 与转发层（/gw/v1/*）分开：一个是「给 agent 用的模型接口」，
// 一个是「给人用的管理接口」。混在一起会让鉴权边界变模糊
// （agent 的 key 不该能改供应商配置）。
const store = require("./store");
const proxy = require("./proxy");
const agents = require("./agents");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// 连通性测试：发一个最小请求，只关心能不能通、延迟多少。
// 每家按它有的协议挑一个测：有 chat 测 chat，只有 anthropic 测 anthropic。
// max_tokens 给 16，避免真花钱；但很多中转站对 max_tokens=1 会直接 400，
// 所以失败时把上游的原始报错带回去 —— 那才是用户要的信息。
//
// 🔴 不能只测 models[0]：实测 codex-for-me 有 13 个模型，其中 3 个已在上游下线
// （codex-auto-review / gpt-5.6 / gpt-6 都返回 503），而 models[0] 恰好是已下线的
// codex-auto-review —— 整家被误判成「挂了」，另外 10 个可用模型完全没测到。
// 所以默认要试到成功为止；失败时把「试过哪些模型、各自什么错」一并带回去，
// 让用户能分清「这家整站不通」与「只是这个模型下线了」。
async function testProvider(id, opts = {}) {
  const p = store.findProvider(id);
  if (!p) throw new Error("供应商不存在: " + id);
  const keys = store.keysOf(id);
  if (!keys.length) throw new Error("这家没有配置密钥");

  // 按这家**实际有**的协议挑一个测：优先 chat，其次 anthropic，最后 responses。
  // 🔴 基址字段名不统一（chat 存 url），不能写 p[proto] —— 会取到空串，
  // 拼出一个 "/v1/chat/completions" 这种相对路径，报「URL 无效」。
  // 这里复用 store.baseFor，让映射只有一处定义。
  const want = p.url ? "chat" : p.anthropic ? "anthropic" : "responses";
  const pick = store.baseFor(p, want);
  if (!pick) throw new Error("这家没有可用的协议基址");

  const all = (p.models || []).filter(Boolean);
  if (!all.length) throw new Error("这家没有模型清单，先在供应商里加一个模型名再测");

  // 指定了 model 就只测它；否则按顺序试，直到有一个通。
  // maxTries: 默认最多试 3 个 —— 13 个模型逐个打一遍太慢，而「前 3 个都不通」
  // 基本可以断定是整站问题，不是模型名的问题。
  const list = opts.model ? [String(opts.model)] : all;
  const maxTries = opts.model ? 1 : Math.min(3, list.length);

  const attempts = [];
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    const model = list[i];
    const r = await oneTest(p, pick, keys[0].key, model);
    attempts.push({ model, ok: r.ok, status: r.status, ms: r.ms, error: r.error });
    last = r;
    if (r.ok) break;
    // 401/403 是密钥问题，换模型也一样错，别白打
    if (r.status === 401 || r.status === 403) break;
  }

  return {
    ...last,
    // 试的第一个模型就是清单里的第一个；若换过，写清楚是第几个通的
    model: last.model,
    attempts,
    tried: attempts.length,
    total: list.length,
    // 「这家能用」的判据是至少一个模型通，不是第一个模型通
    ok: attempts.some((a) => a.ok),
  };
}

// 单个模型的探活
function oneTest(p, pick, key, model) {
  const proto = pick.protocol;
  const body = proto === "anthropic"
    ? { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }
    : proto === "responses"
      ? { model, input: "hi", max_output_tokens: 16 }
      : { model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] };

  const url = proxy.buildUrl(pick.base, proto, model);
  const started = Date.now();
  const http = require("http"), https = require("https");
  const { URL } = require("url");

  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { return resolve({ ok: false, status: 0, ms: 0, protocol: proto, model, url, error: "URL 无效: " + url }); }
    const mod = u.protocol === "https:" ? https : http;
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    const headers = proxy.upstreamHeaders({}, p, key);
    headers["content-length"] = buf.length;

    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search, method: "POST", headers,
    }, (r) => {
      let text = "";
      r.on("data", (c) => { if (text.length < 4000) text += c.toString("utf8"); });
      r.on("end", () => {
        const ms = Date.now() - started;
        const ok = r.statusCode >= 200 && r.statusCode < 300;
        let msg = "";
        if (!ok) {
          try {
            const o = JSON.parse(text);
            msg = (o.error && (o.error.message || o.error.type)) || text.slice(0, 200);
          } catch { msg = text.slice(0, 200); }
        }
        resolve({ ok, status: r.statusCode, ms, protocol: proto, model, url, error: ok ? "" : msg });
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error("超时 30s")));
    req.on("error", (e) => resolve({ ok: false, status: 0, ms: Date.now() - started, protocol: proto, model, url, error: String(e.message || e) }));
    req.write(buf);
    req.end();
  });
}

// 返回 true 表示已处理
async function handle(req, res, u) {
  const p = u.pathname;

  // ---- 总览 ----
  if (p === "/api/gw/state" && req.method === "GET") {
    const cfg = store.load();
    const since = Number(u.searchParams.get("since")) || 0;
    return json(res, 200, {
      enabled: cfg.enabled,
      defaultProvider: cfg.defaultProvider,
      maxRetries: cfg.maxRetries,
      failover: cfg.failover,
      usageKeepDays: cfg.usageKeepDays,
      providers: store.listProviders(),
      groups: store.listGroups(),
      models: store.modelCandidates(),
      stats: store.summarize({ sinceMs: since }),
      daily: store.daily({ days: 14 }),
      // 路由模式里有两档是降级的，界面要能如实标注
      routingModes: store.ROUTING_MODES.map((m) => ({
        id: m, effective: store.ROUTING_EFFECTIVE[m], degraded: m !== store.ROUTING_EFFECTIVE[m],
      })),
      protocols: store.PROTOCOLS.map((x) => ({ id: x, label: store.PROTOCOL_LABEL[x] })),
      configPath: store.configPath(),
      usagePath: store.usagePath(),
      // 网关对外的入口，前端直接拼给用户复制
      endpoints: {
        chat: "/gw/v1/chat/completions",
        responses: "/gw/v1/responses",
        anthropic: "/gw/v1/messages",
        models: "/gw/v1/models",
      },
      tokenRequired: !!process.env.OPENSESSION_GW_TOKEN,
    });
  }

  // ---- 供应商 ----
  if (p === "/api/gw/provider" && req.method === "POST") {
    try {
      const b = await readJsonBody(req);
      if (b.action === "add") return json(res, 200, { ok: true, provider: store.addProvider(b) });
      if (b.action === "update") return json(res, 200, { ok: true, provider: store.updateProvider(b.id, b) });
      if (b.action === "remove") { store.removeProvider(b.id); return json(res, 200, { ok: true }); }
      if (b.action === "removeKey") {
        return json(res, 200, { ok: true, keys: store.removeKey(b.id, Number(b.index) || 0) });
      }
      // 传 model 就只测那一个；不传则逐个试到通为止
      if (b.action === "test") return json(res, 200, await testProvider(b.id, { model: b.model }));
      if (b.action === "setKeys") {
        store.setKeys(b.id, b.keys);
        return json(res, 200, { ok: true, provider: store.publicProvider(store.findProvider(b.id)) });
      }
      return json(res, 400, { error: "未知 action: " + b.action });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ---- 路由组 ----
  if (p === "/api/gw/group" && req.method === "POST") {
    try {
      const b = await readJsonBody(req);
      if (b.action === "add") return json(res, 200, { ok: true, groups: store.addGroup(b) && store.listGroups() });
      if (b.action === "update") return json(res, 200, { ok: true, groups: store.updateGroup(b.name, b) });
      if (b.action === "remove") { store.removeGroup(b.name); return json(res, 200, { ok: true, groups: store.listGroups() }); }
      return json(res, 400, { error: "未知 action: " + b.action });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ---- 设置 ----
  if (p === "/api/gw/settings" && req.method === "PUT") {
    try {
      const b = await readJsonBody(req);
      const cfg = store.setSettings(b);
      return json(res, 200, {
        ok: true, enabled: cfg.enabled, defaultProvider: cfg.defaultProvider,
        maxRetries: cfg.maxRetries, failover: cfg.failover,
      });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ---- agent 指向 ----
  if (p === "/api/gw/agents" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "GET") {
      try { return json(res, 200, agents.detectAll()); }
      catch (e) { return json(res, 500, { error: String(e.message || e) }); }
    }
    try {
      const b = await readJsonBody(req);
      if (b.action === "apply") return json(res, 200, { ok: true, ...agents.applyTo(b.agent, b.model), detected: agents.detectAll() });
      if (b.action === "off") return json(res, 200, { ok: true, ...agents.turnOff(b.agent), detected: agents.detectAll() });
      if (b.action === "restore") return json(res, 200, { ok: true, ...agents.restore(b.agent), detected: agents.detectAll() });
      return json(res, 400, { error: "未知 action: " + b.action });
    } catch (e) { return json(res, 400, { error: String(e.message || e) }); }
  }

  // ---- 用量明细 ----
  // 🔴 DELETE 必须先判，且 GET 分支必须显式要求 method === "GET"：
  // 否则 DELETE /api/gw/usage 会被 GET 分支接走，返回 {rows:[]} 而不是清空 ——
  // 前端 toast 会说「用量已清空」，实际一行没删。
  if (p === "/api/gw/usage" && req.method === "DELETE") {
    try {
      require("fs").writeFileSync(store.usagePath(), "");
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  if (p === "/api/gw/usage" && req.method === "GET") {
    const since = Number(u.searchParams.get("since")) || 0;
    const limit = Math.min(2000, Number(u.searchParams.get("limit")) || 200);
    return json(res, 200, { rows: store.readUsage({ sinceMs: since, limit }).slice(-limit).reverse() });
  }

  return json(res, 404, { error: "not found" });
}

module.exports = { handle, testProvider };
