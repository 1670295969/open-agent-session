// 会话文件删除 —— Linux 实现（freedesktop 回收站）
//
// 规范：~/.local/share/Trash/files 存文件本体，info/<name>.trashinfo 存原始路径
//       与删除时间（Path 按 URL 百分号编码，斜杠保留）。写 info 在前、搬文件在后，
//       搬失败要回滚 info，否则回收站里会留悬空条目。
const fs = require("fs");
const path = require("path");
const { HOME } = require("./config");

const TRASH = path.join(HOME, ".local", "share", "Trash");
const T_FILES = path.join(TRASH, "files");
const T_INFO = path.join(TRASH, "info");

function ensureDirs() {
  fs.mkdirSync(T_FILES, { recursive: true });
  fs.mkdirSync(T_INFO, { recursive: true });
}

// 按 freedesktop 规范做 percent-encode，斜杠保留
function encPath(p) {
  return String(p).split("/").map(encodeURIComponent).join("/");
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" +
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// 回收站里重名时追加 .1 / .2，避免覆盖之前删掉的文件
function uniqueName(src) {
  const base = path.basename(src);
  let name = base, n = 1;
  for (;;) {
    const f = path.join(T_FILES, name);
    const i = path.join(T_INFO, name + ".trashinfo");
    if (!fs.existsSync(f) && !fs.existsSync(i)) return name;
    name = base + "." + n++;
  }
}

// 目录的「大小」= 递归累加所有文件字节数（回收站展示用）
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略不可读项 */ } }
    }
  }
  return total;
}

// 移入回收站。返回 { name, file, info, size }
//
// 支持目录：dsh 的会话是「一个 session-<uuid> 目录 + 里面两个文件」，
// 只搬 .zstd 会留下孤儿目录和锁文件，所以必须整目录进回收站。
// freedesktop 规范本身允许回收站里放目录，不需要特殊处理。
function moveToTrash(src) {
  ensureDirs();
  let st;
  try { st = fs.statSync(src); } catch { throw new Error("文件不存在或已删除"); }
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) throw new Error("只允许删除普通文件或目录");

  const name = uniqueName(src);
  const dest = path.join(T_FILES, name);
  const infoPath = path.join(T_INFO, name + ".trashinfo");

  fs.writeFileSync(
    infoPath,
    "[Trash Info]\nPath=" + encPath(src) + "\nDeletionDate=" + stamp() + "\n",
    { mode: 0o600 }
  );

  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === "EXDEV") {
      // 跨文件系统时 rename 不可用，退化为复制后删除
      if (isDir) {
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      } else {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
      }
    } else {
      try { fs.unlinkSync(infoPath); } catch {}
      throw e;
    }
  }
  return { name, file: dest, info: infoPath, size: isDir ? dirSize(dest) : st.size };
}

module.exports = { moveToTrash, TRASH, trashDir: T_FILES };
