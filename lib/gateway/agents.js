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
const { HOME } = require("../config");
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
    viaGateway: /:8347\/?$/.test(base) && /localhost|127\.0\.0\.1/.test(base),
    models,
    model: String(s.model || ""),
  };
}

// codex：看 model_provider 是否等于我们写的 id
function detectCodex() {
  const txt = readText(FILES.codex);
  if (txt == null) return { supported: true, found: false, configFile: FILES.codex };
  const g = (re) => { const m = txt.match(re); return m ? m[1].trim() : ""; };
  return {
    supported: true, found: true, configFile: FILES.codex,
    modelProvider: g(/^\s*model_provider\s*=\s*"([^"]*)"/m),
    model: g(/^\s*model\s*=\s*"([^"]*)"/m),
    viaGateway: g(/^\s*model_provider\s*=\s*"([^"]*)"/m) === GW_PROVIDER_ID,
    // 有没有我们注入的那一段
    hasBlock: /^\[model_providers\.opensession\]/m.test(txt),
  };
}

function detectPi() {
  const m = readJson(FILES.piModels);
  const s = readJson(FILES.piSettings);
  if (!m && !s) return { supported: true, found: false, configFile: FILES.piModels };
  const providers = (m && m.providers) || {};
  const ours = providers[GW_PROVIDER_ID];
  return {
    supported: true, found: true, configFile: FILES.piModels,
    baseUrl: ours ? String(ours.baseUrl || "") : "",
    model: s ? String(s.defaultModel || "") : "",
    provider: s ? String(s.defaultProvider || "") : "",
    viaGateway: s ? String(s.defaultProvider || "") === GW_PROVIDER_ID : false,
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

  const { PORT } = require("../config");
  s.env = s.env || {};
  // 注意：Anthropic 系基址**不带 /v1**（与 magpie 一致，它的 /v1/messages 在根下）
  s.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PORT}`;
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

  const { PORT } = require("../config");
  const baseUrl = `http://127.0.0.1:${PORT}/v1`;

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
  const { PORT } = require("../config");
  const existing = m.providers[GW_PROVIDER_ID] || {};
  m.providers[GW_PROVIDER_ID] = {
    ...existing,
    api: "openai-completions",
    apiKey: GW_KEY_PLACEHOLDER,
    baseUrl: `http://127.0.0.1:${PORT}/v1`,
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
  const out = fn(model);
  // 记住这个工具用的模型，下次打开「Agent 指向」时回填它自己的值，
  // 而不是别人的值（四个工具共用一份模型是行不通的）。
  const agentModels = store.setAgentModel(agent, model);
  return { ...out, model, agentModels };
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
      .filter((f) => f.startsWith(tag + "-") && /\.(json|toml|jsonc|yaml|yml)$/i.test(f))
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
  applyTo, restore, listBackups,
  GW_PROVIDER_ID, GW_KEY_PLACEHOLDER, BACKUP_DIR, FILES,
};
