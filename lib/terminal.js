// 终端启动：恢复 / 新建会话 —— 统一入口，按平台分派
//
// 真正干活的三份实现在 terminal-linux.js / terminal-win.js / terminal-mac.js，
// 本文件只负责：命令模板、平台选择、对外 API 保持稳定。
// 这样路由层（router.js）与前端完全不用关心跑在哪个系统上。
const fs = require("fs");
const { IS_WIN, IS_MAC } = require("./platform");
const impl = IS_WIN
  ? require("./terminal-win")
  : IS_MAC
    ? require("./terminal-mac")
    : require("./terminal-linux");

// 各工具的执行命令行（用于恢复与展示）。
// 三个平台的 CLI 参数一致，所以模板共用；路径类参数统一加双引号——
// 各平台的分派实现会把它转成自己需要的安全形式（Windows 批处理 / macOS POSIX 引用）。
// 加引号不只是为了空格：中文、括号、`$`、`%` 都在实际会话路径里出现过。
const RESUME_CMDS = {
  codex: (s) => `codex resume --no-daemon ${s.id}`,
  claude: (s) => `claude --resume ${s.id}`,
  pi: (s) => `pi --session "${s.file}"`,
  hermes: (s) => `hermes -r ${s.id}`,
};

const NEW_CMDS = {
  codex: "codex --no-daemon",
  claude: "claude",
  pi: "pi",
  hermes: "hermes",
};

function resumeSession({ tool, id, file, cwd }) {
  const make = RESUME_CMDS[tool];
  if (!make) throw new Error("unknown tool: " + tool);
  return impl.openTerminal(make({ id, file }), cwd);
}

function newSession({ tool, cwd }) {
  const cmd = NEW_CMDS[tool];
  if (!cmd) throw new Error("unknown tool: " + tool);
  // 三个平台的 openTerminal 在目录不存在时都会静默退回 HOME。恢复时这合理
  // （目录可能已被删），但新建时等于「用户写的目录被偷偷换掉」，在错误的位置
  // 起了新会话。这里统一拦下，让前端把原因显示出来。
  if (!cwd) throw new Error("请填写工作目录");
  let isDir = false;
  try { isDir = fs.statSync(cwd).isDirectory(); } catch {}
  if (!isDir) throw new Error("工作目录不存在或不是目录：" + cwd);
  return impl.openTerminal(cmd, cwd);
}

module.exports = {
  openTerminal: impl.openTerminal,
  resumeSession, newSession,
  detectTerminal: impl.detectTerminal,
  RESUME_CMDS, NEW_CMDS,
  // 兼容旧调用：sandbox 判定只在 Linux 有意义
  inSandbox: impl.inSandbox || (() => false),
  detectGuiEnv: impl.detectGuiEnv || (() => ({})),
};
