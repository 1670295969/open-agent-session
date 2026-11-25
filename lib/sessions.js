// 会话聚合服务：合并各家扫描结果 + 按 mtime 排序 + 短时缓存
const { SESSION_CACHE_MS } = require("./config");
const { scanClaude } = require("./scanners/claude");
const { scanCodex } = require("./scanners/codex");
const { scanPi } = require("./scanners/pi");
const { scanHermes } = require("./scanners/hermes");
const { scanDsh } = require("./scanners/dsh");

const CACHE = { sessions: [], ts: 0 };

/* 归一：去掉子代理转录 + 同一会话的重复文件。
   🔴 为什么必须在聚合层做而不是各家扫描器里各删各的：
   1. 子代理（claude 的 subagents/agent-*.jsonl、codex 的 source.subagent）里的会话 id
      写的都是**父会话 id**，单独列出来就是列表里同名重复条目。它们的产出本来就在
      父会话的 tool_result 里，不需要重复展示。
   2. 同一 (tool,id) 出现多个文件的情况确实存在（codex 老版本 rollouts 会被复制、
      会话被中断重开后留下半截文件）。保留**体积最大**的那个 —— 它最可能是完整转录；
      体积相同则取 mtime 更新的。
   返回顺序保持 mtime 倒序不变。 */
function dedupe(all) {
  const best = new Map();
  for (const s of all) {
    if (s.sub) continue;
    const k = s.tool + "\u0000" + s.id;
    const cur = best.get(k);
    if (!cur) { best.set(k, s); continue; }
    const bigger = s.size > cur.size || (s.size === cur.size && s.mtime > cur.mtime);
    if (bigger) best.set(k, s);
  }
  return Array.from(best.values());
}

async function getAllSessions(force = false) {
  if (!force && CACHE.sessions.length && Date.now() - CACHE.ts < SESSION_CACHE_MS) {
    return CACHE.sessions;
  }
  const all = (await Promise.all([
    scanClaude(), scanCodex(), scanPi(), scanHermes(), scanDsh(),
  ])).flat();
  const uniq = dedupe(all);
  uniq.sort((a, b) => b.mtime - a.mtime);
  CACHE.sessions = uniq;
  CACHE.ts = Date.now();
  return uniq;
}

// 删除文件后立即让缓存失效，避免列表里还残留已删条目
function invalidateSessions() {
  CACHE.sessions = [];
  CACHE.ts = 0;
}

module.exports = { getAllSessions, invalidateSessions };
