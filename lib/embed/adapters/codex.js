// Codex CLI 嵌入式会话适配器
//
// 恢复：exec resume --json --skip-git-repo-check <id> -  ← prompt 从 stdin 读（`-` 即 stdin 约定）
//        [-m model] [-c model_reasoning_effort=x]
// 新建：exec --json --skip-git-repo-check -              ← 同样 stdin 传 prompt
//
// 为什么把 prompt 改走 stdin 而不是命令行参数：
//   Windows 上要经 cmd.exe 转发 .cmd shim，用户输入里只要有 `"` `&` `|` `^` `%`
//   就会被打断或改写，多层转义难以穷尽。stdin 是字节流，任何内容原样送达。
//   Linux 侧实测 `codex exec resume <id> -` 同样正常（退出码 0、输出与参数式一致），
//   于是两个平台共用一条路径，不再按平台分叉。
//
// 【实测 2026-11-23】两种模式统一走 --json：
//   · 新建本来就必须 --json（纯文本拿不到 thread_id，前端不知道新会话落在哪个 id）。
//   · 恢复原先走纯文本直通，正文能逐字流式；但纯文本模式**完全不吐 reasoning**，
//     codex 会话就永远显示不出思考。加上 --json 实测 thread_id 与原会话一致
//     （01a208ad-… 原样回带），可以安全切换。
//   · 代价：JSON 模式的正文按 item.completed 整段到达，不再逐字出现。
//     这是为了让思考可见而接受的取舍，别误判成"流式坏了"。
//
// --json 输出是 JSONL 事件流：
//   {"type":"thread.started","thread_id":"..."}                      ← 新会话 id
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"type":"reasoning","text":"**Checking server..."}}
//   {"type":"turn.completed"}
//
// 思考内容：
//   · 默认没有任何 reasoning item。只有显式加
//       -c model_reasoning_summary=detailed
//     才会吐 {"type":"item.completed","item":{"type":"reasoning","text":"…"}}。
//   · 给的只是**一句摘要标题**（实测 "**Checking server connectivity**"），
//     不是逐步推理链 —— 完整思维链留在服务端，CLI 不导出。
//   · 【实测】极不稳定：同一提示连跑 3 次可能一次都不吐（改文件的工具型任务 3/3 无），
//     偶尔（有 MCP 工具调用的轮次）才出一条。所以 codex 会话的思考块时有时无，
//     不是解析漏了。想稳定看到思考请用 claude / dsh。
//   · 它可能出现在正文之前，也可能夹在两次工具调用之间，所以每条 reasoning
//     item 都单独发，前端按到达顺序累积。
const fs = require("fs");
const path = require("path");
const { HOME } = require("../../config");
const { walk, tryJson } = require("../../utils");

function build({ id, model, effort, create }) {
  const args = create
    ? ["exec", "--json", "--skip-git-repo-check", "-"]
    : ["exec", "resume", "--json", "--skip-git-repo-check", id, "-"];
  if (model) args.push("-m", model);
  if (effort) args.push("-c", "model_reasoning_effort=" + effort);
  // 不加这句就没有任何 reasoning item（实测）。实测放在 `-` 之后也能生效。
  args.push("-c", "model_reasoning_summary=detailed");
  return { args, useStdin: true, json: true };
}

// state: { buf, id, wrote, thought }  ctx: { emit(s), emitErr(s), emitThink(s) }
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
    } else if (it.type === "reasoning" && it.text) {
      ctx.emitThink((state.thought ? "\n\n" : "") + it.text);
      state.thought = true;
    } else if (it.type === "error" && it.message && !state.wrote) {
      // 配置告警（如 `disable_response_storage` 已废弃）会以 error item 连报两条，
      // 但它们不影响本次回答，抖在正文前面只会让人以为出错了 → 过滤掉。
      const m = String(it.message);
      if (!/^Codex is ignoring/i.test(m)) ctx.emitErr(m.slice(0, 500));
    }
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

// 末行可能没换行（进程被 kill / 输出未补 \n），不能整行丢掉
function finalize(state, ctx) {
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
