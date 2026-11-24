// 页面内会话：以 SSE 流式返回子进程输出
//
// 两种模式：
//   resume（默认）—— 接着已有会话跑一条消息，agent 去 adapters/ 里按工具分派
//   create        —— 在页面里直接开一个新会话：跑完第一条消息后把新会话的
//                    id / 文件路径通过 SSE 发回去，前端立刻切过去
//
// 各工具的差异全在 adapters/：
//   claude: --resume <id> / --session-id <uuid>，-p --output-format stream-json
//   codex:  exec resume <id> - / exec --json -（都从 stdin 读 prompt）
//   pi:     --session <file> -p（新建时由服务端指定会话文件路径）
//   dsh:    --profile headless --json [--session-id <id>] <message>（消息走参数，
//           且必须在会话记录的 cwd 下执行，否则 dsh 会拒绝恢复）
//   hermes: 会话为只读存储，resume 报 session_read_only，新建也不支持
//
// SSE 事件（前端 public/js/embed.js 消费）：
//   {t:"delta", s}  正文增量
//   {t:"think", s}  思考过程增量 —— 与 delta 走不同通道，前端塞进折叠块，
//                   绝不能混进 delta，否则思考内容会当成正式回答显示出来
//   {t:"err", s}    错误
//   {t:"created"} / {t:"done"}
//
// 思考通道各家能给的东西差很多（2026-11-23 全部实测）：
//   claude —— 完整明文。assistant.message.content[].{type:"thinking",thinking}
//   dsh    —— 完整明文。{"type":"thinking","text":"…"}
//   codex  —— 只有一句摘要标题，需显式 -c model_reasoning_summary=detailed；
//             完整推理链在模型侧，CLI 不吐（见 adapters/codex.js）
//   pi     —— 拿不到。thinking 字段恒为空串，真内容封在
//             thinkingSignature.encrypted_content 里，需 provider 密钥才能解
//
// 跨平台：进程启动统一走 platform.spawnTool，它负责把 claude/codex 这类
// Windows 上的 .cmd shim 经 cmd.exe 转发（Node 18.20+ 直接 spawn .cmd 会 EINVAL）。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HOME, EMBED_TIMEOUT_MS } = require("../config");
const { spawnTool, resolveCommand } = require("../platform");
const { invalidateSessions } = require("../sessions");
const { resolveCwd } = require("../cwd");

const ADAPTERS = {
  claude: require("./adapters/claude"),
  codex: require("./adapters/codex"),
  pi: require("./adapters/pi"),
  dsh: require("./adapters/dsh"),
};

// 新建会话支持的工具（hermes 只读，排除）
const CREATABLE_TOOLS = ["claude", "codex", "pi", "dsh"];

// 落盘探测：CLI 退出和文件写完之间有延迟。
//
// 🔴 原来只等 2.5s（25×100ms），实测偏短：claude 新建会话偶尔要 3–5s 才把
// .jsonl 落盘，于是这里返回 `file: ""`，前端按路径匹配必然落空，页面就卡在
// 「已落盘 xxx」的草稿态 —— 没有输入栏、也打不开发送，看起来就是「新建后
// 发消息报错」。现在放到约 10s，前端还有一轮补偿重试（见 newmodal.js 的 afterCreate）。
//
// 间隔用递增退避而不是固定 100ms：codex / claude 的 locate() 是 walk 整个
// sessions 目录（实测几千个文件），每 100ms 扫一遍纯属浪费 CPU。
// 前几拍快（大概率立即命中），之后逐步拉长，总时长不变但扫描次数降到 1/4。
//
// 等不到也照常返回（id 已经有了），不把整个请求算失败。
function awaitSessionFile(adapter, state) {
  const GAPS = [100, 150, 250, 400, 600, 800];   // 累计约 10s（6 组跑满 22 拍）
  return new Promise((resolve) => {
    let i = 0;
    const tick = () => {
      let hit = null;
      try { hit = adapter.locate(state); } catch { hit = null; }
      if (hit && hit.file && fs.existsSync(hit.file)) return resolve(hit);
      if (i >= 22) return resolve(hit || (state.id ? { id: state.id, file: "" } : null));
      const gap = GAPS[Math.min(Math.floor(i / 4), GAPS.length - 1)];
      i++;
      setTimeout(tick, gap);
    };
    tick();
  });
}

function embedRun(body, res) {
  const { tool, id, file, model, effort } = body;
  let { cwd, message } = body;
  const create = !!body.create;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch {} };
  const fail = (msg) => { send({ t: "err", s: msg }); send({ t: "done" }); res.end(); };

  message = String(message || "");
  if (!message.trim()) return fail("消息为空");
  if (tool === "hermes") return fail("hermes 会话是只读存储，不支持页面内会话，请用「▶ 终端恢复会话」");
  if (tool !== "hermes" && !CREATABLE_TOOLS.includes(tool)) return fail("unknown tool: " + tool);

  // create=true 表示新建；resume 需要 id（pi 用 file 定位，不强制 id）
  if (!create && (tool === "claude" || tool === "codex" || tool === "dsh") && !id) {
    return fail("该会话缺少 id，无法恢复");
  }
  // pi 恢复靠 --session <file>，没有 id 可退回，缺路径就必须早报错，
  // 否则会把字面量 "undefined" 传给 pi，用户看到的是 `No session found matching 'undefined'`
  if (!create && tool === "pi" && !file) {
    return fail("该会话缺少文件路径，无法恢复");
  }

  const adapter = ADAPTERS[tool];
  if (!adapter) return fail("unknown tool: " + tool);

  // 目录校验分开处理：
  //   新建 —— 必须是真实目录。以前不存在就静默退回 HOME，等于在用户没指定的
  //          地方造出一个会话（目录打错也毫无提示），对新会话是错的默认。
  //   恢复 —— 目录可能已被删，退回 HOME 让 CLI 至少能起来。
  //           例外是 dsh：它按 cwd 校验会话归属，退回 HOME 必然报
  //           "was recorded in X, not Y"，所以宁可早报错让用户知道目录没了。
  // 两种模式都先做路径归一化：`~`、相对路径、尾斜杠都要能识别（见 lib/cwd.js）。
  // 这一条同样重要 —— 扫描器返回的 cwd 是原文，用户手填的可能是 `~` 或相对路径。
  const chk = resolveCwd(cwd);
  cwd = chk.cwd || "";
  if (create) {
    if (!chk.ok) return fail(chk.error);
  } else if (!chk.ok) {
    if (tool === "dsh") {
      return fail("该会话的工作目录已不存在（" + (cwd || "空") + "），dsh 只能在原目录下恢复");
    }
    cwd = HOME;
  }
  const sessionId = create ? crypto.randomUUID() : id;

  let built;
  try {
    built = adapter.build({
      id, file, message,
      model: String(model || "").trim(),
      effort: String(effort || "").trim(),
      create, cwd, sessionId,
    });
  } catch (e) { return fail(String(e.message || e)); }

  const env = { ...process.env };
  delete env.TERM; // pi 等在 TERM=dumb 下行为异常

  // CLI 不存在时给明确提示，而不是让用户看 ENOENT 堆栈
  if (!resolveCommand(tool)) {
    return fail("未找到命令 `" + tool + "`，请确认它已安装并在 PATH 中");
  }

  let child;
  try { child = spawnTool(tool, built.args, { cwd, env }); }
  catch (e) { return fail(String(e.message || e)); }

  const state = {
    buf: "",
    id: create ? sessionId : "",
    file: built.file || "",
    json: !!built.json,
    wrote: false,
  };
  let errBuf = "", gotAny = false, finished = false;

  const ctx = {
    emit: (s) => { if (s) { gotAny = true; send({ t: "delta", s }); } },
    emitErr: (s) => { send({ t: "err", s }); },
    // 思考增量单独一条通道：前端要把它放进默认折叠的 <details>，和正文分栏显示。
    // 空串直接丢，避免前端反复插空节点。
    emitThink: (s) => { if (s) send({ t: "think", s }); },
  };

  const finish = async () => {
    if (finished) return;
    finished = true;
    if (adapter.finalize) adapter.finalize(state, ctx);
    if (!gotAny && errBuf) send({ t: "err", s: errBuf.slice(0, 2000) });

    // 新建：把新会话交回前端，让它能立刻打开
    if (create && state.id) {
      let loc = null;
      try { loc = await awaitSessionFile(adapter, state); } catch {}
      invalidateSessions();
      // 文件没等到也照发 created（file 为空）：会话确实建出来了，前端据此
      // 刷新列表并给出「点 ↻ 刷新」的提示。若这里改发 err，界面会显示
      // 「没有创建成功」，与事实相反。
      send({ t: "created", tool, id: (loc && loc.id) || state.id, file: (loc && loc.file) || "" });
    }
    send({ t: "done" });
    res.end();
  };

  const timer = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch {}
    // 静默杀掉的话，界面上正文会停在一半、转圈结束，用户不知道发生了什么
    send({ t: "err", s: "运行超过 " + Math.round(EMBED_TIMEOUT_MS / 60000) + " 分钟，已终止" });
    finish();
  }, EMBED_TIMEOUT_MS);

  child.stdout.on("data", (d) => adapter.stream(d.toString(), state, ctx));
  child.stderr.on("data", (d) => { errBuf += d.toString(); });
  child.on("error", (e) => { clearTimeout(timer); send({ t: "err", s: String(e) }); finish(); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code !== 0 && !gotAny && !errBuf) send({ t: "err", s: tool + " 进程退出码 " + code });
    finish();
  });

  if (built.useStdin) {
    // 子进程可能还没读就退出（如 id 不存在），此时 write 会 EPIPE。
    // 不接 error 事件会让整个 Node 进程抛未捕获异常，服务直接挂掉。
    child.stdin.on("error", () => {});
    child.stdin.write(message + "\n");
    child.stdin.end();
  }
}

module.exports = { embedRun, CREATABLE_TOOLS, SUPPORTED_TOOLS: Object.keys(ADAPTERS) };
