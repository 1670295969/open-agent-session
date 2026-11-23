// 平台差异集中层
//
// 为什么单独抽一个文件：跨平台真正麻烦的只有三件事，把它们收在一处，
// 其余业务代码（扫描 / 解析 / 路由）就完全不用关心操作系统。
//
//   1. 命令定位：Windows 上 claude / codex 实际是 claude.cmd，PATH 分隔符是 `;`，
//      可执行后缀不固定（PATHEXT）。直接 spawn("claude") 会 ENOENT。
//   2. 进程启动：Node 18.20+（CVE-2024-27980 修复）起，spawn 带 .cmd/.bat 会 EINVAL，
//      必须经 cmd.exe 转发。这里封装掉。
//   3. 打开 URL / 回收站位置：两家规范完全不同。
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync } = require("child_process");

const IS_WIN = process.platform === "win32";
const IS_LINUX = process.platform === "linux";
const IS_MAC = process.platform === "darwin";

// Windows 可执行后缀，按 PATHEXT 顺序（.CMD 优先于 .EXE 更贴近 cmd 的行为）
function winExts() {
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// 把命令名解析成绝对路径；找不到返回 ""。
// 只认文件、不认目录（避免 PATH 里同名目录被误判为可执行）
function resolveCommand(bin) {
  if (!bin) return "";
  if (bin.includes("/") || bin.includes("\\")) {
    try { return fs.statSync(bin).isFile() ? bin : ""; } catch { return ""; }
  }
  const dirs = (process.env.PATH || "").split(IS_WIN ? ";" : ":");
  const exts = IS_WIN && !path.extname(bin) ? ["", ...winExts()] : [""];
  for (const d of dirs) {
    if (!d) continue;
    for (const ext of exts) {
      const full = path.join(d, bin + ext);
      // 认符号链接：Windows 的 MSIX「应用执行别名」（如 wt.exe）是 0 字节重解析点，
      // statSync 可能报非文件，但 spawn 是能起起来的，不能因此判为不存在
      try {
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch {
        try { if (fs.lstatSync(full).isSymbolicLink()) return full; } catch { /* 下一个 */ }
      }
    }
  }
  return "";
}

function commandExists(bin) { return !!resolveCommand(bin); }

// cmd.exe 参数引用。Windows 文件名不允许出现双引号，所以只需处理空格与空串，
// 不必实现完整的反斜杠转义（那套规则只在 MSVCRT 解析 argv 时生效，与 /s /c 冲突）。
function qWin(s) {
  s = String(s);
  if (s === "") return '""';
  return /[\s&|<>^"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 启动外部命令，抹平 .cmd/.bat 差异。opts 同 child_process.spawn。
// 命令不存在时抛错（带 code=ENOENT_CMD），由调用方转成用户能看懂的提示。
function spawnTool(bin, args, opts = {}) {
  const exe = resolveCommand(bin);
  if (!exe) {
    const err = new Error("未找到命令: " + bin);
    err.code = "ENOENT_CMD";
    throw err;
  }
  if (!IS_WIN) return spawn(exe, args, opts);

  if (/\.(cmd|bat)$/i.test(exe)) {
    // cmd /d /s /c ""exe" args..." —— /s 让 cmd 只剥最外层一对引号，
    // 中间的引号原样传给目标程序。这是 npm 处理 .cmd shim 的标准做法。
    const line = [exe, ...args].map(qWin).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", '"' + line + '"'], {
      ...opts,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(exe, args, opts);
}

// 同步版本，供模型列表这类「启动即等结果」的场景用。
// 同时合并 stdout / stderr —— 原来用 `2>&1` 依赖 shell 重定向，跨平台不成立。
function runToolSync(bin, args, opts = {}) {
  const exe = resolveCommand(bin);
  if (!exe) return { ok: false, out: "", error: "未找到命令: " + bin, status: -1 };

  let r;
  if (!IS_WIN) {
    r = spawnSync(exe, args, { ...opts, encoding: "utf8" });
  } else if (/\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...args].map(qWin).join(" ");
    r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", '"' + line + '"'], {
      ...opts, encoding: "utf8", windowsVerbatimArguments: true,
    });
  } else {
    r = spawnSync(exe, args, { ...opts, encoding: "utf8" });
  }

  const out = (r.stdout || "") + (r.stderr || "");
  return {
    ok: r.status === 0 && !r.error,
    out,
    error: r.error ? String(r.error.message || r.error) : "",
    status: typeof r.status === "number" ? r.status : -1,
  };
}

// 用系统默认程序打开 URL
function openUrl(url) {
  if (IS_WIN) {
    // start 是 cmd 内建命令，必须经 cmd 转发；第一个参数空引号是 start 的「窗口标题」占位
    try {
      const c = spawn(process.env.ComSpec || "cmd.exe",
        ["/d", "/s", "/c", 'start "" ' + qWin(url)],
        { detached: true, stdio: "ignore", windowsVerbatimArguments: true });
      c.on("error", () => {});
      c.unref();
      return true;
    } catch { return false; }
  }
  const cands = IS_MAC ? ["open"] : ["xdg-open", "gnome-open"];
  for (const b of cands) {
    const exe = resolveCommand(b);
    if (!exe) continue;
    try {
      const c = spawn(exe, [url], { detached: true, stdio: "ignore" });
      c.on("error", () => {});
      c.unref();
      return true;
    } catch { /* 试下一个 */ }
  }
  return false;
}

// 回收站位置（前端提示文案用）
// macOS 的废纸篓是用户家目录下的隐藏目录 ~/.Trash，由 Finder 管理
function trashDir() {
  if (IS_WIN) return "$Recycle.Bin";
  if (IS_MAC) return path.join(os.homedir(), ".Trash");
  return path.join(os.homedir(), ".local", "share", "Trash", "files");
}

// 平台中文名，接口与页面展示用
function platformName() {
  return IS_WIN ? "Windows" : IS_MAC ? "macOS" : "Linux";
}

module.exports = {
  IS_WIN, IS_LINUX, IS_MAC,
  resolveCommand, commandExists, spawnTool, runToolSync, openUrl,
  trashDir, platformName, qWin,
};
