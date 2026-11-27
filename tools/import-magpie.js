#!/usr/bin/env node
// 把 magpie 的供应商与模型导进 OpenSession 网关
//
// 为什么要脚本而不是手工搬：magpie 两周迭代 400 个版本（0.1.4539 → 0.1.4940），
// 供应商随时会增删改。手工搬一次，下次它又变了就得再来一遍，还容易漏 key。
//
// 数据来源（只读，绝不写 magpie 的目录）：
//   <magpie>/providers.json   供应商：id/name/chat/anthropic/responses/models/key/keys/off
//   <magpie>/stash.json       pi 的 models.json 快照 —— 部分供应商（codex-for-me）
//                             在 providers.json 里不写 models，模型名只存在于这里
//   <magpie>/usage.jsonl      实际调用过的模型，作为最后兜底
//
// 落点：我们自己的一份（~/.config/opensession/gateway.json + gateway-keys.json），
// 不寄生 magpie 的格式 —— 它的字段随时会变，跟着读等于把命交给上游。
//
// 用法：
//   node tools/import-magpie.js                 # 导入
//   node tools/import-magpie.js --dry-run       # 只看会做什么，不落盘
//   node tools/import-magpie.js --no-groups     # 不生成自动路由组
//   node tools/import-magpie.js --from /path/to/magpie-config
//
// 幂等：同 id 的供应商已存在就**更新字段 + 合并密钥**（按 key 内容去重），
// 不会重复添加，也不会覆盖你在 OpenSession 里手改过的路由组。
//
// 🔴 输出永不含明文密钥：只报「新增了几把 / 已有几把」。
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const store = require("../lib/gateway/store");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = flag("--dry-run");
const WANT_GROUPS = !flag("--no-groups");
const SRC = opt("--from", path.join(os.homedir(), ".config", "magpie"));

// ---- 读 magpie 侧 ----

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function readProviders() {
  const d = readJson(path.join(SRC, "providers.json"), null);
  // magpie 把供应商放在 {providers:[...]}，但早期版本可能是裸数组
  const list = Array.isArray(d) ? d : d && Array.isArray(d.providers) ? d.providers : null;
  if (!list) {
    console.error(`✗ 读不到供应商：${path.join(SRC, "providers.json")}`);
    console.error("  用 --from 指定 magpie 配置目录。");
    process.exit(1);
  }
  return list;
}

// pi 的 models.json 快照：键形如 "cctq3/gpt-6.2-sol"，值是该模型的协议列表。
// 有些供应商在 providers.json 里根本不写 models（codex-for-me 就是），
// 但模型名在 magpie 写进 pi 的配置里是完整的。
function modelsFromStash() {
  const stash = readJson(path.join(SRC, "stash.json"), null);
  if (!stash || typeof stash !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(stash)) {
    if (!/models\.json:wanted$/.test(k) || typeof v !== "string") continue;
    let wanted;
    try { wanted = JSON.parse(v); } catch { continue; }
    for (const key of Object.keys(wanted || {})) {
      if (key === "*" || key.startsWith("auto/") || key.startsWith("group/")) continue;
      const i = key.indexOf("/");
      if (i < 0) continue;
      const pid = key.slice(0, i), model = key.slice(i + 1);
      (out[pid] = out[pid] || []).push(model);
    }
  }
  for (const pid of Object.keys(out)) out[pid] = uniq(out[pid]);
  return out;
}

// 最后兜底：这条供应商在 magpie 里真被调用过的模型名
function modelsFromUsage() {
  const file = path.join(SRC, "usage.jsonl");
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.provider || d.providerId;
    const m = d.model;
    if (!p || !m) continue;
    (out[p] = out[p] || []).push(m);
  }
  for (const pid of Object.keys(out)) out[pid] = uniq(out[pid]);
  return out;
}

// 用量次数：决定 defaultProvider 选谁（magpie 没有显式默认供应商）
function usageCount() {
  const file = path.join(SRC, "usage.jsonl");
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.provider || d.providerId;
    if (p) out[p] = (out[p] || 0) + 1;
  }
  return out;
}

function uniq(a) {
  const seen = new Set(), out = [];
  for (const x of a) { if (!seen.has(x)) { seen.add(x); out.push(x); } }
  return out;
}

// magpie 的密钥可能是三种形状：key（主 key 字符串）、keys（[{name,key}]）、两者并存。
// cctq3 就是两者并存 —— 主 key 一把，keys 里还有一把 cctq_codex。
function keysOfMagpie(p) {
  const out = [];
  const push = (name, key) => {
    const k = String(key || "").trim();
    if (!k) return;
    if (out.some((x) => x.key === k)) return;   // 同一个 key 别记两遍
    out.push({ name: String(name || "").trim(), key: k });
  };
  push("", p.key);
  for (const e of Array.isArray(p.keys) ? p.keys : []) {
    if (e && typeof e === "object") push(e.name, e.key);
    else if (typeof e === "string") push("", e);
  }
  return out;
}

// ---- 组装 ----

function plan() {
  const src = readProviders();
  const stashModels = modelsFromStash();
  const usedModels = modelsFromUsage();
  const counts = usageCount();

  const providers = [];
  const skipped = [];

  for (const p of src) {
    const id = String(p.id || "").trim();
    const enabled = p.off !== true;
    const keys = keysOfMagpie(p);

    // copilot 这种「off 且没 key 没模型」是 magpie 里的空壳占位，导过来只会
    // 在界面上多一行「缺密钥 + 已停用」，没有任何用处
    if (!id) { skipped.push({ id: "(无 id)", why: "没有 id" }); continue; }
    if (!enabled && !keys.length) {
      skipped.push({ id, why: "magpie 里已关闭且没有密钥" });
      continue;
    }

    const url = String(p.chat || "").trim();
    const anthropic = String(p.anthropic || "").trim();
    const responses = String(p.responses || "").trim();
    if (!url && !anthropic && !responses) {
      skipped.push({ id, why: "三种协议基址都没填" });
      continue;
    }

    // 模型名的来源要有优先级，并记下来源，方便日后核对
    let models = uniq((Array.isArray(p.models) ? p.models : []).map(String).filter(Boolean));
    let from = "providers.json";
    if (!models.length && stashModels[id] && stashModels[id].length) {
      models = stashModels[id].slice();
      from = "stash.json（magpie 写进 pi 的模型表）";
    }
    if (!models.length && usedModels[id] && usedModels[id].length) {
      models = usedModels[id].slice();
      from = "usage.jsonl（历史实际调用）";
    }

    const note = [];
    if (from !== "providers.json") note.push(`模型来自 ${from}，建议核对`);
    if (p.baseAPI) note.push(`magpie baseAPI=${p.baseAPI}`);
    // cctq3 与 cctq-codex-2 是同一个站点的两个 entry（同 key 同域名），保留两条
    // 是因为它们在 magpie 里挂了不同协议基址，合并会丢掉 chat 或 responses 之一
    if (p.was && Array.isArray(p.was) && p.was.length) note.push(`原名 ${p.was.join(", ")}`);

    providers.push({
      id, name: String(p.name || "").trim() || id,
      url, anthropic, responses, models, keys, enabled,
      note: note.join("；"),
    });
  }

  // 自动路由组：同一个模型名被 ≥2 家提供，就值得合成一个组。
  // 这正是 magpie 的 auto/<model> 在做的事（它的成员就是所有声明该模型的供应商）。
  const groups = [];
  if (WANT_GROUPS) {
    const byModel = {};
    for (const p of providers) {
      if (!p.enabled) continue;
      for (const m of p.models) (byModel[m] = byModel[m] || []).push(p.id + "/" + m);
    }
    for (const [m, members] of Object.entries(byModel)) {
      if (members.length < 2) continue;
      groups.push({
        name: "auto-" + m.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        models: members,
        routing: "order",
        note: `${m}：${members.length} 家都有，按顺序用，前一家失败自动换`,
      });
    }
  }

  // 默认供应商：magpie 没有这个概念，取它用得最多的那家（按调用次数）
  let defaultProvider = "";
  const ranked = providers.filter((p) => p.enabled && p.keys.length)
    .sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
  if (ranked.length) defaultProvider = ranked[0].id;

  return { providers, groups, skipped, defaultProvider };
}

// ---- 落盘 ----

function apply(p) {
  const before = store.load();

  // 🔴 必须在 addProvider 之前记下来：
  // addProvider 有副作用 —— 第一家加进去时会把 defaultProvider 设成它自己。
  // 等加完再判断「原来有没有默认」就晚了，永远判成「已有」，
  // 于是脚本报 rsu、落盘却是第一家（这个坑当场踩过）。
  const beforeDefault = before.defaultProvider &&
    before.providers.some((x) => x.id === before.defaultProvider) ? before.defaultProvider : "";

  let added = 0, updated = 0, keysNew = 0, keysKept = 0;

  for (const src of p.providers) {
    const exists = before.providers.find((x) => x.id === src.id);
    const oldKeys = exists ? store.keysOf(src.id) : [];
    const merged = oldKeys.slice();
    for (const k of src.keys) {
      if (merged.some((x) => x.key === k.key)) { keysKept++; continue; }
      merged.push(k);
      keysNew++;
    }

    if (exists) {
      store.updateProvider(src.id, {
        name: src.name, url: src.url, anthropic: src.anthropic, responses: src.responses,
        models: src.models, enabled: src.enabled, note: src.note,
        ...(merged.length ? { keys: merged } : {}),
      });
      updated++;
    } else {
      store.addProvider({
        id: src.id, name: src.name,
        url: src.url, anthropic: src.anthropic, responses: src.responses,
        models: src.models, enabled: src.enabled, note: src.note,
        ...(src.keys.length ? { keys: src.keys } : {}),
      });
      added++;
    }
  }

  // 路由组：存在的只补成员，不覆盖你手改过的 routing 与 note
  let gAdded = 0, gUpdated = 0;
  const cfgNow = store.load();
  for (const g of p.groups) {
    const cur = cfgNow.groups.find((x) => x.name === g.name);
    if (cur) {
      const missing = g.models.filter((m) => !cur.models.includes(m));
      if (missing.length) { store.updateGroup(g.name, { models: cur.models.concat(missing) }); gUpdated++; }
    } else {
      store.addGroup(g);
      gAdded++;
    }
  }

  // 默认供应商：只在你原本没有默认（或它已失效）时才设，不抢你手动选的
  if (p.defaultProvider && !beforeDefault) {
    store.setSettings({ defaultProvider: p.defaultProvider });
  }

  return { added, updated, keysNew, keysKept, gAdded, gUpdated };
}

// ---- 报告 ----

function report(p, res) {
  const w = (s, n) => String(s).padEnd(n);
  console.log(`来源：${path.join(SRC, "providers.json")}`);
  console.log("");
  console.log(`${w("供应商", 16)}${w("协议", 22)}${w("模型", 6)}${w("密钥", 6)}状态`);
  console.log("─".repeat(70));
  for (const x of p.providers) {
    const protos = [x.url && "Chat", x.anthropic && "Anthropic", x.responses && "Responses"].filter(Boolean).join("+");
    const st = !x.enabled ? "停用" : x.keys.length ? "就绪" : "缺密钥";
    console.log(w(x.id, 16) + w(protos, 22) + w(x.models.length, 6) + w(x.keys.length, 6) + st);
  }
  if (p.groups.length) {
    console.log("");
    console.log("自动路由组：");
    for (const g of p.groups) console.log(`  group/${w(g.name, 26)}${g.models.length} 家`);
  }
  if (p.skipped.length) {
    console.log("");
    console.log("跳过：");
    for (const s of p.skipped) console.log(`  ${w(s.id, 16)}${s.why}`);
  }
  console.log("");
  if (DRY) {
    console.log(`[dry-run] 会新增 ${p.providers.length} 家、${p.groups.length} 个组；未落盘。`);
    return;
  }
  console.log(`新增 ${res.added} 家、更新 ${res.updated} 家；密钥新增 ${res.keysNew} 把、已有 ${res.keysKept} 把；` +
    `路由组新增 ${res.gAdded} 个、补成员 ${res.gUpdated} 个。`);
  if (p.defaultProvider) console.log(`默认供应商：${p.defaultProvider}`);
  console.log("");
  console.log("下一步：网关开关打开 → 「测连通」逐家验一遍。");
}

const p = plan();
const res = DRY ? null : apply(p);
report(p, res);
