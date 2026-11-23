// 终端启动 —— Linux 实现
//
// 关键坑：WorkBuddy sandbox 在 user namespace（内部 uid 0 → 宿主 1000）里跑，
// gnome-terminal 等 GLib 客户端发 DBus EXTERNAL 认证时用 getuid()=0 的凭据 hex，
// 宿主 bus 期望 uid=1000 → 认证永远失败、窗口不弹。
// 解法：嵌套 user namespace 把内部 uid 重新映射为 1000（unshare --map-user=1000），
// getuid() 变回 1000，DBus 认证对上，窗口正常弹出。【实测通过】
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { HOME } = require("./config");
const { commandExists } = require("./platform");

// 依赖 DBus activation 的终端（sandbox 下必须包 unshare）
const DBUS_TERMINALS = new Set([
  "gnome-terminal", "konsole", "mate-terminal", "tilix", "xfce4-terminal", "x-terminal-emulator",
]);

const TERMINAL_CANDIDATES = [
  { bin: "gnome-terminal", args: (c) => ["--", "bash", "-lc", c] },
  { bin: "konsole", args: (c) => ["-e", "bash", "-lc", c] },
  { bin: "xfce4-terminal", args: (c) => ["-x", "bash", "-lc", c] },
  { bin: "mate-terminal", args: (c) => ["--", "bash", "-lc", c] },
  { bin: "tilix", args: (c) => ["--", "bash", "-lc", c] },
  { bin: "alacritty", args: (c) => ["-e", "bash", "-lc", c] },
  { bin: "kitty", args: (c) => ["bash", "-lc", c] },
  { bin: "x-terminal-emulator", args: (c) => ["-e", "bash", "-lc", c] },
  { bin: "xterm", args: (c) => ["-e", "bash", "-lc", c] },
];

// 检测是否处于 WorkBuddy sandbox（/proc/self/uid_map 形如 "0 1000 1"）
function inSandbox() {
  try {
    const m = fs.readFileSync("/proc/self/uid_map", "utf8").trim().split(/\s+/);
    return m[0] === "0" && m[1] === "1000";
  } catch { return false; }
}

// 从正在运行的桌面进程环境里现取 DISPLAY / XAUTHORITY / DBUS 地址。
// 为什么不能只在启动时取一次：服务随开机（Linger）在登录前就起来了，
// 那时桌面还没跑、环境变量是空的；等用户登录后再点「恢复会话」，
// 进程环境不会自己更新，于是窗口弹不出来。
// 每次调用都现查 → 登录前启动、换会话、Wayland/X11 切换都不受影响。
const GUI_ENV_TTL = 60 * 1000;
let guiEnvCache = { at: 0, env: null };

function readEnviron(pidPath) {
  try {
    const raw = fs.readFileSync(pidPath, "utf8");
    const out = {};
    for (const kv of raw.split("\0")) {
      const i = kv.indexOf("=");
      if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
    }
    return out;
  } catch { return null; }
}

// 桌面会话的「权威」环境持有者，按可信度排序
const DESKTOP_PROCS = [
  "gnome-session-binary", "gnome-session", "gnome-shell",
  "plasmashell", "xfce4-session", "mate-session", "cinnamon",
];

function detectGuiEnv() {
  const now = Date.now();
  if (guiEnvCache.env && now - guiEnvCache.at < GUI_ENV_TTL) return guiEnvCache.env;

  const found = { DISPLAY: "", XAUTHORITY: "", DBUS_SESSION_BUS_ADDRESS: "" };

  // ① 扫 /proc 找桌面主进程的环境（最准，能拿到真实 DISPLAY 与 auth 路径）
  try {
    const pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    const hits = [];
    for (const pid of pids) {
      let comm = "";
      try { comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim(); } catch { continue; }
      const rank = DESKTOP_PROCS.indexOf(comm);
      if (rank < 0) continue;
      const env = readEnviron(`/proc/${pid}/environ`);
      if (!env) continue;
      hits.push({ rank, env });
    }
    hits.sort((a, b) => a.rank - b.rank);
    for (const { env } of hits) {
      for (const k of Object.keys(found)) {
        if (!found[k] && env[k]) found[k] = env[k];
      }
      if (found.DISPLAY && found.XAUTHORITY) break;
    }
  } catch { /* /proc 不可读就跳过 */ }

  // ② 回落：X socket 探测
  if (!found.DISPLAY) {
    for (const n of ["0", "1", "2"]) {
      if (fs.existsSync(`/tmp/.X11-unix/X${n}`)) { found.DISPLAY = ":" + n; break; }
    }
  }

  // ③ 回落：常见 auth 路径
  if (!found.XAUTHORITY) {
    const cands = [
      "/run/user/1000/gdm/Xauthority",
      `${HOME}/.Xauthority`,
    ];
    for (const c of cands) if (fs.existsSync(c)) { found.XAUTHORITY = c; break; }
  }

  // ④ 回落：用户 bus
  if (!found.DBUS_SESSION_BUS_ADDRESS) {
    const bus = "/run/user/1000/bus";
    if (fs.existsSync(bus)) found.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }

  // 都探测不到就别塞假值（塞 :1 会让 spawn 静默失败，更难排查）
  // 只有探测到 DISPLAY 才进缓存：开机时桌面还没起，此刻缓存空值会让后续 60 秒内
  // 都拿不到正确的显示号；不缓存则下次调用立刻重新探测
  guiEnvCache = found.DISPLAY ? { at: now, env: found } : { at: 0, env: null };
  return found;
}

// 补齐 GUI/DBus 环境（缺什么补什么，已有的不覆盖）
function guiEnv(base) {
  const env = { ...base };
  const d = detectGuiEnv();
  if (!env.DISPLAY && d.DISPLAY) env.DISPLAY = d.DISPLAY;
  if (!env.XAUTHORITY && d.XAUTHORITY) env.XAUTHORITY = d.XAUTHORITY;
  if (!env.DBUS_SESSION_BUS_ADDRESS && d.DBUS_SESSION_BUS_ADDRESS) {
    env.DBUS_SESSION_BUS_ADDRESS = d.DBUS_SESSION_BUS_ADDRESS;
  }
  env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR || "/run/user/1000";
  return env;
}

function openTerminal(cmd, cwd) {
  if (!cwd || !fs.existsSync(cwd)) cwd = HOME;
  // 清掉继承的 TERM=dumb 等，否则 TUI 拒绝启动
  const env = { ...process.env };
  delete env.TERM;
  delete env.term;

  const sandbox = inSandbox();
  const genv = sandbox ? guiEnv(env) : env;

  for (const { bin, args } of TERMINAL_CANDIDATES) {
    if (!commandExists(bin)) continue;
    let binCmd = bin;
    let binArgs = args(cmd);
    if (sandbox && DBUS_TERMINALS.has(bin)) {
      binCmd = "unshare";
      binArgs = ["--user", "--map-user=1000", "--map-group=1000", bin, ...binArgs];
    }
    const child = spawn(binCmd, binArgs, { cwd, detached: true, stdio: "ignore", env: genv });
    child.on("error", () => {}); // spawn 失败静默，继续尝试下一个
    child.unref();
    return { ok: true, cmd, cwd, terminal: bin };
  }
  return { ok: false, cmd, cwd, error: "未找到可用终端模拟器，请复制命令手动执行" };
}

function detectTerminal() {
  for (const { bin } of TERMINAL_CANDIDATES) if (commandExists(bin)) return bin;
  return "";
}

module.exports = { openTerminal, detectTerminal, inSandbox, detectGuiEnv };
