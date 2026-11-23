// 会话文件删除 —— macOS 实现（~/.Trash）
//
// 与两个平台的差别：
//   Linux   freedesktop 规范，自己写 files/ + info/*.trashinfo
//   Windows Shell API（IFileOperation），走 PowerShell 托管封装
//   macOS   没有公开的「进废纸篓」系统 API。可用路径只有两条：
//
//     1) 让 Finder 删（osascript → tell application "Finder" to delete）。
//        好处是文件带「放回原处」元数据；代价是要 Automation 权限（TCC），
//        无人值守的 LaunchAgent 首次调用会静默被拒（-1743），而且可能弹窗。
//        因此**不做默认**，仅在 AGENTHIST_MAC_TRASH=finder 时尝试，失败自动退回。
//
//     2) 直接 rename 进 ~/.Trash。这是 Finder 废纸篓本身就认的目录，
//        文件会正常出现在废纸篓里、可以拖出来还原、也会被「清空废纸篓」清掉。
//        唯一缺的是「放回原处」菜单项（那条元数据由 Finder 写入）。
//        无权限提示、无外部依赖、行为确定 —— 作为默认实现。
//
// 重名处理用 macOS 自己的习惯（`name 2.jsonl`，编号在扩展名前），
// 而不是 Linux 的 `name.jsonl.1`，这样在 Finder 里看起来和系统行为一致。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { HOME } = require("./config");
const { resolveCommand } = require("./platform");

const TRASH = path.join(HOME, ".Trash");

function ensureTrash() {
  fs.mkdirSync(TRASH, { recursive: true, mode: 0o700 });
}

// `报告 2.jsonl` 这种形式：编号插在扩展名之前
function uniqueName(src) {
  const base = path.basename(src);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  let name = base;
  for (let n = 2; n < 10000; n++) {
    if (!fs.existsSync(path.join(TRASH, name))) return name;
    name = stem + " " + n + ext;
  }
  // 极端情况（同名一万个）退化成时间戳，绝不覆盖已有文件
  return stem + " " + Date.now() + ext;
}

// 走 Finder 删除：成功返回 true。任何一步不顺都返回 false 交给调用方兜底。
// 用 -e 分多条而不是拼一个长脚本，避免路径里的引号参与 AppleScript 解析：
// 路径通过 `POSIX file` 的 argv 形式传入（osascript 支持 `-e ... POSIX file x`？
// 不支持 argv 插值，所以这里改为把路径当作 AppleScript 字符串字面量，做双引号转义）。
function viaFinder(src) {
  const script =
    'tell application "Finder" to delete (POSIX file "' +
    String(src).replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
    '")';
  const r = spawnSync(resolveCommand("osascript") || "osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 15000,
  });
  if (r.error || r.status !== 0) return false;
  // 以「源文件是否真的消失」为唯一判据，不信任返回文本
  try { fs.statSync(src); return false; } catch { return true; }
}

// 移入废纸篓。返回 { name, file, info, size }
function moveToTrash(src) {
  let st;
  try { st = fs.statSync(src); } catch { throw new Error("文件不存在或已删除"); }
  if (!st.isFile()) throw new Error("只允许删除普通文件");

  if (process.env.AGENTHIST_MAC_TRASH === "finder" && viaFinder(src)) {
    return { name: path.basename(src), file: TRASH, info: "", size: st.size, via: "finder" };
  }

  ensureTrash();
  const name = uniqueName(src);
  const dest = path.join(TRASH, name);
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === "EXDEV") {
      // 跨卷（外置盘 / 网络盘）时 rename 不可用，退化为复制后删除
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
  return { name, file: dest, info: "", size: st.size, via: "move" };
}

module.exports = { moveToTrash, trashDir: TRASH, TRASH };
