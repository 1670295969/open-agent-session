// 终端启动 —— macOS 实现
//
// 为什么不能照抄 Linux 或 Windows：
//   1. Linux 靠 DBus activation 让终端自己开窗；macOS 没有对应机制，
//      只能靠 LaunchServices 打开一个「可执行文件」。
//   2. Windows 靠 cmd 的 `start ""`；macOS 没有 start。
//   3. macOS 的机制是 `.command` 文件：可执行的 shell 脚本，双击即由
//      系统默认终端（Terminal.app，或用户改过的 iTerm/Warp）在新窗口里执行。
//      所以这里写一个 .command 再 `open` 它 —— 终端由用户自己决定，我们不硬编码。
//
// 引号处理：.command 是 bash 脚本，命令串里若有 `$`、反引号、`\`，
// 在双引号内会被 bash 展开（会话工作目录是用户自己建的，可能含这些字符）。
// 因此不直接拼接原串，而是先分词、再按 POSIX 规则逐词加单引号。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { HOME } = require("./config");
const { resolveCommand } = require("./platform");

const RUNDIR = path.join(os.tmpdir(), "agenthist");

// 文件名只保留安全字符
function safeName(s) {
  return String(s).replace(/[^\w.-]/g, "_").slice(0, 60) || "run";
}

// 单个词按 POSIX 规则引用：安全的原样，其余用单引号包住（内部单引号写成 '\''）
function qSh(s) {
  s = String(s);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// 把一个「已带双引号」的命令串重新分词并 POSIX 引用。
// 只处理双引号与空白 —— 我们自己的命令模板只有这两种结构（`--flag value` 与 `"含空格路径"`）。
function requote(cmd) {
  const out = [];
  let cur = "";
  let has = false;
  let inQ = false;
  for (const ch of String(cmd)) {
    if (ch === '"') {
      if (inQ) { out.push(cur); cur = ""; has = false; inQ = false; }
      else { inQ = true; has = true; }
      continue;
    }
    if (!inQ && /\s/.test(ch)) {
      if (has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out.map(qSh).join(" ");
}

// 写「双击即执行」的 .command。结构刻意极简：
//   cd 到会话工作目录 → 执行命令 → 结束后留一个交互 shell，窗口不立刻消失
function writeCommand(cmd, cwd, tag) {
  fs.mkdirSync(RUNDIR, { recursive: true });
  const file = path.join(RUNDIR, safeName(tag) + ".command");
  const lines = [
    "#!/bin/bash",
    "# 由 Session Viewer 生成，可随时删除",
    'cd -- ' + qSh(cwd || HOME) + ' 2>/dev/null || cd -- "$HOME"',
    requote(cmd),
    "echo",
    "# 命令退出后保留窗口：exec 交互 shell，否则 Terminal 会按配置关掉窗口",
    'exec "${SHELL:-/bin/bash}" -l',
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o755 });
  try { fs.chmodSync(file, 0o755); } catch { /* 某些网络盘不支持 chmod */ }
  return file;
}

function openTerminal(cmd, cwd) {
  if (!cwd || !fs.existsSync(cwd)) cwd = HOME;

  let script;
  try {
    script = writeCommand(cmd, cwd, cmd);
  } catch (e) {
    return { ok: false, cmd, cwd, error: "无法写入启动脚本: " + String(e.message || e) };
  }

  // 用 `open` 而不是 `open -a Terminal`：.command 的默认打开程序就是系统终端，
  // 用户若把 iTerm / Warp 设为 .command 的默认程序，这里自动跟随。
  const openBin = resolveCommand("open") || "/usr/bin/open";
  try {
    const child = spawn(openBin, [script], { detached: true, stdio: "ignore", cwd });
    child.on("error", () => {});
    child.unref();
    return { ok: true, cmd, cwd, terminal: "系统默认终端", launcher: script };
  } catch (e) {
    return { ok: false, cmd, cwd, error: String(e.message || e) };
  }
}

// 供前端展示用：报出用户真正会看到的终端
function detectTerminal() {
  if (fs.existsSync("/Applications/iTerm.app")) return "iTerm";
  if (fs.existsSync("/Applications/Warp.app")) return "Warp";
  return "Terminal";
}

module.exports = { openTerminal, detectTerminal, writeCommand, requote, qSh, RUNDIR };
