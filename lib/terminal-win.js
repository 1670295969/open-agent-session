// 终端启动 —— Windows 实现
//
// 与 Linux 的差别不是「换个终端名字」，而是几个机制完全不同：
//
//   1. 新窗口机制：Windows 没有 DBus activation。开新控制台窗口靠 `start`，
//      而 `start` 的第一个带引号参数会被当成「窗口标题」吞掉——所以必须写
//      `start "" <目标>`，那个空标题占位不能省。
//   2. 引号规则：cmd.exe 的 /c 后接引号串的剥离规则有两套（是否加 /S），
//      且目标命令自身还可能带引号（如 pi 的 --session "<路径>"）。
//      「拼一层引号再转义」在任何路径含空格时都容易崩。
//      → 这里改为把命令写进临时 .cmd 文件，只让 start 去跑一个文件，
//        彻底绕开引号转义这个雷区。
//   3. 批处理里的 `%` 会被当变量展开：路径或命令里出现 `%` 必须写成 `%%`，
//      否则 `C:\a%b` 会被吃掉一段。
//
// 不用 wt.exe 硬编码的原因：Win11 允许把 Windows Terminal 设为「默认终端应用」，
// 此时 `start` 起的控制台程序会自动落到 WT 标签里。交给系统默认终端，
// 用户自己配的 ConEmu / WT 都生效，比写死某个终端更稳。
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { HOME } = require("./config");
const { resolveCommand } = require("./platform");

const RUNDIR = path.join(os.tmpdir(), "agent-sessionary");

// 文件名只保留安全字符，避免会话 id / 路径里的怪符号变成非法文件名
function safeName(s) {
  return String(s).replace(/[^\w.-]/g, "_").slice(0, 60) || "run";
}

// 批处理内的字面量转义：`%` 是唯一必须处理的（其余特殊字符都在双引号内）
function batLit(s) {
  return String(s).replace(/%/g, "%%");
}

// 写一个「启动即执行」的批处理。内容刻意保持极简：
//   chcp 65001 —— 让窗口能正确显示中文路径（UTF-8 落盘 + 该代码页才能对上）
//   cd /d      —— 切到会话工作目录（/d 允许跨盘符）
//   pause      —— 命令跑完不立刻关窗，用户能看完输出
function writeLauncher(cmd, cwd, tag) {
  fs.mkdirSync(RUNDIR, { recursive: true });
  const file = path.join(RUNDIR, safeName(tag) + ".cmd");
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    cwd ? `cd /d "${batLit(cwd)}"` : "",
    batLit(cmd),
    "echo.",
    "pause",
  ].filter(Boolean);
  // 无 BOM 的 UTF-8 + chcp 65001：cmd 逐行读取批处理，第 2 行切完代码页后
  // 后续行才会按 UTF-8 解析，中文路径因此能被正确还原。
  fs.writeFileSync(file, lines.join("\r\n") + "\r\n", { encoding: "utf8" });
  return file;
}

function openTerminal(cmd, cwd) {
  if (!cwd || !fs.existsSync(cwd)) cwd = HOME;

  const comspec = process.env.ComSpec || resolveCommand("cmd.exe") || "cmd.exe";

  let script;
  try {
    script = writeLauncher(cmd, cwd, cmd);
  } catch (e) {
    return { ok: false, cmd, cwd, error: "无法写入启动脚本: " + String(e.message || e) };
  }

  // 整行原样交给 cmd（windowsVerbatimArguments），不做二次加引号。
  // 不用 /S：/S 会剥掉首尾引号，而这里首字符是 `s`（start），启用后
  // 会让后续引号进入另一套解析分支，反而更不可控。
  const line = '/d /c start "" "' + script + '"';
  try {
    const child = spawn(comspec, [line], {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    });
    child.on("error", () => {});
    child.unref();
    return {
      ok: true, cmd, cwd,
      terminal: "cmd.exe（系统默认终端）",
      launcher: script,
    };
  } catch (e) {
    return { ok: false, cmd, cwd, error: String(e.message || e) };
  }
}

// Windows 上终端一定能起（cmd.exe 是系统自带），返回固定标识给前端展示
function detectTerminal() {
  return "cmd.exe";
}

module.exports = { openTerminal, detectTerminal, writeLauncher, RUNDIR };
