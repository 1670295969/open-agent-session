// 全文搜索：跨会话搜消息正文与思考内容
//
// 为什么需要它：左侧搜索框原先只匹配「标题 + cwd」，想找「上次那个讨论」时
// 只能逐个点开翻。实测 161 个会话、正文合计约 7MB，全量解析 3.2s —— 单次可接受，
// 但用户会连续改关键词，所以必须缓存解析结果，让后续搜索落到毫秒级。
//
// 缓存键是 file，命中条件是 mtime + size 都没变。这两个都变说明文件被追加过
// （会话还在跑）或被外部改写，必须重新解析。
// 不另建倒排索引：串行 indexOf 走 6361 条消息本身就在几十毫秒内，建索引的
// 复杂度（增量更新、失效、落盘）远大于收益。
const { parseSession } = require("./parsers");
const { getAllSessions } = require("./sessions");
const { MAX_MSG_CHARS } = require("./config");

const CACHE = new Map();
const MAX_CACHE = 400;      // 会话文件数上限，超过就淘汰最早插入的
const RADIUS = 68;          // 片段里关键词两侧各留多少字
const MAX_HITS_PER_SESSION = 6;
const MAX_RESULTS = 60;
const DEADLINE_MS = 12000;  // 超过就返回已完成的部分，不让请求无限挂着

async function loadMsgs(s) {
  const c = CACHE.get(s.file);
  if (c && c.mtime === s.mtime && c.size === s.size) return c.msgs;
  let msgs = [];
  try { msgs = await parseSession(s.file, s.tool); } catch { msgs = []; }
  if (CACHE.size >= MAX_CACHE) {
    // 简单 FIFO 淘汰：Map 保持插入顺序，取第一个即最早插入的
    const k = CACHE.keys().next().value;
    if (k !== undefined) CACHE.delete(k);
  }
  CACHE.set(s.file, { mtime: s.mtime, size: s.size, msgs });
  return msgs;
}

// 关键词转正则。必须转义：用户可能输入 `.` `(` `[` 这类字符，
// 不转义会当成正则语法，轻则匹配错，重则抛异常。
function keywordRe(q) {
  return new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
}

/* 从 text 的 from 位置开始找下一个命中，截出「前文 + 命中 + 后文」三段纯文本。
   返回纯文本而不是 HTML：前端自己 esc 再拼 <mark>，后端不产出任何标签，
   这样会话内容里的尖括号永远不可能变成可执行的东西。
   用正则 exec 而不是 toLowerCase().indexOf()：某些字符小写化后长度会变
   （如 'İ' → 'i̇'），按长度算索引会整体错位，切出来的片段是乱的。 */
function nextSnippet(text, re, from) {
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m) return null;
  const i = m.index, len = m[0].length;
  const start = Math.max(0, i - RADIUS);
  return {
    pre: (start > 0 ? "…" : "") + text.slice(start, i),
    hit: text.slice(i, i + len),
    post: text.slice(i + len, Math.min(text.length, i + len + RADIUS)) +
          (i + len + RADIUS < text.length ? "…" : ""),
    at: i,
  };
}

// 单条消息最多给 2 个片段（正文 1 个 + 思考 1 个），再多只是重复
function hitsOfMsg(m, re) {
  const out = [];
  for (const [field, label] of [["text", ""], ["think", "思考"]]) {
    const raw = m[field];
    if (!raw) continue;
    const text = raw.length > MAX_MSG_CHARS ? raw.slice(0, MAX_MSG_CHARS) : raw;
    const sn = nextSnippet(text, re, 0);
    if (sn) out.push({ ...sn, field, fieldLabel: label, role: m.role });
  }
  return out;
}

/* 主入口。返回:
     { q, took, total, truncated, results: [
         { file, tool, id, title, cwd, mtime, count,
           hits: [{ i, role, field, fieldLabel, pre, hit, post, at }] } ] }
   total = 命中的会话数（不是消息数），truncated = 是否因上限/超时被截断。 */
async function search(q, opts = {}) {
  const t0 = Date.now();
  const query = String(q || "").trim();
  if (!query) return { q: "", took: 0, total: 0, truncated: false, results: [] };

  const re = keywordRe(query);
  const all = await getAllSessions(false);
  const results = [];
  let truncated = false;

  for (const s of all) {
    // 时间筛选在扫描结果上先过一遍，省掉后面白解析的会话
    if (opts.since && s.mtime < opts.since) continue;
    if (opts.tool && opts.tool !== "all" && s.tool !== opts.tool) continue;
    if (Date.now() - t0 > DEADLINE_MS) { truncated = true; break; }

    const msgs = await loadMsgs(s);
    const hits = [];
    let count = 0;
    for (let i = 0; i < msgs.length; i++) {
      const h = hitsOfMsg(msgs[i], re);
      if (!h.length) continue;
      count += h.length;
      if (hits.length < MAX_HITS_PER_SESSION) {
        for (const x of h) {
          if (hits.length >= MAX_HITS_PER_SESSION) break;
          hits.push({ i, ...x, time: msgs[i].time || "" });
        }
      }
    }
    if (!count) continue;
    results.push({
      file: s.file, tool: s.tool, id: s.id, title: s.title,
      cwd: s.cwd, mtime: s.mtime, count, hits,
    });
    if (results.length >= MAX_RESULTS) { truncated = true; break; }
  }

  // 命中多的排前面，同数量按最近修改排 —— 找线索时「聊得多的那个」通常就是想找的
  results.sort((a, b) => b.count - a.count || b.mtime - a.mtime);
  return { q: query, took: Date.now() - t0, total: results.length, truncated, results };
}

// 删除会话后清缓存，避免搜到已删条目（与 sessions.invalidateSessions 配套调用）
function invalidateSearch() {
  CACHE.clear();
}

module.exports = { search, invalidateSearch };
