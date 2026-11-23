// 会话聚合服务：合并四家扫描结果 + 按 mtime 排序 + 短时缓存
const { SESSION_CACHE_MS } = require("./config");
const { scanClaude } = require("./scanners/claude");
const { scanCodex } = require("./scanners/codex");
const { scanPi } = require("./scanners/pi");
const { scanHermes } = require("./scanners/hermes");

const CACHE = { sessions: [], ts: 0 };

async function getAllSessions(force = false) {
  if (!force && CACHE.sessions.length && Date.now() - CACHE.ts < SESSION_CACHE_MS) {
    return CACHE.sessions;
  }
  const all = (await Promise.all([scanClaude(), scanCodex(), scanPi(), scanHermes()])).flat();
  all.sort((a, b) => b.mtime - a.mtime);
  CACHE.sessions = all;
  CACHE.ts = Date.now();
  return all;
}

// 删除文件后立即让缓存失效，避免列表里还残留已删条目
function invalidateSessions() {
  CACHE.sessions = [];
  CACHE.ts = 0;
}

module.exports = { getAllSessions, invalidateSessions };
