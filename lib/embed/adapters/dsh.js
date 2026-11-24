// dsh（DeepSeek Harness）嵌入式会话适配器
//
// 恢复：dsh --profile headless --json --session-id <id> -
// 新建：dsh --profile headless --json -
//   （`-` 表示从 stdin 读任务文本，见下面第 1 条）
//
// 三处与其它工具不同：
//
// 1. **消息走 stdin（`-`），不走命令行参数**。
//    dsh headless 的第一个位置参数是任务文本，`-` 是它自己的 stdin 约定
//    （`dsh --profile headless --help` 明确写着 "`-` reads stdin"）。
//    🔴 原来是把 message 直接 push 进 args，长消息会撞 ARG_MAX：
//       实测 240KB 的 JSON 请求体 → `spawn E2BIG`，前端只看到「⚠ spawn E2BIG」。
//       这不是 dsh 的问题，是内核单进程参数+环境区 2MB 上限（且 ARG_MAX 只是
//       上限，实际可用空间还要减去环境变量占用）。
//    走 stdin 之后长度只受内存限制，且与 claude/codex/pi 的传法一致。
//    【实测】新建与 `--session-id` 恢复两条路径都支持 `-`，sessionId 原样回带。
//
// 2. **必须站在会话记录的 cwd 下执行**。dsh 会校验
//       session "…" was recorded in "<x>", not "<y>"
//    cwd 由 embed/index.js 从扫描结果带过来，这里不再处理。
//
// 3. **--json 输出是 NDJSON 事件流**，比纯文本多拿到 sessionId 和 tool 事件：
//       {"type":"session","sessionId":"…","cwd":"…"}
//       {"type":"status","phase":"step_start"|"step_end"|"turn_start"|"turn_end"}
//       {"type":"thinking","text":"…"}      ← 思考增量（完整明文）
//       {"type":"text","text":"…"}          ← 正文增量
//       {"type":"tool",...}                ← 工具名，用于界面上的 chip
//       {"type":"final",…}                 ← 收尾
//    thinking 必须和 text 分开走两条通道：混在一起会当成正式回答显示。
const fs = require("fs");
const path = require("path");
const { HOME } = require("../../config");
const { tryJson } = require("../../utils");

function build({ id, model, create, cwd }) {
  // 新建时不吃 --session-id（让 dsh 自己造），恢复时必带
  const args = ["--profile", "headless", "--json"];
  if (!create) args.push("--session-id", id);
  if (model) args.push("-m", model);
  // `-` 必须在选项之后（位置参数），消息正文由 embed/index.js 写进 stdin
  args.push("-");
  return { args, useStdin: true, cwd };
}

// state: { buf, id, wrote, thought }  ctx: { emit(s), emitErr(s), emitThink(s) }
function handleLine(line, state, ctx) {
  if (!line.trim()) return;
  const o = tryJson(line);
  if (!o) return;

  if (o.type === "session" && o.sessionId) {
    state.id = o.sessionId;
    return;
  }
  if (o.type === "thinking" && o.text) {
    ctx.emitThink(o.text);
    state.thought = true;
    return;
  }
  if (o.type === "text" && o.text) {
    ctx.emit(o.text);
    state.wrote = true;
    return;
  }
  // 一轮结束：多轮之间补空行，避免几段回复粘成一块
  if (o.type === "status" && o.phase === "turn_end" && state.wrote) {
    ctx.emit("\n\n");
    state.wrote = false;
    return;
  }
  // headless 出错时会在 final 里给 reason
  if (o.type === "final" && o.reason && o.reason.kind && o.reason.kind !== "completed") {
    ctx.emitErr("dsh 结束原因：" + o.reason.kind + (o.reason.message ? " — " + o.reason.message : ""));
  }
}

function stream(chunk, state, ctx) {
  state.buf += chunk;
  let i;
  while ((i = state.buf.indexOf("\n")) >= 0) {
    const line = state.buf.slice(0, i);
    state.buf = state.buf.slice(i + 1);
    handleLine(line, state, ctx);
  }
}

function finalize(state, ctx) {
  if (state.buf) { handleLine(state.buf, state, ctx); state.buf = ""; }
}

// 新建/恢复后定位会话文件：目录名是 cwd 转义 + session-<uuid>，直接拼太脆，
// 改为在 cwd 对应的父目录里按 uuid 找（uuid 全局唯一）。
function locate(state) {
  if (!state.id) return null;
  const root = path.join(HOME, ".dsh", "sessions");
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(root, d.name, state.id, "session.v4.jsonl.zstd");
    if (fs.existsSync(f)) return { id: state.id, file: f };
  }
  return { id: state.id, file: "" };
}

module.exports = { build, stream, finalize, locate };
