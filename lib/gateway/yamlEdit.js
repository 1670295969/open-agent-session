// 零依赖的 YAML「行编辑」工具
//
// 为什么不引 js-yaml，也不用 JSON 往返：
//
// dsh 的 cordis.patch.yml 和 hermes 的 config.yaml 都是**人写的** YAML ——
// 里面有注释（`# 复用 Hermes 阶段已有的 MoAPI 网关`）、有 `!!js` 表达式、
// 有刻意对齐的缩进、有 `- insert:` 这种 loader 指令。用 js-yaml 读进来再吐出去，
// 注释全丢、键顺序可能变、`off:` 这种空值（YAML 里是 null）会被写成 `off: null`，
// 用户的文件就不再是他写的那个文件了。这是不可接受的破坏。
//
// 所以这里只做一件事：**把文件当成行数组，按缩进结构定位到某一行，改那一行的值**，
// 或者在某一行后面插入一段新文本。其余行一个字节都不碰。
//
// 能力刻意做得极窄 —— 只够改我们自己的那几个键：
//   · findTopKey      顶层键（缩进 0）及其块范围
//   · findListItem    顶层数组里 `- id: xxx` 的项及其块范围
//   · getScalar       读块内某个键的标量值
//   · setScalar       改块内某个键的标量值（保留行尾注释与引号风格）
//   · insertAfter     在块末尾插入一段文本
//   · removeBlock     删掉整个块（连同它后面的空行）
//
// 不解析、不校验、不重排。判断「这份 YAML 说得对不对」是 dsh / hermes 自己的事，
// 我们只保证「除了我们改的那行，其他都还是原样」。

function splitLines(txt) {
  return String(txt == null ? "" : txt).split("\n");
}

// 一行的缩进宽度。Tab 按 1 计（YAML 不允许 tab 缩进，真出现了也不该崩）。
function indentOf(line) {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

function isBlank(line) {
  return /^\s*$/.test(line);
}

// 从 start 之后找出「同级或更浅缩进」的第一行下标。
// 空行不算结束 —— 块中间的空行属于块内。
function blockEnd(lines, start, indent) {
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= indent) return i;
  }
  return lines.length;
}

// 顶层键：`key:` 或 `key: value`，缩进 0
function findTopKey(lines, key) {
  const re = new RegExp(`^${key}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) === 0 && re.test(lines[i])) {
      return { line: i, start: i, end: blockEnd(lines, i, 0) };
    }
  }
  return null;
}

// 顶层数组项：`- id: <id>`（缩进 0 的 `- ` 开头）
function findListItem(lines, id) {
  const re = new RegExp(`^-\\s+id\\s*:\\s*["']?${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*(?:#.*)?$`);
  for (let i = 0; i < lines.length; i++) {
    if (indentOf(lines[i]) === 0 && re.test(lines[i])) {
      return { line: i, start: i, end: blockEnd(lines, i, 0) };
    }
  }
  return null;
}

// 在 block（行下标范围）里找某个键。keyPath 支持 `a.b` 这种两级。
// maxDepth 是**相对于 block 起始行**的最大缩进（单位：空格数），
// 用来避免误抓深层同名键 —— 比如 `models` 在很多层级都有。
function findInBlock(lines, block, keyPath, opts) {
  const segs = String(keyPath).split(".");
  const rootIndent = indentOf(lines[block.start]);
  const maxDepth = (opts && opts.maxDepth) || 0; // 0 = 不限
  let from = block.start;
  let baseIndent = rootIndent;
  for (let s = 0; s < segs.length; s++) {
    const last = s === segs.length - 1;
    const re = new RegExp(`^\\s{${baseIndent + 1},}${segs[s]}\\s*:`);
    let found = -1;
    for (let i = from; i < block.end; i++) {
      if (isBlank(lines[i])) continue;
      const ind = indentOf(lines[i]);
      if (ind <= baseIndent) continue;
      if (maxDepth && last && ind - rootIndent > maxDepth) continue;
      if (re.test(lines[i])) { found = i; break; }
    }
    if (found < 0) return null;
    if (last) {
      const ind = indentOf(lines[found]);
      return { line: found, start: found, end: blockEnd(lines, found, ind), indent: ind };
    }
    baseIndent = indentOf(lines[found]);
    from = found;
  }
  return null;
}

// 读标量：`  key: value   # 注释` → value（去引号、去注释）
function readScalar(line) {
  const m = line.match(/^\s*[^:]+:\s*(.*)$/);
  if (!m) return null;
  let v = m[1];
  // 去掉行尾注释（引号内的 # 不算）—— 简单扫描，够用
  let q = null;
  let cut = v.length;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(v[i - 1]))) { cut = i; break; }
  }
  v = v.slice(0, cut).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function getScalar(lines, block, keyPath, opts) {
  const f = findInBlock(lines, block, keyPath, opts);
  if (!f) return null;
  const v = readScalar(lines[f.line]);
  return v === "" ? null : v;
}

// 改标量，保留缩进、行尾注释与原来的引号风格。
// 原来带引号的写成带引号的（`"high"` 不要变成 `high`）—— 有些键的值
// 需要引号（比如 `"off"`，YAML 1.1 里裸 off 是布尔 false）。
function setScalar(lines, block, keyPath, value, opts) {
  const f = findInBlock(lines, block, keyPath, opts);
  if (!f) return { ok: false, reason: `找不到键 ${keyPath}` };
  const src = lines[f.line];
  const km = src.match(/^(\s*[^:]+:\s*)(.*)$/);
  if (!km) return { ok: false, reason: `行格式看不懂: ${src}` };
  const prefix = km[1];
  const rest = km[2];
  // 行尾注释原样保留（引号内的 # 不算注释）
  let comment = "";
  let q = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(rest[i - 1]))) { comment = rest.slice(i).trim(); break; }
  }
  // 原来用引号则继续用引号 —— 有些值必须引号（`"off"`，YAML 1.1 里裸 off 是 false）
  const oldVal = readScalar(src) || "";
  const hadQuote = /^\s*(?:"[^"]*"|'[^']*')\s*(?:#|$)/.test(rest);
  const out = hadQuote ? `"${String(value).replace(/"/g, '\\"')}"` : String(value);
  lines[f.line] = prefix + out + (comment ? " " + comment : "");
  return { ok: true, line: f.line, from: oldVal, to: String(value) };
}

function insertBlock(lines, afterLine, text) {
  const add = String(text).split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  lines.splice(afterLine + 1, 0, ...add);
  return add.length;
}

// 删块：连它后面紧跟的空行一起删（否则会留下大片空白）
function removeBlock(lines, block) {
  let end = block.end;
  while (end < lines.length && isBlank(lines[end])) end++;
  const n = end - block.start;
  lines.splice(block.start, n);
  return n;
}

module.exports = {
  splitLines, indentOf, isBlank, blockEnd,
  findTopKey, findListItem, findInBlock,
  readScalar, getScalar, setScalar, insertBlock, removeBlock,
};
