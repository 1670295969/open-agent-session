// 会话文件删除 —— Windows 实现（系统回收站）
//
// 关键：Windows 上「可还原的删除」只能走 Shell API，fs.unlink 是真删、进不了回收站。
// 这里用 .NET 的 Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile + SendToRecycleBin，
// 它是 Shell API（IFileOperation）的官方托管封装，效果与在资源管理器里按 Delete 一致，
// 文件可从「回收站」还原。
//
// 为什么用 -EncodedCommand 而不是拼 -Command 字符串：
//   会话路径含中文、空格、单引号、括号（实测过 `SP_TEST_(3).jsonl` 这种），
//   拼进 PowerShell 命令行要跨三层解析（cmd → powershell → 脚本），
//   任何一层漏转义都会静默失败。Base64(UTF-16LE) 传参只有一层解析，路径原样进脚本。
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveCommand } = require("./platform");

// 找 PowerShell：优先 Windows PowerShell 5.1（系统自带，无额外依赖），
// 再退 pwsh 7。两者对 Microsoft.VisualBasic 的调用语法一致。
function psExe() {
  const sys = process.env.SystemRoot || "C:\\Windows";
  const w = path.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (fs.existsSync(w)) return w;
  return resolveCommand("powershell.exe") || resolveCommand("pwsh.exe") || "";
}

// UTF-16LE + Base64，PowerShell 的 -EncodedCommand 约定格式
function encoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// 单引号是 PowerShell 字符串的转义重点：内部单引号要写成两个单引号
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// 实际删除，成功返回 { ok, err }
// isDir=true 时走 DeleteDirectory（dsh 的会话是「目录 + 两个文件」，
// 只删里面的 .zstd 会留下孤儿目录和锁文件）
function recycle(target, isDir) {
  const exe = psExe();
  if (!exe) return { ok: false, err: "未找到 PowerShell，无法调用系统回收站" };

  const call = isDir
    ? "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("
    : "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(";

  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "$p = " + psQuote(target),
    // 4 参数重载：路径 / 错误对话框 / 送入回收站 / 取消时不做动作
    call +
      "$p, " +
      "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, " +
      "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin, " +
      "[Microsoft.VisualBasic.FileIO.UICancelOption]::DoNothing)",
    // 复核：路径必须已经不在了，否则视为失败（防止静默吞掉权限错误）
    "if (Test-Path -LiteralPath $p) { Write-Error 'still exists'; exit 3 }",
    "exit 0",
  ].join("\n");

  const r = spawnSync(
    exe,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded(script)],
    { encoding: "utf8", timeout: 60 * 1000, windowsHide: true }
  );

  if (r.error) return { ok: false, err: String(r.error.message || r.error) };
  if (r.status !== 0) {
    const msg = ((r.stderr || "") + (r.stdout || "")).trim().slice(0, 600);
    return { ok: false, err: msg || ("PowerShell 退出码 " + r.status) };
  }
  return { ok: true, err: "" };
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
// file 指向 Windows 回收站根目录（前端提示用，不是可还原的具体路径）
function moveToTrash(src) {
  let st;
  try { st = fs.statSync(src); } catch { throw new Error("文件不存在或已删除"); }
  const isDir = st.isDirectory();
  if (!isDir && !st.isFile()) throw new Error("只允许删除普通文件或目录");

  const r = recycle(src, isDir);
  if (!r.ok) throw new Error("移入回收站失败：" + r.err);

  return {
    name: path.basename(src),
    file: "$Recycle.Bin",
    info: "",
    size: isDir ? dirSize(src) : st.size,
  };
}

module.exports = { moveToTrash, trashDir: "$Recycle.Bin", psExe };
