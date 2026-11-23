// 模型 / 思考强度目录（供前端下拉框）
// claude 与 codex 共用同一套 magpie 模型（settings.json modelPicker 与 magpie-models.json 同源），
// pi 用 pi --list-models。结果缓存 10 分钟。
//
// dsh 刻意不提供模型列表：它的模型定义在 profile 的 cordis.patch.yml 里，
// 是 YAML 嵌套结构（providers → models → reasoningEfforts），要解析得引第三方
// YAML 库，而这个项目是零依赖的。且 dsh 的 `-m` / `--reasoning` 每次都给默认值
// 也能正常工作，下拉框缺失不影响使用 —— 所以让它留空，前端会自动隐藏下拉。
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

function readCodexModels() {
  const cat = readJsonFile(path.join(HOME, ".codex", "magpie-models.json"));
  const models = cat && Array.isArray(cat.models) ? cat.models : [];
  const out = [];
  for (const m of models) if (m.slug) out.push({ id: m.slug, label: m.display_name || m.slug });
  return out;
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

const CACHE = { ts: 0, data: null };

function modelCatalog() {
  if (CACHE.data && Date.now() - CACHE.ts < MODEL_CACHE_MS) return CACHE.data;
  const data = {
    claude: readClaudeModels(),
    codex: readCodexModels(),
    pi: readPiModels(),
    dsh: [],   // 见文件头注释：不解析 profile YAML，留空由前端隐藏下拉
    efforts: EFFORTS,
  };
  CACHE.data = data;
  CACHE.ts = Date.now();
  return data;
}

module.exports = { modelCatalog, EFFORTS };
