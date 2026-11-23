// 会话文件删除 —— 统一入口
//
// 分层理由：**路径白名单校验是安全底线，三个平台完全一样**，没有理由各写一遍；
// 真正有平台差异的只有「往哪儿搬」这一步。所以这里保留校验，搬运按平台分派。
//
// 安全底线（不要为了「方便」改成 fs.unlink）：
//   1. 路径白名单：realpath 解析后必须落在下面 RULES 的某个根目录内，
//      这样 `~/.claude/projects/../../.ssh/id_rsa` 这类穿越会被拒；
//      符号链接逃逸同理（realpath 已展开）。
//   2. 扩展名 + 文件名白名单：不允许删 hermes 的 _index.json 之类的索引文件。
//   3. 一律进回收站（Linux: freedesktop / Windows: 系统回收站 / macOS: ~/.Trash），可还原。
const fs = require("fs");
const path = require("path");
const { HOME } = require("./config");
const { IS_WIN, IS_MAC } = require("./platform");

const impl = IS_WIN
  ? require("./trash-win")
  : IS_MAC
    ? require("./trash-mac")
    : require("./trash-linux");

// 可删除范围。dir 为根，ext 允许的扩展名，not/prefix 进一步收窄文件名
const RULES = [
  { dir: path.join(HOME, ".claude", "projects"), ext: [".jsonl"] },
  { dir: path.join(HOME, ".codex", "sessions"), ext: [".jsonl"] },
  { dir: path.join(HOME, ".pi", "agent", "sessions"), ext: [".jsonl"] },
  // webui 的 _index.json 是索引，删了会丢全部条目，必须排除
  { dir: path.join(HOME, ".hermes", "webui", "sessions"), ext: [".json"], not: ["_index.json"] },
  // CLI 会话只认 session_*.json，同目录还有 request_dump_*.json 诊断文件不动
  { dir: path.join(HOME, ".hermes", "sessions"), ext: [".json"], prefix: "session_" },
];

// Windows 的路径比较不分大小写：`C:\Users\Alice` 与 `c:\users\alice` 是同一目录，
// 若按大小写敏感做 startsWith，真实存在的路径会被误判为「越界」。
function inRoot(real, root) {
  if (IS_WIN) {
    const a = real.toLowerCase(), b = root.toLowerCase();
    return a === b || a.startsWith(b + path.sep);
  }
  return real === root || real.startsWith(root + path.sep);
}

// 判断某个路径是否允许删除；返回 { ok, real } 或 { ok:false, error }
function resolveDeletable(file) {
  if (!file || typeof file !== "string") return { ok: false, error: "缺少 file 参数" };
  let real;
  try { real = fs.realpathSync(file); } catch { return { ok: false, error: "文件不存在或已删除" }; }
  let isFile = false;
  try { isFile = fs.statSync(real).isFile(); } catch { /* 忽略 */ }
  if (!isFile) return { ok: false, error: "只允许删除普通文件" };

  for (const r of RULES) {
    let root;
    try { root = fs.realpathSync(r.dir); } catch { continue; }
    if (!inRoot(real, root)) continue;
    if (!r.ext.includes(path.extname(real).toLowerCase())) continue;
    const base = path.basename(real);
    if (r.not && r.not.includes(base)) continue;
    if (r.prefix && !base.startsWith(r.prefix)) continue;
    return { ok: true, real };
  }
  return { ok: false, error: "该路径不在允许删除的会话目录内" };
}

// 移入回收站。返回 { name, file, info, size }（file 指向回收站位置，平台各异）
function moveToTrash(src) {
  return impl.moveToTrash(src);
}

module.exports = {
  moveToTrash, resolveDeletable,
  TRASH: impl.trashDir,
  trashDir: impl.trashDir,
};
