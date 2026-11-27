// 网关配置存储（供应商 / 路由组 / 用量）
//
// 语义对齐 yetone/magpie（2026-11-27 读 https://github.com/yetone/magpie 与其
// docs/reference.md 后校准）。刻意保留的三处 magpie 设计，因为它们是这套东西
// 真正好用的原因：
//
//   1. **一家供应商可挂多种协议基址**（url / anthropic / responses）。
//      不是「选一个协议」——moapi 这种中转站同时给 chat 和 anthropic，
//      cctq3 只给 responses。按传入端点选基址，缺的那种再翻译。
//   2. **多密钥**：同一家的多个 key / 多个账号按顺序故障转移，
//      额度用完自动换下一个，agent 看不到错误。
//   3. **路由组** `group/<name>`：把几家几个模型当成一个名字给 agent，
//      按 routing 模式挑成员。这比「改 agent 配置」灵活得多。
//
// 落盘：~/.config/opensession/gateway.json（密钥单独 600 权限）
// 用量：gateway-usage.jsonl，字段名与 magpie usage.jsonl 对齐，
//       以后想合并统计 / 导出不用重新映射。
const fs = require("fs");
const path = require("path");
const { HOME } = require("../config");

const CONFIG_DIR = path.join(HOME, ".config", "opensession");
const CONFIG_FILE = path.join(CONFIG_DIR, "gateway.json");
const KEY_FILE = path.join(CONFIG_DIR, "gateway-keys.json");
const USAGE_FILE = path.join(CONFIG_DIR, "gateway-usage.jsonl");

// 三族线路。gemini 暂不提供：
// 它的请求体是 contents/parts 而非 messages，翻译量另算一套，
// 而没有 agent 在本机用它（本机 claude/codex/pi/dsh 都没走 gemini 原生）。
const PROTOCOLS = ["chat", "responses", "anthropic"];
const PROTOCOL_LABEL = { chat: "OpenAI Chat", responses: "OpenAI Responses", anthropic: "Anthropic" };

// magpie 的 routing 模式。smart / pace 依赖配额窗口（它自己探测余额与重置时刻），
// OpenSession 不探测余额，所以这两种**降级为 order / usage**并在界面上标注，
// 而不是假装支持。
const ROUTING_MODES = ["order", "rotate", "usage", "smart", "pace"];
const ROUTING_EFFECTIVE = { order: "order", rotate: "rotate", usage: "usage", smart: "order", pace: "usage" };

const DEFAULTS = {
  version: 2,
  enabled: false,
  providers: [],
  groups: [],
  defaultProvider: "",
  // 上游 429 / 5xx 的额外重试次数（不含首次）
  maxRetries: 1,
  // 允许跨供应商故障转移
  failover: true,
  usageKeepDays: 30,
};

let cache = null;
let cacheMtime = 0;

// 按 mtime 判断要不要重读。
// 长驻服务 + 手改配置文件的场景：不检查 mtime 就会一直用旧配置，
// 用户改了 gateway.json 却看不到效果，会以为坏了。
function fileMtime() {
  try { return fs.statSync(CONFIG_FILE).mtimeMs; } catch { return 0; }
}

function ensureDir() {
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); } catch { /* 已存在 */ }
}

// 原子写。半截 JSON 的后果是全部供应商配置丢失 —— 用户得重配一遍，
// 这个代价远大于多一次 rename。
function writeAtomic(file, text, mode = 0o600) {
  ensureDir();
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { encoding: "utf8", mode });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function normalizeProvider(p) {
  if (!p || !p.id) return null;
  return {
    id: String(p.id),
    name: String(p.name || p.id),
    // 三种协议基址，各自独立。空串 = 这家不提供该协议
    url: String(p.url || ""),
    anthropic: String(p.anthropic || ""),
    responses: String(p.responses || ""),
    // 对外暴露的模型。空数组 = 用 keys 里探测到的全部（见 allModels）
    models: Array.isArray(p.models) ? p.models.map(String) : [],
    // 自定义请求头，如 header.User-Agent = "magpie"
    headers: p.headers && typeof p.headers === "object" && !Array.isArray(p.headers) ? { ...p.headers } : {},
    enabled: p.enabled !== false,
    note: String(p.note || ""),
    balance: String(p.balance || ""),
    balanceAt: String(p.balanceAt || ""),
    createdAt: String(p.createdAt || ""),
  };
}

function load() {
  const mt = fileMtime();
  if (cache && mt === cacheMtime) return cache;
  const raw = readJson(CONFIG_FILE, null);
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  if (!Array.isArray(cfg.providers)) cfg.providers = [];
  if (!Array.isArray(cfg.groups)) cfg.groups = [];
  cfg.providers = cfg.providers.map(normalizeProvider).filter(Boolean);
  cfg.groups = cfg.groups
    .filter((g) => g && g.name)
    .map((g) => ({
      name: String(g.name),
      models: Array.isArray(g.models) ? g.models.map(String) : [],
      routing: ROUTING_MODES.includes(g.routing) ? g.routing : "order",
      note: String(g.note || ""),
    }));
  cache = cfg;
  cacheMtime = mt;
  return cfg;
}

function save(cfg) {
  writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  cache = cfg;
  cacheMtime = fileMtime();
  return cfg;
}

function save(cfg) {
  cache = cfg;
  writeAtomic(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// 丢弃内存缓存，下次 load() 重新读盘。
// 为什么需要：用户可能在编辑器里手改了 gateway.json，
// 或者另一个进程（CLI / 测试）写过它。长驻的服务不刷新就永远看到旧配置。
function refresh() {
  cache = null;
  return load();
}

// ---- 密钥 ----
// 结构：{ providerId: [{name, key}] }。多 key 是 magpie 的核心能力之一
// （同家多账号轮换），不是可选装饰，所以第一版就按数组存。

function readKeys() {
  const k = readJson(KEY_FILE, null);
  return k && typeof k === "object" && !Array.isArray(k) ? k : {};
}

function writeKeys(keys) { writeAtomic(KEY_FILE, JSON.stringify(keys, null, 2)); }

// 取密钥列表。兼容手写成裸字符串的旧格式，统一成 {name,key}
function keysOf(id) {
  const v = readKeys()[id];
  if (!v) return [];
  if (typeof v === "string") return v ? [{ name: "", key: v }] : [];
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && e.key).map((e) => ({ name: String(e.name || ""), key: String(e.key) }));
}

function setKeys(id, list) {
  const all = readKeys();
  const norm = (Array.isArray(list) ? list : [])
    .filter((e) => e && e.key)
    .map((e) => ({ name: String(e.name || ""), key: String(e.key) }));
  if (norm.length) all[id] = norm;
  else delete all[id];
  writeKeys(all);
}

// 对外视图：**永不含明文密钥**。只给数量与掩码。
function maskKey(k) {
  const s = String(k || "");
  if (!s) return "";
  if (s.length <= 10) return "•".repeat(s.length);
  return s.slice(0, 3) + "…" + s.slice(-4);
}

// 协议字段名映射：chat 存 `url`，另两个与协议同名。
// 抽成常量是因为有三处要用（baseFor / publicProvider / 界面标签），
// 各写一遍就必然漏一处 —— 首版就漏了 publicProvider，表现为
// 「只填了 chat 基址的供应商不显示 Chat 标签」。
const FIELD_OF = { chat: "url", anthropic: "anthropic", responses: "responses" };
const PROTO_OF_FIELD = { url: "chat", anthropic: "anthropic", responses: "responses" };

function publicProvider(p) {
  const keys = keysOf(p.id);
  return {
    ...p,
    keyCount: keys.length,
    keys: keys.map((k) => ({ name: k.name, mask: maskKey(k.key) })),
    hasKey: keys.length > 0,
    // 该家实际能接哪些协议 —— 界面用它画小标签
    protocols: PROTOCOLS.filter((pr) => p[FIELD_OF[pr]]),
  };
}

function listProviders() { return load().providers.map(publicProvider); }
function findProvider(id) { return load().providers.find((p) => p.id === id) || null; }

function slugify(name) {
  const base = String(name || "").toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "provider";
}

function uniqueId(name) {
  const cfg = load();
  const base = slugify(name);
  let id = base, n = 2;
  while (cfg.providers.some((p) => p.id === id)) id = base + "-" + n++;
  return id;
}

function assertUrl(u, label) {
  const s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) throw new Error(label + " 必须以 http:// 或 https:// 开头");
  return s;
}

function addProvider(input) {
  const cfg = load();
  const name = String(input.name || "").trim();
  if (!name) throw new Error("供应商名称不能为空");

  const url = assertUrl(input.url, "Chat 基址");
  const anthropic = assertUrl(input.anthropic, "Anthropic 基址");
  const responses = assertUrl(input.responses, "Responses 基址");
  if (!url && !anthropic && !responses) throw new Error("至少要填一个协议基址（Chat / Anthropic / Responses）");

  const p = normalizeProvider({
    id: input.id ? slugify(input.id) : uniqueId(name),
    name, url, anthropic, responses,
    models: Array.isArray(input.models)
      ? input.models
      : String(input.models || "").split(/[\s,]+/).filter(Boolean),
    headers: input.headers,
    enabled: input.enabled !== false,
    note: input.note,
    balance: input.balance,
    createdAt: new Date().toISOString(),
  });
  if (cfg.providers.some((x) => x.id === p.id)) throw new Error("供应商 ID 已存在: " + p.id);

  cfg.providers.push(p);
  if (!cfg.defaultProvider) cfg.defaultProvider = p.id;
  save(cfg);

  // keys 支持三种入参：数组 / 单个 key 字符串 / 逗号分隔多个
  const list = Array.isArray(input.keys) ? input.keys
    : input.keys ? [{ name: "", key: String(input.keys) }]
    : input.key ? [{ name: "", key: String(input.key) }]
    : [];
  if (list.length) setKeys(p.id, list);

  return publicProvider(p);
}

function updateProvider(id, patch) {
  const cfg = load();
  const p = cfg.providers.find((x) => x.id === id);
  if (!p) throw new Error("供应商不存在: " + id);

  if (patch.name != null) p.name = String(patch.name).trim() || p.name;
  for (const [k, label] of [["url", "Chat 基址"], ["anthropic", "Anthropic 基址"], ["responses", "Responses 基址"]]) {
    if (patch[k] != null) p[k] = assertUrl(patch[k], label);
  }
  if (!p.url && !p.anthropic && !p.responses) throw new Error("至少要留一个协议基址");
  if (patch.models != null) {
    p.models = Array.isArray(patch.models) ? patch.models.map(String).filter(Boolean)
      : String(patch.models).split(/[\s,]+/).filter(Boolean);
  }
  if (patch.headers != null) {
    p.headers = patch.headers && typeof patch.headers === "object" ? { ...patch.headers } : {};
  }
  if (patch.enabled != null) p.enabled = !!patch.enabled;
  if (patch.note != null) p.note = String(patch.note);
  if (patch.balance != null) { p.balance = String(patch.balance); p.balanceAt = new Date().toISOString(); }

  // keys：给了数组就整体替换；给了单个 key 则追加（换 key 不必重填其他）
  if (Array.isArray(patch.keys)) setKeys(id, patch.keys);

  save(cfg);
  return publicProvider(p);
}

function removeKey(id, index) {
  const keys = keysOf(id);
  keys.splice(index, 1);
  setKeys(id, keys);
  return keys.map((k) => ({ name: k.name, mask: maskKey(k.key) }));
}

function removeProvider(id) {
  const cfg = load();
  const i = cfg.providers.findIndex((p) => p.id === id);
  if (i < 0) throw new Error("供应商不存在: " + id);
  cfg.providers.splice(i, 1);
  if (cfg.defaultProvider === id) cfg.defaultProvider = cfg.providers[0] ? cfg.providers[0].id : "";
  // 连带清理：路由组里引用这家的成员要去掉，否则组会指向空
  for (const g of cfg.groups) g.models = g.models.filter((m) => !m.startsWith(id + "/"));
  save(cfg);
  setKeys(id, []);
  return true;
}

// ---- 路由组 ----

function listGroups() {
  const cfg = load();
  return cfg.groups.map((g) => ({
    ...g,
    effective: ROUTING_EFFECTIVE[g.routing] || g.routing,
  }));
}

function addGroup(input) {
  const cfg = load();
  const name = String(input.name || "").trim().replace(/^group\//, "");
  if (!name) throw new Error("组名不能为空");
  if (cfg.groups.some((g) => g.name === name)) throw new Error("组已存在: " + name);
  const models = (Array.isArray(input.models) ? input.models : String(input.models || "").split(/[\s,]+/))
    .map((m) => String(m).trim()).filter(Boolean);
  if (!models.length) throw new Error("组里至少要有一个模型（provider/model）");
  cfg.groups.push({
    name, models,
    routing: ROUTING_MODES.includes(input.routing) ? input.routing : "order",
    note: String(input.note || ""),
  });
  save(cfg);
  return listGroups().find((g) => g.name === name);
}

function updateGroup(name, patch) {
  const cfg = load();
  const g = cfg.groups.find((x) => x.name === name);
  if (!g) throw new Error("组不存在: " + name);
  if (patch.models != null) {
    const m = (Array.isArray(patch.models) ? patch.models : String(patch.models).split(/[\s,]+/))
      .map((x) => String(x).trim()).filter(Boolean);
    if (!m.length) throw new Error("组里至少要有一个模型");
    g.models = m;
  }
  if (patch.routing != null && ROUTING_MODES.includes(patch.routing)) g.routing = patch.routing;
  if (patch.note != null) g.note = String(patch.note);
  if (patch.name && patch.name !== name) {
    const nn = String(patch.name).trim().replace(/^group\//, "");
    if (cfg.groups.some((x) => x.name === nn)) throw new Error("组名已存在: " + nn);
    g.name = nn;
  }
  save(cfg);
  return listGroups();
}

function removeGroup(name) {
  const cfg = load();
  const i = cfg.groups.findIndex((g) => g.name === name);
  if (i < 0) throw new Error("组不存在: " + name);
  cfg.groups.splice(i, 1);
  save(cfg);
  return true;
}

function setSettings(patch) {
  const cfg = load();
  for (const k of ["enabled", "failover"]) if (patch[k] != null) cfg[k] = !!patch[k];
  for (const k of ["maxRetries", "usageKeepDays"]) {
    if (patch[k] != null) {
      const n = Number(patch[k]);
      if (isFinite(n) && n >= 0) cfg[k] = Math.min(10, Math.floor(n));
    }
  }
  if (patch.defaultProvider != null) {
    const id = String(patch.defaultProvider);
    if (!id || cfg.providers.some((p) => p.id === id)) cfg.defaultProvider = id;
  }
  return save(cfg);
}

// ---- 模型解析 ----
//
// 三种寻址（与 magpie 一致）：
//   group/<name>        路由组
//   <provider>/<model>  指定供应商
//   <model>             用 defaultProvider
//
// 返回**候选链**，每项 { provider, model, key } —— 每次尝试用一个 key，
// 同一个 provider 的多把 key 展开成多个候选，这样「额度用完换账号」
// 和「换供应商」是同一套遍历逻辑，不用写两份。

const ROTATE_STATE = { i: 0, model: "" };

function expandProvider(pid, model, out) {
  const p = findProvider(pid);
  if (!p || p.enabled === false) return;
  const keys = keysOf(pid);
  if (!keys.length) return;
  for (const k of keys) out.push({ provider: p, providerId: pid, model, key: k.key, keyName: k.name });
}

function resolve(model) {
  const cfg = load();
  const m = String(model || "").trim();
  const out = [];
  if (!m) return out;

  // 1) 路由组
  if (m.startsWith("group/")) {
    const name = m.slice(6);
    const g = cfg.groups.find((x) => x.name === name);
    if (!g) return out;
    let members = g.models.slice();
    const eff = ROUTING_EFFECTIVE[g.routing] || "order";
    if (eff === "rotate") {
      // 轮换：每次请求把起点往后挪一位。
      // 用「模型名 + 序号」而不是全局计数 —— 多个组各自独立轮换，
      // 共用计数器会让某个组永远只用到同一半成员
      if (ROTATE_STATE.model === m) ROTATE_STATE.i++;
      else { ROTATE_STATE.model = m; ROTATE_STATE.i = 0; }
      const n = members.length;
      const s = n ? ROTATE_STATE.i % n : 0;
      members = members.slice(s).concat(members.slice(0, s));
    }
    for (const mem of members) {
      if (mem.startsWith("group/")) continue;      // 防自引用递归
      const i = mem.indexOf("/");
      if (i < 0) continue;
      expandProvider(mem.slice(0, i), mem.slice(i + 1), out);
    }
    return out;
  }

  // 2) provider/model
  if (m.includes("/")) {
    const i = m.indexOf("/");
    expandProvider(m.slice(0, i), m.slice(i + 1), out);
    return out;
  }

  // 3) 裸模型名：默认供应商优先，其余声明了该模型的作为后备
  if (cfg.defaultProvider) expandProvider(cfg.defaultProvider, m, out);
  if (cfg.failover) {
    for (const p of cfg.providers) {
      if (out.some((c) => c.providerId === p.id)) continue;
      if (Array.isArray(p.models) && p.models.includes(m)) expandProvider(p.id, m, out);
    }
  }
  return out;
}

// 按传入协议挑基址。返回 { base, protocol } 或 null。
// 顺序：完全匹配 → 可翻译的协议（chat↔anthropic 双向可译，responses 单独）
// 按传入协议挑基址。返回 { base, protocol } 或 null。
// 🔴 注意字段名不一致：chat 的基址存在 `url` 里（沿用 magpie 的
// `provider add ... url=` 语义），anthropic / responses 则与协议同名。
// 这里必须走 FIELD_OF 映射 —— 直接用 provider[want] 会让 chat 永远取不到基址，
// 表现为「只填了 url 的供应商，一翻译就全军覆没」。
function baseFor(provider, want) {
  const hit = (proto) => {
    const f = FIELD_OF[proto];
    return f && provider[f] ? { base: provider[f], protocol: proto } : null;
  };
  const exact = hit(want);
  if (exact) return exact;
  // 翻译矩阵：谁能译成谁（chat↔anthropic 双向，responses 可与 chat 互译）
  const ALT = {
    chat: ["responses", "anthropic"],
    anthropic: ["chat", "responses"],
    responses: ["chat"],
  };
  for (const alt of ALT[want] || []) {
    const r = hit(alt);
    if (r) return r;
  }
  return null;
}

function allModels() {
  const cfg = load();
  const out = [];
  const seen = new Set();
  const push = (id, provider, model) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, object: "model", owned_by: provider, provider, model });
  };
  for (const p of cfg.providers) {
    if (p.enabled === false) continue;
    for (const m of p.models) push(p.id + "/" + m, p.id, m);
  }
  return out;
}

// 所有可用的模型名（含路由组的虚拟名），给界面的下拉用
function modelCandidates() {
  const cfg = load();
  const out = [];
  for (const p of cfg.providers) {
    if (p.enabled === false) continue;
    for (const m of p.models) out.push(p.id + "/" + m);
  }
  for (const g of cfg.groups) out.push("group/" + g.name);
  return out;
}

// ---- 用量 ----
//
// 字段名对齐 magpie：providerKeyName / providerAccount / tier_served /
// upstream_stop / sent_model / retried / tries / flow_ms。
// 不记请求与响应正文 —— 网关经手全部对话内容，落一份副本到磁盘
// 与「只做会话查看」的定位不符。

function recordUsage(row) {
  ensureDir();
  try {
    fs.appendFileSync(USAGE_FILE, JSON.stringify({ t: new Date().toISOString(), ...row }) + "\n",
      { encoding: "utf8", mode: 0o600 });
  } catch { /* 记账失败绝不影响转发 */ }
}

// 倒扫尾部。usage.jsonl 会长期增长（一天几千行），
// 全量读入再过滤在半年后必然成为瓶颈。
function readUsage({ sinceMs = 0, limit = 200000 } = {}) {
  let text;
  try { text = fs.readFileSync(USAGE_FILE, "utf8"); }
  catch { return []; }
  const lines = text.split("\n");
  const rows = [];
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    const ts = Date.parse(r.t || "");
    if (!isFinite(ts)) continue;
    if (sinceMs && ts < sinceMs) break;   // 倒序，越过下界即停
    rows.push(r);
  }
  return rows.reverse();
}

function summarize({ sinceMs = 0 } = {}) {
  const rows = readUsage({ sinceMs });
  const agg = {
    calls: 0, errors: 0, retried: 0, in: 0, out: 0, cache_read: 0, cache_write: 0, reasoning: 0,
    byProvider: {}, byModel: {}, byStatus: {}, ttftSum: 0, ttftN: 0, msSum: 0, msN: 0,
  };
  for (const r of rows) {
    agg.calls++;
    const st = Number(r.status) || 0;
    const bad = st >= 400 || r.err;
    if (bad) agg.errors++;
    if (r.retried) agg.retried++;
    agg.in += Number(r.in) || 0;
    agg.out += Number(r.out) || 0;
    agg.cache_read += Number(r.cache_read) || 0;
    agg.cache_write += Number(r.cache_write) || 0;
    agg.reasoning += Number(r.reasoning) || 0;
    if (r.ttft_ms) { agg.ttftSum += r.ttft_ms; agg.ttftN++; }
    if (r.ms) { agg.msSum += r.ms; agg.msN++; }

    const pk = r.provider || "(unknown)";
    const mk = (r.provider ? r.provider + "/" : "") + (r.model || "(unknown)");
    const sk = String(st || "err");
    for (const [bucket, key] of [[agg.byProvider, pk], [agg.byModel, mk], [agg.byStatus, sk]]) {
      const b = bucket[key] || (bucket[key] = { calls: 0, errors: 0, in: 0, out: 0 });
      b.calls++;
      if (bad) b.errors++;
      b.in += Number(r.in) || 0;
      b.out += Number(r.out) || 0;
    }
  }
  agg.ttftAvg = agg.ttftN ? Math.round(agg.ttftSum / agg.ttftN) : 0;
  agg.msAvg = agg.msN ? Math.round(agg.msSum / agg.msN) : 0;
  agg.since = sinceMs ? new Date(sinceMs).toISOString() : "";
  return agg;
}

function daily({ days = 14 } = {}) {
  const since = Date.now() - days * 86400000;
  const rows = readUsage({ sinceMs: since });
  const map = {};
  for (const r of rows) {
    const d = String(r.t || "").slice(0, 10);
    if (!d) continue;
    const b = map[d] || (map[d] = { date: d, calls: 0, in: 0, out: 0, errors: 0 });
    b.calls++;
    b.in += Number(r.in) || 0;
    b.out += Number(r.out) || 0;
    if ((Number(r.status) || 0) >= 400 || r.err) b.errors++;
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    out.push(map[d] || { date: d, calls: 0, in: 0, out: 0, errors: 0 });
  }
  return out;
}

module.exports = {
  PROTOCOLS, PROTOCOL_LABEL, ROUTING_MODES, ROUTING_EFFECTIVE, DEFAULTS,
  load, refresh, listProviders, findProvider, publicProvider,
  addProvider, updateProvider, removeProvider, removeKey,
  listGroups, addGroup, updateGroup, removeGroup,
  setSettings, keysOf, setKeys, maskKey,
  resolve, baseFor, allModels, modelCandidates,
  recordUsage, readUsage, summarize, daily,
  usagePath: () => USAGE_FILE, configPath: () => CONFIG_FILE, CONFIG_DIR,
};
