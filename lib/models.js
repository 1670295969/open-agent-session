// 模型 / 思考强度目录（供前端下拉框）
// claude 用 ~/.claude/settings.json 的 modelPicker.options；
// codex 用 ~/.codex/magpie-models.json（magpie 写的 catalog）；
// pi 用 pi --list-models。结果缓存 10 分钟。
//
// 🔴 codex 的 catalog 文件**只在 magpie 托管 codex 时才存在**（config.toml 里
//    还需 model_catalog_json 指过去）。magpie 一旦不再托管、或用户换回自己的
//    中转站配置，这个文件就没了 —— 于是 codex 的下拉只剩「默认」，看着像
//    「模型改不了」。所以加了三级兜底：catalog 文件 → 网关供应商清单 →
//    codex 自己的 config.toml（各家 model_providers 的 base_url 反查网关）。
//
// dsh 刻意不提供模型列表：它的模型定义在 profile 的 cordis.patch.yml 里，
// 是 YAML 嵌套结构（providers → models → reasoningEfforts），要解析得引第三方
// YAML 库，而这个项目是零依赖的。且 dsh 的 `-m` / `--reasoning` 每次都给默认值
// 也能正常工作，下拉框缺失不影响使用 —— 所以让它留空，前端会自动隐藏下拉。
const fs = require("fs");
const path = require("path");
const { HOME, MODEL_CACHE_MS } = require("./config");
const { readJsonFile } = require("./utils");
const { runToolSync } = require("./platform");

// 各工具支持的思考强度档位
const EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh"],
  // dsh 的 reasoningEfforts 由 profile 决定，不同模型档位不同，不做静态枚举
  dsh: [],
};

function readClaudeModels() {
  const settings = readJsonFile(path.join(HOME, ".claude", "settings.json"));
  const opts = settings && settings.modelPicker && Array.isArray(settings.modelPicker.options)
    ? settings.modelPicker.options : [];
  const out = [];
  for (const o of opts) if (o.model) out.push({ id: o.model, label: o.label || o.model });
  return out;
}

// codex 的 config.toml：顶层 model_provider 指向哪家、那家的 base_url 是什么，
// 决定 `-m` 能接受哪些名字。零依赖下只做浅解析（两类行都以行首出现），够用。
function readCodexToml() {
  let txt;
  try { txt = fs.readFileSync(path.join(HOME, ".codex", "config.toml"), "utf8"); }
  catch { return null; }
  // 只认行首的顶层赋值：`^model\s*=` 不会误吃 `model_provider =` / `model_reasoning_effort =`
  const top = (key) => {
    const m = txt.match(new RegExp("^" + key + "\\s*=\\s*\"([^\"]*)\"", "m"));
    return m ? m[1] : "";
  };
  const providers = {};
  const re = /^\[model_providers\.([^\]]+)\]/gm;
  let m;
  while ((m = re.exec(txt))) {
    const start = m.index + m[0].length;
    const next = txt.slice(start).search(/^\[/m);
    const block = txt.slice(start, next === -1 ? txt.length : start + next);
    const u = block.match(/^\s*base_url\s*=\s*"([^"]*)"/m);
    providers[m[1]] = u ? u[1] : "";
  }
  return { modelProvider: top("model_provider"), providers };
}

// 基址归一：去掉尾斜杠与 /v1，便于「网关里存的」和「codex 里写的」对上。
// 用户写 https://x.com/v1 还是 https://x.com/v1/ 都必须比得上。
function normBase(u) {
  return String(u || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase();
}

/* codex 下拉的兜底数据源。
   为什么需要：magpie-models.json 只在 magpie 托管 codex 时存在（config.toml 里还得有
   model_catalog_json 指过去）。magpie 一旦不托管了、或用户换回自己的中转站配置，
   文件就消失 —— codex 下拉只剩「默认」，表现就是「模型改不了」。

   两条分支，取决于 codex 现在指向谁：
   · 指向网关（本机端口 / magpie）：用 <provider>/<model> 与 group/<name>，
     网关按前缀选家，选了真能跑。
   · 直连某家上游：`-m` 只吃裸模型名，且换家得改 model_provider，
     所以只列「当前这家」的模型，不列别家的（列了也跑不通）。 */
function codexModelsFromConfig() {
  const cfg = readCodexToml();
  if (!cfg || !cfg.modelProvider) return [];
  const base = normBase(cfg.providers[cfg.modelProvider]);
  if (!base) return [];

  let store, PORT;
  try {
    store = require("./gateway/store");
    ({ PORT } = require("./config"));
  } catch { return []; }
  const gw = store.load();
  if (!gw || !Array.isArray(gw.providers)) return [];

  const gwBase = normBase("http://127.0.0.1:" + PORT);
  // 3425 是 magpie 的端口：它和我们同构（都认 <provider>/<model> 与 group/），
  // 所以指向它时也按网关的写法列，只是数据仍取我们自己的池子。
  if (base === gwBase || base.endsWith(":3425")) {
    const out = [];
    for (const p of gw.providers) {
      if (p.enabled === false) continue;
      for (const m of p.models || []) out.push({ id: p.id + "/" + m, label: m + " · " + p.id });
    }
    for (const g of gw.groups || []) out.push({ id: "group/" + g.name, label: g.name + " · routing group" });
    return out;
  }

  const hit = gw.providers.find((p) =>
    [p.url, p.responses, p.anthropic].some((x) => x && normBase(x) === base));
  if (!hit) return [];
  return (hit.models || []).map((m) => ({ id: m, label: m + " · " + hit.id }));
}

function readCodexModels() {
  const cat = readJsonFile(path.join(HOME, ".codex", "magpie-models.json"));
  const models = cat && Array.isArray(cat.models) ? cat.models : [];
  const out = [];
  for (const m of models) if (m.slug) out.push({ id: m.slug, label: m.display_name || m.slug });
  if (out.length) return out;
  return codexModelsFromConfig();
}

// 【实测】pi --list-models 的表格输出走 stderr。
// 原来用 `execSync("pi --list-models 2>&1")` 依赖 shell 重定向——这在 Windows 的
// cmd.exe 下语义不同（且 `2>&1` 在引号里会被当普通参数）。改为 spawnSync 直接
// 读两个流再拼接，跨平台一致，也不再有 shell 参与。
function readPiModels() {
  const out = [];
  const r = runToolSync("pi", ["--list-models"], { timeout: 15000 });
  if (!r.out) return out;
  for (const line of r.out.split("\n").slice(1)) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\d/);
    if (m && m[1] !== "provider") out.push({ id: m[1] + "/" + m[2], label: m[1] + "/" + m[2] });
  }
  return out;
}

// dsh：模型定义在 profile 的 cordis.patch.yml 里，嵌套四层
// （llm-pi-ai.config.providers.<provider>.models[]）。
// 完整解析 YAML 要引库（本项目零依赖），但这里只需要「哪些 id、属于哪家、
// 这家走什么 API」，结构固定且缩进规整 —— 用极简行扫描足够，
// 且解析失败就返回空（前端显示「未读到清单」），不会比现在更差。
//
// 🔴 dsh headless **没有 -m**（实测 `-m` 直接 unknown option），
//    模型只能靠 `--patch <覆盖层>` 改 profile 的 agent-default-model。
//    所以这里只负责「列出可选项」，真正切换在 adapters/dsh.js 里做。
function readDshModels() {
  let txt;
  try { txt = fs.readFileSync(path.join(HOME, ".dsh", "profiles", "headless", "cordis.patch.yml"), "utf8"); }
  catch { return []; }

  const out = [];
  let inProviders = false;   // 进入 providers: 之后才算
  let provIndent = -1;       // providers 下第一层（供应商名）的缩进
  let curProv = "";          // 当前供应商名
  let inModels = false;
  let modelIndent = -1;

  for (const raw of txt.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const t = line.trim();

    if (t === "providers:") { inProviders = true; provIndent = -1; continue; }
    if (!inProviders) continue;
    // 缩进回退到 providers 之外 → 这一段结束
    if (indent === 0 && t.endsWith(":") && !t.startsWith("-")) { inProviders = false; continue; }

    if (!t.startsWith("-") && t.endsWith(":")) {
      const name = t.slice(0, -1);
      if (provIndent === -1) { provIndent = indent; }
      if (indent === provIndent) { curProv = name; inModels = false; continue; }
      if (indent === provIndent + 2 && name === "models") { inModels = true; modelIndent = -1; continue; }
    }
    if (inModels && t.startsWith("- id:")) {
      // 🔴 必须锁缩进：文件末尾还有 `- insert:` → `- id: magpie-mcp-*` 这种段，
      //    它们的 `- id:` 长得一模一样，不锁就会把 MCP 服务器当成模型列出来。
      if (modelIndent === -1) modelIndent = indent;
      if (indent !== modelIndent) continue;
      const id = t.slice(5).trim().replace(/^["']|["']$/g, "");
      if (id) out.push({ id, label: id + " · " + curProv, provider: curProv });
    }
  }
  return out;
}

const CACHE = { ts: 0, data: null };
// force=true 跳过缓存。指向 / 还原 agent 之后必须用它 —— 否则用户点了「指向网关」，
// 10 分钟内下拉还是旧清单，看着像没生效。
function modelCatalog(force) {
  if (!force && CACHE.data && Date.now() - CACHE.ts < MODEL_CACHE_MS) return CACHE.data;
  const data = {
    claude: readClaudeModels(),
    codex: readCodexModels(),
    pi: readPiModels(),
    dsh: readDshModels(),
    efforts: EFFORTS,
  };
  CACHE.data = data;
  CACHE.ts = Date.now();
  return data;
}

module.exports = { modelCatalog, EFFORTS };
