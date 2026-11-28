// 把 agent 指向本网关（以及还原）
//
// 对应 magpie 的 `magpie <agent> <provider/model>` 与 `magpie <agent> default`。
//
// 覆盖范围（刻意只做这三家）：
//   claude  ~/.claude/settings.json 的 env.ANTHROPIC_BASE_URL / AUTH_TOKEN
//   codex   ~/.codex/config.toml   的 model_provider + [model_providers.<id>] 段
//   pi      ~/.pi/agent/models.json 注入 provider，settings.json 改默认
//
// **dsh 不做写入**：它的供应商在 profiles/*/cordis.patch.yml 里，是四层嵌套的
// YAML（providers → <name> → models → reasoningEfforts）。零依赖原则下要写它
// 就得先实现一个保留注释与缩进的 YAML 编辑器，这个代价和收益不成比例。
// 界面上 dsh 只显示当前指向，不给开关 —— 明确「做不到」好过做一半改坏配置。
// hermes 同理：只读存储。
//
// 安全底线（每一家都遵守）：
//   1. 改之前**强制备份**到 ~/.config/opensession/agent-backups/
//   2. 只动自己写的那几个键，其余键原样保留（claude 的 settings.json 里有
//      modelPicker / statusLine / env 里十几个开关，弄丢一个用户的 Claude Code 就废了）
//   3. 写入用原子替换（临时文件 + rename）
//   4. 备份里记下「改之前的原始值」，还原时精确回填而不是猜
const fs = require("fs");
const path = require("path");
const { HOME, PORT } = require("../config");
const store = require("./store");

const BACKUP_DIR = path.join(store.CONFIG_DIR, "agent-backups");

const FILES = {
  claude: path.join(HOME, ".claude", "settings.json"),
  codex: path.join(HOME, ".codex", "config.toml"),
  piModels: path.join(HOME, ".pi", "agent", "models.json"),
  piSettings: path.join(HOME, ".pi", "agent", "settings.json"),
  dsh: path.join(HOME, ".dsh", "profiles", "headless", "cordis.patch.yml"),
};

// 本网关在 agent 配置里使用的 provider id / 占位密钥。
// key 用固定串而不是真口令：agent 只是把它当「访问网关的凭证」，
// 网关默认不校验（OPENSESSION_GW_TOKEN 未设），校验时再让用户填同一个值。
const GW_PROVIDER_ID = "opensession";
const GW_KEY_PLACEHOLDER = "opensession";

// 本网关对外的**真实入口**。🔴 必须在路径里带 `/gw`：
// 网关的转发路由是 `/gw/v1/{chat/completions,responses,messages}`（见 router.js），
// 根下的 `/v1/*` 什么都不接（实测 `POST /v1/responses` 直接 "not found"）。
//
// 曾经写的是 `http://127.0.0.1:8347`（claude）与 `.../v1`（codex / pi），
// 少了 `/gw` 这一段 —— 三家 agent 表面上「已指向网关」，实际每条请求都 404，
// 而界面上还打着「走 OpenSession」，属于比不知道更糟的状态。
//
// 两家的拼接方式不同，所以基址本身也不同：
//   claude  SDK 自己拼 `/v1/messages` → 基址给到 `/gw`
//   codex   基址后面直接接 `/responses` → 基址给到 `/gw/v1`
//   pi      同上 → 基址给到 `/gw/v1`
const GW_ORIGIN = () => `http://127.0.0.1:${PORT}`;
const GW_BASE = {
  anthropic: () => `${GW_ORIGIN()}/gw`,
  responses: () => `${GW_ORIGIN()}/gw/v1`,
  chat: () => `${GW_ORIGIN()}/gw/v1`,
};

// 判断一个 base_url 是不是「打到本网关」。
// 只认本机地址 + `/gw` 或 `/gw/v1` 路径 —— 光看端口不够：
// 旧版写完的那两个错误基址（`/` 和 `/v1`）同样指向 8347，但它们不通，
// 判成「走网关」就会把故障藏起来。
function parseBase(u) {
  if (!u) return null;
  const m = String(u).trim().match(/^(?:https?:\/\/)?([^/]+)(\/.*)?$/i);
  if (!m) return null;
  return { host: m[1].toLowerCase(), path: ((m[2] || "").replace(/\/+$/, "") || "/") };
}
const OUR_HOSTS = () => [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
function isOurBase(u) {
  const p = parseBase(u);
  if (!p) return false;
  return OUR_HOSTS().includes(p.host) && (p.path === "/gw" || p.path === "/gw/v1");
}
// 指到了本网关端口、但路径不对 —— 旧版本写坏的配置就长这样。
// 单独识别出来，好给一句「重开开关即可修复」而不是含糊的「不走网关」。
function isOurHostWrongPath(u) {
  const p = parseBase(u);
  if (!p) return false;
  return OUR_HOSTS().includes(p.host) && !(p.path === "/gw" || p.path === "/gw/v1");
}

function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, "utf8");
  // 保留原文件权限：settings.json 若原来是 600，写成默认 644 会放宽暴露面
  try { fs.chmodSync(tmp, fs.statSync(file).mode); } catch { /* 新文件，用默认 */ }
  fs.renameSync(tmp, file);
}

function backup(agent, file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dst = path.join(BACKUP_DIR, `${agent}-${ts}${path.extname(file)}`);
  if (exists(file)) fs.copyFileSync(file, dst);
  else fs.writeFileSync(dst, "", "utf8");
  return dst;
}

// ---- 各家的「当前指向」读取 ----

// claude：看 env.ANTHROPIC_BASE_URL。指向本机 8347 就是「走 OpenSession」
function detectClaude() {
  const s = readJson(FILES.claude);
  if (!s) return { supported: true, found: false, configFile: FILES.claude };
  const env = s.env || {};
  const base = String(env.ANTHROPIC_BASE_URL || "");
  const models = {
    opus: String(env.ANTHROPIC_DEFAULT_OPUS_MODEL || ""),
    sonnet: String(env.ANTHROPIC_DEFAULT_SONNET_MODEL || ""),
    haiku: String(env.ANTHROPIC_DEFAULT_HAIKU_MODEL || ""),
    small: String(env.ANTHROPIC_SMALL_FAST_MODEL || ""),
  };
  return {
    supported: true, found: true, configFile: FILES.claude,
    baseUrl: base,
    viaGateway: isOurBase(base),
    // 端口对、路径不对 = 旧版本写坏的配置，界面要给「重开开关修复」的提示
    brokenBase: isOurHostWrongPath(base),
    models,
    model: String(s.model || ""),
  };
}

// codex：两个条件都要满足才算真走网关 ——
// model_provider 是我们写的那个 id，**并且**那段里的 base_url 真的打到 /gw/v1。
// 只看 provider 名不够：配置能被别的工具改写、也能被手改坏。
function detectCodex() {
  const txt = readText(FILES.codex);
  if (txt == null) return { supported: true, found: false, configFile: FILES.codex };
  const g = (re) => { const m = txt.match(re); return m ? m[1].trim() : ""; };
  const provider = g(/^\s*model_provider\s*=\s*"([^"]*)"/m);
  // 取出 [model_providers.opensession] 段文本（到下一个顶层 [ 为止）。
  // 🔴 结尾不能用 `$` —— 带 `m` 标志时 `$` 匹配**每一行行尾**，
  // `[\s\S]*?` 会当场缩成空串，只截到段标题，base_url 永远取不到。
  const blockM = txt.match(/^\[model_providers\.opensession\][\s\S]*?(?=\n\[|(?![\s\S]))/m);
  const ourBase = blockM ? (blockM[0].match(/^\s*base_url\s*=\s*"([^"]*)"/m) || [])[1] : "";
  const base = String(ourBase || "").trim();
  return {
    supported: true, found: true, configFile: FILES.codex,
    modelProvider: provider,
    model: g(/^\s*model\s*=\s*"([^"]*)"/m),
    baseUrl: base,
    // provider 指我们 + 基址真的通 —— 少一个都不算，避免「显示走网关实际 404」
    viaGateway: provider === GW_PROVIDER_ID && isOurBase(base),
    brokenBase: provider === GW_PROVIDER_ID ? isOurHostWrongPath(base) : false,
    // 有没有我们注入的那一段
    hasBlock: /^\[model_providers\.opensession\]/m.test(txt),
  };
}

// pi：defaultProvider 指我们 + 注入的 provider 里 baseUrl 打到 /gw/v1
function detectPi() {
  const m = readJson(FILES.piModels);
  const s = readJson(FILES.piSettings);
  if (!m && !s) return { supported: true, found: false, configFile: FILES.piModels };
  const providers = (m && m.providers) || {};
  const ours = providers[GW_PROVIDER_ID];
  const base = ours ? String(ours.baseUrl || "") : "";
  const provider = s ? String(s.defaultProvider || "") : "";
  return {
    supported: true, found: true, configFile: FILES.piModels,
    baseUrl: base,
    model: s ? String(s.defaultModel || "") : "",
    provider,
    viaGateway: provider === GW_PROVIDER_ID && isOurBase(base),
    brokenBase: provider === GW_PROVIDER_ID ? isOurHostWrongPath(base) : false,
    hasBlock: !!ours,
  };
}

// dsh：只读展示
function detectDsh() {
  const txt = readText(FILES.dsh);
  if (txt == null) return { supported: false, found: false, configFile: FILES.dsh, note: "未安装或路径不同" };
  const g = (re) => { const m = txt.match(re); return m ? m[1].trim() : ""; };
  return {
    supported: false, found: true, configFile: FILES.dsh,
    provider: g(/^\s*provider:\s*(\S+)/m),
    model: g(/^\s*model:\s*(\S+)/m),
    baseUrl: g(/baseURL:\s*(\S+)/),
    note: "YAML 嵌套结构，只读展示；改动请用 dsh 自己的命令",
  };
}

function detectAll() {
  const agentModels = store.load().agentModels || {};
  return {
    claude: detectClaude(),
    codex: detectCodex(),
    pi: detectPi(),
    dsh: detectDsh(),
    // 每个工具各自记住的模型（用户上次「指向」时选的），前端按行回填
    agentModels: { ...agentModels },
    gateway: { url: `http://127.0.0.1:${require("../config").PORT}`, providerId: GW_PROVIDER_ID },
  };
}

// ---- 指向 ----

// model 形如 "provider/model" 或 "group/<name>"。
// 写进 agent 时：
//   claude  → ANTHROPIC_BASE_URL=http://127.0.0.1:8347（不加 /v1），各档模型名都设成它
//   codex   → base_url=http://127.0.0.1:8347/v1，model=<model>，model_provider=opensession
//   pi      → baseUrl=http://127.0.0.1:8347/v1，defaultProvider=opensession
function applyClaude(model) {
  const s = readJson(FILES.claude) || {};
  const before = JSON.parse(JSON.stringify(s));
  const bk = backup("claude", FILES.claude);

  s.env = s.env || {};
  // Anthropic SDK 自己拼 `/v1/messages`，所以基址只给到 `/gw`
  s.env.ANTHROPIC_BASE_URL = GW_BASE.anthropic();
  s.env.ANTHROPIC_AUTH_TOKEN = GW_KEY_PLACEHOLDER;
  s.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
  s.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  s.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  s.env.ANTHROPIC_SMALL_FAST_MODEL = model;

  writeAtomic(FILES.claude, JSON.stringify(s, null, 2) + "\n");
  return { agent: "claude", backup: bk, wrote: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"], before };
}

// codex 的 config.toml 有 200+ 行、含大量 [projects.*] 段。
// 不做全量 TOML 解析（零依赖 + 保留原有排版），只做两件事：
//   1. 精确替换顶层的 model / model_provider 两个赋值的值
//   2. 重写我们自己的 [model_providers.opensession] 段（先删旧的再插）
// 这让用户的注释、段顺序、其他 provider 一个字节都不变。
function applyCodex(model) {
  let txt = readText(FILES.codex);
  if (txt == null) txt = "";
  const bk = backup("codex", FILES.codex);

  const baseUrl = GW_BASE.responses();

  // 删掉旧的 opensession 段（到下一个顶层 [ 为止）
  txt = txt.replace(/\n?\[model_providers\.opensession\][\s\S]*?(?=\n\[(?!model_providers\.opensession)|$)/g, "\n");

  // 顶层赋值：只匹配行首不带缩进的 model / model_provider
  const setTop = (key, val) => {
    const re = new RegExp(`^${key}\\s*=\\s*"[^"]*"`, "m");
    if (re.test(txt)) txt = txt.replace(re, `${key} = "${val}"`);
    else txt = `${key} = "${val}"\n` + txt;
  };
  setTop("model_provider", GW_PROVIDER_ID);
  setTop("model", model);

  const block = [
    "",
    `[model_providers.${GW_PROVIDER_ID}]`,
    `name = "OpenSession"`,
    `base_url = "${baseUrl}"`,
    `experimental_bearer_token = "${GW_KEY_PLACEHOLDER}"`,
    // wire_api 必须是 responses：codex 只会说 Responses 协议。
    // 网关会在上游不支持 responses 时翻译成 chat，所以这里固定写 responses 是对的。
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `supports_websockets = false`,
    "",
  ].join("\n");
  txt = txt.replace(/\s*$/, "\n") + block;

  writeAtomic(FILES.codex, txt);
  return { agent: "codex", backup: bk, wrote: ["model", "model_provider", `[model_providers.${GW_PROVIDER_ID}]`] };
}

function applyPi(model) {
  const m = readJson(FILES.piModels) || { providers: {} };
  const s = readJson(FILES.piSettings) || {};
  // 两个文件用不同的备份标签，还原时才能各找各的。
  // 用 "pi" / "pi-settings" 而不是 "pi" / "pi-models" ——
  // 前者配 listBackups 的 "tag-" 精确前缀不会互相串。
  const bk = backup("pi", FILES.piModels);
  const bk2 = backup("pi-settings", FILES.piSettings);

  m.providers = m.providers || {};
  const existing = m.providers[GW_PROVIDER_ID] || {};
  m.providers[GW_PROVIDER_ID] = {
    ...existing,
    api: "openai-completions",
    apiKey: GW_KEY_PLACEHOLDER,
    baseUrl: GW_BASE.chat(),
    name: "OpenSession",
    // 模型清单：用网关当前配置里所有 provider/model，pi 的下拉才有东西选。
    // 这里不写死 —— 供应商改了，重新点一次「指向」就同步了。
    models: store.modelCandidates().map((id) => ({
      id,
      name: id,
      api: "openai-responses",
      reasoning: true,
      contextWindow: 256000,
      maxTokens: 32000,
    })),
  };

  s.defaultProvider = GW_PROVIDER_ID;
  s.defaultModel = model;

  writeAtomic(FILES.piModels, JSON.stringify(m, null, 2) + "\n");
  writeAtomic(FILES.piSettings, JSON.stringify(s, null, 2) + "\n");
  return { agent: "pi", backup: [bk, bk2], wrote: ["providers.opensession", "defaultProvider", "defaultModel"] };
}

const APPLY = { claude: applyClaude, codex: applyCodex, pi: applyPi };

// ---- 开 / 关 的快照 ----
//
// 开关要能「关回去」，就必须要有一份**开之前那一刻**的定版配置。
// 不能靠 listBackups() 取最新时间戳 —— 只要开关来回拨过一次，
// 最新那份备份里装的就已经是网关配置了，拿它「还原」等于没关。
//
// 所以单独存一份定版快照：`<agent>.orig.<ext>`（固定文件名，不带时间戳）。
// 只在「关 → 开」的瞬间写一次；「开 → 关」时读它回填，然后删掉。
// 这样语义是干净的：这扇门关掉之后，配置回到你推开它之前的样子。
function origFile(label, file) {
  return path.join(BACKUP_DIR, `${label}.orig${path.extname(file)}`);
}

function saveOriginal(label, file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dst = origFile(label, file);
  if (exists(file)) fs.copyFileSync(file, dst);
  else fs.writeFileSync(dst, "", "utf8");
  return dst;
}

// 每个 agent 的（标签, 文件, 形状校验）三元组。pi 是两个文件。
function targetsOf(agent) {
  if (agent === "claude") return [{ label: "claude", file: FILES.claude, ok: looksLikeClaude }];
  if (agent === "codex") return [{ label: "codex", file: FILES.codex, ok: null }];
  if (agent === "pi") return [
    { label: "pi", file: FILES.piModels, ok: looksLikePiModels },
    { label: "pi-settings", file: FILES.piSettings, ok: looksLikePiSettings },
  ];
  return null;
}

const DETECT = { claude: detectClaude, codex: detectCodex, pi: detectPi };
const currentOf = (agent) => (DETECT[agent] ? DETECT[agent]() : null);

function applyTo(agent, model) {
  const fn = APPLY[agent];
  if (!fn) throw new Error(`不支持写入该工具: ${agent}（只支持 claude / codex / pi）`);
  if (!model) throw new Error("必须指定模型（provider/model 或 group/<name>）");
  // 校验模型确实存在，避免把拼错的名字写进 agent 配置 ——
  // 那时 agent 一启动就报模型不存在，用户还得回头找配置文件
  const cands = store.modelCandidates();
  if (cands.length && !cands.includes(model)) {
    throw new Error(`模型 ${model} 不在网关的模型清单里。先添加供应商与模型，或从清单里选。`);
  }

  // 🔴 关 → 开 的瞬间先存定版快照，**必须在 fn(model) 写文件之前**。
  // 已经开着（走网关）时再改模型，不能覆盖快照 —— 否则「关」会回到
  // 上一次改模型之前，而不是最初的样子。
  const cur = currentOf(agent);
  const snapshots = [];
  if (cur && cur.found && !cur.viaGateway) {
    for (const t of targetsOf(agent) || []) snapshots.push(saveOriginal(t.label, t.file));
  }

  const out = fn(model);
  // 记住这个工具用的模型，下次打开「Agent 指向」时回填它自己的值，
  // 而不是别人的值（四个工具共用一份模型是行不通的）。
  const agentModels = store.setAgentModel(agent, model);
  return { ...out, model, agentModels, snapshots };
}

// 关掉开关：回到开之前那一刻。
function turnOff(agent) {
  const targets = targetsOf(agent);
  if (!targets) throw new Error(`不支持该工具: ${agent}`);
  const cur = currentOf(agent);
  if (!cur || !cur.viaGateway) {
    // 本来就没走网关，什么都不用做（别误写文件）
    return { agent, alreadyOff: true, restored: [] };
  }

  const out = { agent, restored: [], skipped: [], usedOriginal: false };
  for (const t of targets) {
    const op = origFile(t.label, t.file);
    if (exists(op)) {
      const txt = readText(op);
      // 形状校验：宁可报错也不写坏。claude / pi 走 JSON 解析检查，
      // codex 是纯文本，只要非空即可（TOML 不做零依赖解析）。
      let good = txt != null;
      if (good && t.ok) {
        let parsed = null;
        try { parsed = JSON.parse(txt); } catch { good = false; }
        if (good && !t.ok(parsed)) good = false;
      }
      if (!good) {
        out.skipped.push({ file: t.file, reason: "原始快照读不出或形状不符，拒绝写入" });
        continue;
      }
      // 关之前把「正在用的网关配置」也留一份，方便后悔
      backup(t.label + "-undo", t.file);
      writeAtomic(t.file, txt);
      out.restored.push(t.file);
      out.usedOriginal = true;
      try { fs.unlinkSync(op); } catch { /* 删不掉也不影响正确性 */ }
    } else {
      out.skipped.push({ file: t.file, reason: "没有开启前的快照（可能是更早版本开的），请用「还原」" });
    }
  }
  return out;
}

// ---- 还原 ----
//
// 还原策略：从**最近一次指向时留下的备份**里取原值，精确回填。
// 不猜「默认应该是 sonnet」这类值——用户的原始配置可能本来就是个中转站。
//
// magpie 的做法是 `magpie <agent> default`（回到厂商默认）。
// 这里更保守：回到「你点『指向』之前那一刻」，这才是不丢信息的选择。

function listBackups(tag) {
  try {
    return fs.readdirSync(BACKUP_DIR)
      // 🔴 必须匹配 "tag-" 而不是 "tag"，也不能只 startsWith。
      // 曾经的坑：listBackups("pi") 用 startsWith 把 "pi-settings-*.json"
      // 也算成 pi 的备份，还原时把 settings 的内容写进了 models.json，
      // 直接把用户的模型配置写坏（顶层 providers 键消失）。
      //
      // 还要排除我们自己写的三类文件，它们同样以 `tag-` 开头：
      //   `-original`  开之前那份原始配置（开关关闭时用它）
      //   `-undo`      关掉之前给网关配置留的后悔药
      // 不排除的话，`sort().reverse()` 会把这些当成「最新备份」拿去还原。
      .filter((f) => f.startsWith(tag + "-")
        && !/-(original|undo)-?/.test(f)
        && /\.(json|toml|jsonc|yaml|yml)$/i.test(f))
      .sort().reverse()
      .map((f) => path.join(BACKUP_DIR, f));
  } catch { return []; }
}

function restoreClaude() {
  const list = listBackups("claude");
  if (!list.length) throw new Error("没有找到 claude 的备份，无法还原");
  const orig = readJson(list[0]);
  if (!orig) throw new Error("备份文件损坏: " + list[0]);
  const bk = backup("claude-restore", FILES.claude);
  writeAtomic(FILES.claude, JSON.stringify(orig, null, 2) + "\n");
  return { agent: "claude", restoredFrom: list[0], backupOfCurrent: bk };
}

function restoreCodex() {
  const list = listBackups("codex");
  if (!list.length) throw new Error("没有找到 codex 的备份，无法还原");
  const orig = readText(list[0]);
  if (orig == null) throw new Error("备份文件读不到: " + list[0]);
  const bk = backup("codex-restore", FILES.codex);
  writeAtomic(FILES.codex, orig);
  return { agent: "codex", restoredFrom: list[0], backupOfCurrent: bk };
}

// 还原 pi 的两个文件。
//
// 🔴 这里必须做**形状校验**：备份文件的内容要符合目标文件的结构，
// 对不上就拒绝写。曾经发生过的真实事故：备份前缀匹配串了，
// settings 的内容被当成 models.json 还原，直接把 providers 键写没，
// 用户的模型配置整个消失。校验能保证「宁可报错也不写坏」。
function looksLikePiModels(o) {
  return !!o && typeof o === "object" && !Array.isArray(o) &&
    o.providers && typeof o.providers === "object" && !Array.isArray(o.providers);
}
function looksLikePiSettings(o) {
  return !!o && typeof o === "object" && !Array.isArray(o) &&
    ("defaultProvider" in o || "defaultModel" in o || "theme" in o || "enabledModels" in o);
}
// claude 的 settings.json 必须有 env 对象（哪怕空对象）。
// 只判「是 JSON 对象」不够：一份 {} 也能通过，写回去就把用户
// 整个 Claude Code 配置抹平了 —— 那是不可逆的事故。
function looksLikeClaude(o) {
  return !!o && typeof o === "object" && !Array.isArray(o) &&
    o.env && typeof o.env === "object" && !Array.isArray(o.env);
}

function restorePi() {
  const models = listBackups("pi");
  const settings = listBackups("pi-settings");
  if (!models.length && !settings.length) throw new Error("没有找到 pi 的备份，无法还原");
  const out = { agent: "pi", restored: [], skipped: [] };

  if (models.length) {
    // 从新到旧找第一个形状正确的，避免被误标的历史备份带偏
    const hit = models.map((f) => ({ f, o: readJson(f) })).find((x) => looksLikePiModels(x.o));
    if (hit) {
      const bk = backup("pi-restore", FILES.piModels);
      writeAtomic(FILES.piModels, JSON.stringify(hit.o, null, 2) + "\n");
      out.restored.push(FILES.piModels);
      out.backupOfCurrent = bk;
    } else {
      out.skipped.push({ file: FILES.piModels, reason: "备份里没有 providers 结构，拒绝写入" });
    }
  }

  if (settings.length) {
    const hit = settings.map((f) => ({ f, o: readJson(f) })).find((x) => looksLikePiSettings(x.o));
    if (hit) {
      const bk = backup("pi-settings-restore", FILES.piSettings);
      writeAtomic(FILES.piSettings, JSON.stringify(hit.o, null, 2) + "\n");
      out.restored.push(FILES.piSettings);
    } else {
      out.skipped.push({ file: FILES.piSettings, reason: "备份形状不像 settings.json，拒绝写入" });
    }
  }
  return out;
}

const RESTORE = { claude: restoreClaude, codex: restoreCodex, pi: restorePi };

function restore(agent) {
  const fn = RESTORE[agent];
  if (!fn) throw new Error(`不支持还原该工具: ${agent}`);
  return fn();
}

module.exports = {
  detectAll, detectClaude, detectCodex, detectPi, detectDsh,
  applyTo, turnOff, restore, listBackups,
  isOurBase, isOurHostWrongPath, GW_BASE,
  GW_PROVIDER_ID, GW_KEY_PLACEHOLDER, BACKUP_DIR, FILES,
};
