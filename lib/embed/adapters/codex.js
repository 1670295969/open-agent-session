// Codex CLI 嵌入式会话适配器
//
// 恢复：exec resume --skip-git-repo-check <id> -    ← prompt 从 stdin 读（`-` 即 stdin 约定）
//        [-m model] [-c model_reasoning_effort=x]
// 新建：exec --json --skip-git-repo-check -          ← 同样 stdin 传 prompt
//
// 为什么把 prompt 改走 stdin 而不是命令行参数：
//   Windows 上要经 cmd.exe 转发 .cmd shim，用户输入里只要有 `"` `&` `|` `^` `%`
//   就会被打断或改写，多层转义难以穷尽。stdin 是字节流，任何内容原样送达。
//   Linux 侧实测 `codex exec resume <id> -` 同样正常（退出码 0、输出与参数式一致），
//   于是两个平台共用一条路径，不再按平台分叉。
//
// 【实测】resume 模式 stdout 只有干净正文，头部/user 回显/tokens used 全走 stderr → 直接转发。
// 新建模式必须加 --json：纯文本模式拿不到 thread_id，前端就不知道新会话落在哪个 id 上。
// --json 输出是 JSONL 事件流：
//   {"type":"thread.started","thread_id":"..."}                      ← 新会话 id
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"turn.completed"}
// 粒度是「整条消息」而非逐字增量，比恢复模式粗，但能让用户实时看到进展。
const fs = require("fs");
const path = require("path");
const { HOME } = require("../../config");
const { walk, tryJson } = require("../../utils");

function build({ id, model, effort, create }) {
  const args = create
    ? ["exec", "--json", "--skip-git-repo-check", "-"]
    : ["exec", "resume", "--skip-git-repo-check", id, "-"];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", "model_reasoning_effort=" + effort);
  return { args, useStdin: true, json: !!create };
}

// state: { buf, id, wrote, json }  ctx: { emit(s), emitErr(s) }
function handleLine(line, state, ctx) {
  if (!line.trim()) return;
  const o = tryJson(line);
  if (!o) return;
  if (o.type === "thread.started" && o.thread_id) state.id = o.thread_id;
  if (o.type === "item.completed" && o.item) {
    const it = o.item;
    if (it.type === "agent_message" && it.text) {
      ctx.emit((state.wrote ? "\n\n" : "") + it.text);
      state.wrote = true;
    } else if (it.type === "error" && it.message && !state.wrote) {
      // 配置告警（如 `disable_response_storage` 已废弃）会以 error item 连报两条，
      // 但它们不影响本次回答，抖在正文前面只会让人以为出错了 → 过滤掉。
      const m = String(it.message);
      if (!/^Codex is ignoring/i.test(m)) ctx.emitErr(m.slice(0, 500));
    }
  }
}

function stream(chunk, state, ctx) {
  if (!state.json) { if (chunk) ctx.emit(chunk); return; }

  state.buf += chunk;
  let i;
  while ((i = state.buf.indexOf("\n")) >= 0) {
    const line = state.buf.slice(0, i);
    state.buf = state.buf.slice(i + 1);
    handleLine(line, state, ctx);
  }
}

// 非 JSON 模式正文本来就是直通，无需收尾；JSON 模式末行可能没换行
function finalize(state, ctx) {
  if (!state.json) return;
  if (state.buf) { handleLine(state.buf, state, ctx); state.buf = ""; }
}

// 新建模式：按 thread_id 在 ~/.codex/sessions 下找 rollout-*.jsonl
function locate(state) {
  if (!state.id) return null;
  const hit = walk(path.join(HOME, ".codex", "sessions"))
    .find((f) => path.basename(f).includes(state.id));
  return { id: state.id, file: hit || "" };
}

module.exports = { build, stream, finalize: null, locate };
