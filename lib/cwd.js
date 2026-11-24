// cwd 归一化：把用户写的工作目录变成绝对路径，再校验是不是真目录。
//
// 🔴 为什么需要这个（2026-11-24 实测）：用户在「新建会话」里填 `~` 会被
// `fs.statSync("~")` 判成不存在 —— Node 的 fs 不做 shell 展开，`~` 只是
// 一个普通文件名。而 `~` 恰恰是最自然的写法，于是报「工作目录不存在或不是
// 目录：~」，看起来就像「新建会话失败了」。
//
// 同理要处理的还有：
//   · 相对路径（`opensession`、`./sub`）—— 相对谁？答案只能是 HOME 或
//     进程 cwd，两者都不确定，所以统一按 HOME 解析并在提示里回显绝对路径，
//     用户一眼能看到实际用的是哪个目录。
//   · 尾部斜杠 / 重复斜杠（`/a/b/`、`/a//b`）—— statSync 本来能吃，但
//     dsh 的会话目录名是 cwd 转义出来的，多一个斜杠就对不上原目录。
//   · 反斜杠路径（从 Windows 复制过来贴进 Linux 输入框）—— 转成正斜杠后再判。
//   · 首尾引号（从终端复制 `"..."` 时带上）—— 去掉。
//
// 只在「新建」时严格（必须真目录）；「恢复」时调用方另有兜底逻辑，
// 这里只提供归一化，不替调用方决定失败后怎么办。
const fs = require("fs");
const path = require("path");
const { HOME } = require("./config");

// 把 `~` 展开、相对路径按 HOME 解析、斜杠归一。
// 返回绝对路径字符串（不保证存在）。
function normalizeCwd(input) {
  let s = String(input == null ? "" : input).trim();
  // 用户在终端里复制路径时常带引号
  if (s.length >= 2 && ((s[0] === '"' && s[s.length - 1] === '"') ||
      (s[0] === "'" && s[s.length - 1] === "'"))) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return "";

  // Windows 风格路径（`C:\x\y` 或 `\\server\share`）在 Windows 上原样保留，
  // 在其它平台把它当普通字符串（不可能是有效目录，交给调用方报错）。
  const isWinPath = /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s);
  if (!isWinPath) s = s.replace(/\\/g, "/");

  // `~` 与 `~/xxx`：只有第一个 `~` 会展开（`~user` 形式各家 shell 支持不一，
  // 这里不猜，只处理自己的 HOME）。
  if (s === "~") s = HOME;
  else if (s.startsWith("~/")) s = path.join(HOME, s.slice(2));

  // 相对路径统一按 HOME 解析：进程 cwd 是服务启动目录，用户完全不可见，
  // 按它解析会造出一个谁都想不到的会话。
  if (!path.isAbsolute(s) && !isWinPath) s = path.join(HOME, s);

  // 去掉尾部斜杠（根目录除外），并收敛重复分隔符 —— dsh 的目录名是 cwd
  // 逐字符转义出来的，`/a/b/` 和 `/a/b` 会得到两个不同的会话目录。
  const parsed = path.normalize(s);
  return parsed.length > 1 && /[\\/]$/.test(parsed) ? parsed.slice(0, -1) : parsed;
}

// 归一化 + 存在性校验。返回 { ok, cwd, error }
//   error 里的路径用归一化后的绝对路径，用户能看出 `~` 实际指向哪儿。
function resolveCwd(input) {
  const raw = String(input == null ? "" : input).trim();
  const cwd = normalizeCwd(raw);
  if (!cwd) return { ok: false, cwd: "", error: "请填写工作目录" };
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDir) {
    // `~` / 相对路径被展开过时，把「原本写的 → 实际解析成」一起回显。
    // 否则用户看到「不存在：/home/xxx/opensession」会以为自己填的是对的，
    // 完全猜不到是我们按主目录解析了相对路径。
    const hint = (raw && raw !== cwd && !/^[A-Za-z]:[\\/]/.test(raw))
      ? "（由 " + raw + " 解析而来）" : "";
    return { ok: false, cwd, error: "工作目录不存在或不是目录：" + cwd + hint };
  }
  return { ok: true, cwd, error: "" };
}

module.exports = { normalizeCwd, resolveCwd };
