// Claude Code 嵌入式会话适配器
// 恢复：--resume <id> -p --output-format stream-json --verbose
// 新建：        -p --output-format stream-json --verbose --session-id <uuid>
//
// 两者都从 stdin 读消息；stdout 是逐行 JSON。
// 取两类块：type==="text" 进正文（delta），type==="thinking" 进思考（think）。
// 【实测】thinking 块带完整明文，例如 {"type":"thinking","thinking":"The user is asking…"}，
// 不需要额外参数。但它必须走独立通道 —— 混进 delta 会当成正式回答显示出来。
//
// 新建时 session-id 由服务端生成后显式传入：CLI 自己生成的话前端拿不到 id，
// 就没法在新会话落盘后立刻跳过去。init 事件里也会回带同一个 id，用于兜底。
const fs = require("fs");
const path = require("path");
const { HOME } = require("../../config");
const { walk, tryJson } = require("../../utils");

function build({ id, model, effort, create, sessionId }) {
  const args = create
    ? ["-p", "--output-format", "stream-json", "--verbose"]
    : ["--resume", id, "-p", "--output-format", "stream-json", "--verbose"];
  if (create && sessionId) args.push("--session-id", sessionId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return { args, useStdin: true };
}

// state: { buf, id, wrote }  ctx: { emit(s), emitErr(s), emitThink(s) }
function handleLine(line, state, ctx) {
  if (!line.trim()) return;
  const o = tryJson(line);
  if (!o) return;
  if (o.type === "system" && o.subtype === "init" && o.session_id) state.id = o.session_id;
  if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
    for (const c of o.message.content) {
      if (c.type === "text" && c.text) {
        // 一条 assistant 消息可能拆成多个 text 块（工具调用前后各一段），
        // 直接首尾相接会把两段话粘成一句，用空行分开。
        ctx.emit((state.wrote ? "\n\n" : "") + c.text);
        state.wrote = true;
      } else if (c.type === "thinking" && c.thinking) {
        // 连续多个 thinking 块之间空行分隔，否则段落会粘成一坨
        ctx.emitThink((state.thought ? "\n\n" : "") + c.thinking);
        state.thought = true;
      }
    }
  }
  if (o.type === "result" && o.is_error) {
    ctx.emitErr(String(o.result || "执行出错").slice(0, 1000));
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

// 末行没有换行符时（进程被 kill、输出未补 \n）不能整行丢掉
function finalize(state, ctx) {
  if (state.buf) { handleLine(state.buf, state, ctx); state.buf = ""; }
}

// 新建模式：进程结束后定位刚写出的会话文件（按 uuid 全目录找，不猜目录名压缩规则）
function locate(state) {
  if (!state.id) return null;
  const files = walk(path.join(HOME, ".claude", "projects"));
  const hit = files.find((f) => path.basename(f) === state.id + ".jsonl");
  if (hit) return { id: state.id, file: hit };
  return fs.existsSync(path.join(HOME, ".claude", "projects"))
    ? { id: state.id, file: "" } : null;
}

module.exports = { build, stream, finalize, locate };
