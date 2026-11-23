// Pi CLI 嵌入式会话适配器
//
// 恢复：--session <file> [--model m] [--thinking x] -p   （stdin 传消息，纯文本输出）
// 新建：--session <新文件路径> -p                       （文件由服务端指定，pi 直接写它）
// 按行缓冲流式输出，避免 UTF-8 多字节被 chunk 切断。
//
// 为什么新建也显式指定路径：pi 默认写进
//   ~/.pi/agent/sessions/--<cwd 转义>--/<时间戳>_<uuid>.jsonl
// 目录名转义属内部实现，跟着猜容易在版本升级后断掉。显式 --session <file>
// 让落盘路径 100% 确定，且目录仍按 pi 自己的规则生成，保证以后从该 cwd
// 启动的 `pi` 能扫到这条会话。
//
// 思考内容（2026-11-23 实测，用 magpie provider + openai-responses 接口）：
//   事件有 thinking_start / thinking_end，但 thinking 字段恒为空串，
//   正文在 thinkingSignature.encrypted_content 里（加密，需 provider 侧密钥）。
//   所以本机看不到思考明文 —— 这不是解析漏了，是上游没给。
//   代码照样接住非空的 thinking（换个 provider 可能就是明文），拿不到就静默不发，
//   界面上不出现空的思考块。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HOME } = require("../../config");

// pi 的 cwd → 目录名转义。
// 【实测】pi 自己的规则：去掉首尾路径分隔符，把中间的分隔符换成 `-`，再包一对 `--`：
//   /home/alice/x        → --home-alice-x--
//   /tmp                 → --tmp--
// 注意 `.` 之类的字符原样保留（真实目录 `--home-alice-x-1.2-.env--` 可证），
// 所以不能粗暴地把非字母数字全换成 `-`，否则目录名对不上、以后 pi 自己扫不到。
function piSessionDir(cwd) {
  const esc = String(cwd || HOME)
    .replace(/^[\\/]+/, "")
    .replace(/[\\/]+$/, "")
    .replace(/[\\/]/g, "-");
  return path.join(HOME, ".pi", "agent", "sessions", "--" + esc + "--");
}

// 会话文件名与 pi 自身一致：<ISO 时间戳，冒号/点换短横>_<uuid>.jsonl
function piSessionFile(cwd, id) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(piSessionDir(cwd), ts + "_" + id + ".jsonl");
}

function build({ file, model, effort, create, cwd, sessionId }) {
  const target = create ? piSessionFile(cwd, sessionId || crypto.randomUUID()) : file;
  // 新建时目录由 pi 自己按 cwd 生成，但目标可能不在默认目录里（比如后面加了
  // --session-dir），显式建好父目录比赌 pi 会自动创建更稳。
  if (create) {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch {}
  }
  const args = ["--session", target];
  if (model) args.push("--model", model);
  if (effort) args.push("--thinking", effort);
  args.push("-p");
  return { args, useStdin: true, file: target };
}

// state: { buf }  ctx: { emit(s), emitErr(s) }
function stream(chunk, state, ctx) {
  state.buf += chunk;
  let i;
  while ((i = state.buf.indexOf("\n")) >= 0) {
    const line = state.buf.slice(0, i + 1);
    state.buf = state.buf.slice(i + 1);
    ctx.emit(line);
  }
}

// 结束时把残余缓冲吐出
function finalize(state, ctx) {
  if (state.buf) { ctx.emit(state.buf); state.buf = ""; }
}

// 新建模式：路径本来就是自己指定的，无需再找
function locate(state) {
  if (!state.file) return null;
  return { id: path.basename(state.file, ".jsonl").split("_").pop(), file: state.file };
}

module.exports = { build, stream, finalize, locate, piSessionDir, piSessionFile };
