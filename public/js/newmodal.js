/* 新建会话弹窗：工具/目录/首条消息 + 命令预览 + 两种创建方式 */
"use strict";

const NEW_SESSION_CMDS = {
  codex: "codex --no-daemon",
  claude: "claude",
  pi: "pi",
  dsh: "dsh --profile headless",
  hermes: "hermes",
};

// 页面内创建支持的工具（hermes 只读，只能开终端）
const INPAGE_TOOLS = ["codex", "claude", "pi", "dsh"];

/* 工作目录的绝对路径提示。
   服务端会把 `~` / 相对路径 / 尾斜杠归一化成绝对路径（lib/cwd.js），
   但输入框里还留着用户原样写的 `~`。跑起来后界面显示的是真实 cwd，
   若不提前说明，用户会以为「我填的目录被改了」。
   这里只做纯文本提示，真正的解析仍在服务端，避免两边各写一套展开规则。 */
function cwdHint() {
  const el = document.getElementById("new-cwd");
  const tip = document.getElementById("new-cwd-tip");
  if (!el || !tip) return;
  const v = (el.value || "").trim();
  if (!v) { tip.textContent = ""; return; }
  const platformWin = state.platform && state.platform.isWin;
  let shown = "";
  if (!platformWin) {
    if (v === "~") shown = "主目录";
    else if (v.startsWith("~/")) shown = "主目录 / " + v.slice(2);
    else if (!v.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(v)) shown = "主目录下 · " + v;
    else shown = v.replace(/\/+$/, "") || "/";
  }
  tip.textContent = shown ? "将使用：" + shown : "";
}

function updateNewCmd() {
  const box = document.getElementById("new-cmd");
  if (!box) return;
  const toolEl = document.getElementById("new-tool");
  const cwdEl = document.getElementById("new-cwd");
  const tool = toolEl ? toolEl.value : "";
  const cwd = cwdEl ? cwdEl.value.trim() : "";
  const cmd = NEW_SESSION_CMDS[tool] || "?";

  let html = '<span class="lbl">' + cmdPrompt() + '</span>' + esc(cmd);
  if (cwd) {
    html += ' <span class="lbl"># 在</span><span class="frag">' + esc(cwd) +
      '</span><span class="lbl">下执行</span>';
  } else {
    html += ' <span class="lbl"># 填写工作目录后在此目录执行</span>';
  }
  box.innerHTML = html;

  // hermes 是只读存储，页面内创建没有适配器，按钮直接禁用并说明原因
  const pageBtn = document.getElementById("new-inpage");
  if (pageBtn) {
    const ok = INPAGE_TOOLS.includes(tool);
    pageBtn.disabled = !ok;
    pageBtn.title = ok ? "不打开终端，直接在本页跑第一条消息" : "hermes 会话只读，仅支持终端创建";
  }
}

function fillCwdDatalist() {
  const dl = document.getElementById("cwds");
  if (!dl) return;
  const seen = new Set();
  dl.innerHTML = state.sessions
    .map((s) => s.cwd)
    .filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()))
    .slice(0, 30)
    .map((c) => '<option value="' + escAttr(c) + '">')
    .join("");
}

function openNew() {
  fillCwdDatalist();
  const modal = document.getElementById("modal");
  if (modal) modal.classList.add("show");
  const cwd = document.getElementById("new-cwd");
  if (cwd) cwd.focus();
  updateNewCmd();
  cwdHint();
}

function closeNew() {
  const modal = document.getElementById("modal");
  if (modal) modal.classList.remove("show");
}

function newFormValues() {
  const toolEl = document.getElementById("new-tool");
  const cwdEl = document.getElementById("new-cwd");
  const msgEl = document.getElementById("new-first");
  return {
    tool: toolEl ? toolEl.value : "",
    cwd: cwdEl ? cwdEl.value.trim() : "",
    message: msgEl ? msgEl.value.trim() : "",
  };
}

async function doNew(btn) {
  const body = newFormValues();
  if (!body.cwd) { toast("请填写工作目录"); return; }

  let j;
  try {
    const r = await fetch("/api/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: body.tool, cwd: body.cwd }),
    });
    j = await r.json();
  } catch (e) { toast("请求失败: " + e); return; }

  if (j.ok) {
    const old = btn ? btn.textContent : "";
    if (btn) btn.textContent = "已打开终端 ✓";
    setTimeout(() => {
      if (btn) btn.textContent = old || "启动终端";
      closeNew();
    }, 1500);
  } else {
    toast("失败: " + j.error);
  }
}

// ---- 页面内创建：不开终端，直接在本页跑第一条消息 ----
async function doNewInPage(btn) {
  const { tool, cwd, message } = newFormValues();
  if (!INPAGE_TOOLS.includes(tool)) { toast("该工具不支持页面内创建"); return; }
  // 一次只允许一个创建流：并发时两个流都会往 #main 里画，最后谁抢到算谁的，
  // 页面上就出现「两个会话的回复混在一起又被覆盖」，而且会话文件会多出几条。
  if (state.creating) { toast("上一个会话还在创建中，请等它跑完"); return; }
  if (!cwd) { toast("请填写工作目录"); return; }
  if (!message) {
    toast("页面内创建需要填写第一条消息");
    const el = document.getElementById("new-first");
    if (el) el.focus();
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = "创建中…"; }
  closeNew();
  // 弹窗已经关了，按钮不必一直挂着「创建中」——创建可能跑几分钟，期间用户
  // 很可能再开一次弹窗新建，按钮卡在"创建中"且被禁用只会让人以为坏了。
  if (btn) setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "⚡ 页面内创建";
  }, 400);

  try {
    await createInPage({ tool, cwd, message, btn });
  } catch (e) {
    // createInPage 内部已处理流错误，这里兜住 afterCreate 之类的意外，
    // 免得按钮状态和 state.creating 一起卡死。
    toast("创建失败: " + (e && e.message || e));
  }
}

/* 在列表里找刚创建出来的会话。
   🔴 必须重试：CLI 退出与 .jsonl 落盘之间可能差好几秒（实测 claude 偶发 3–5s，
   服务端 awaitSessionFile 也因此从 2.5s 放宽到约 10s）。只扫一次就宣布失败，
   页面会卡在「已落盘 xxx」的草稿态 —— 没有输入栏、消息发不出去、也退不回来，
   表现出来就是「新建后发消息报错」。
   pi 扫描器给的 id 是文件名尾 8 位，与这里拿到的完整 uuid 对不上，
   所以除了 id 还要比文件名和 fullId，避免明明在列表里却报「没找到」。 */
async function findCreated(j, tries, gap) {
  const base = j && j.file ? j.file.split(/[\\/]/).pop() : "";
  for (let i = 0; i < tries; i++) {
    try {
      state.sessions = await (await fetch("/api/sessions?force=1")).json();
      renderList();
      updateStats();
    } catch {}
    const hit = (j.file && state.sessions.find((s) => s.file === j.file)) ||
      (base && state.sessions.find((s) => (s.file || "").endsWith(base))) ||
      (j.id && state.sessions.find((s) => s.id === j.id && s.tool === j.tool)) ||
      (j.id && state.sessions.find((s) => s.tool === j.tool && String(s.fullId || "").includes(j.id)));
    if (hit) return hit;
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gap));
  }
  return null;
}

/* 兜底的收尾视图：会话确实建出来了，但列表还没扫到它。
   绝不能什么都不做就返回 —— 那样 #main 会一直停在「新建会话中」的草稿态，
   输入栏不存在，用户既发不了消息也退不出去，只能刷新整页。 */
function showCreateStuck(j) {
  const badge = document.getElementById("livebadge");
  if (badge) {
    badge.textContent = "● 已创建 · 列表待同步";
    badge.style.background = "#3b3410";
    badge.style.color = "#fcd34d";
  }
  // 顶部那句「首条消息跑完后自动切换」到这一步已经不准了，
  // 留着会让人以为还在跑。换成事实描述。
  const cmd = document.querySelector("#bar .cmd");
  if (cmd) cmd.textContent = "页面内新建 · " + (j.tool || "") + " · 已创建，等待列表同步";
  const chat = document.getElementById("chat");
  if (!chat) return;
  const tip = document.createElement("div");
  tip.className = "emptyhint";
  tip.innerHTML = '<div class="eh-title">会话已创建，但列表里还没扫到</div>' +
    '<div class="eh-body">文件可能刚写完，多等一会儿就能扫到。<br>' +
    'id：<code>' + esc(j.id || "(未知)") + '</code><br><br>' +
    '点下面的按钮重新扫描；若仍不出现，用「▶ 终端恢复会话」在终端里接上。</div>';
  const btn = document.createElement("button");
  btn.className = "primary";
  btn.textContent = "↻ 重新扫描列表";
  btn.style.marginTop = "10px";
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "扫描中…";
    const hit = await findCreated(j, 3, 700);
    btn.disabled = false;
    btn.textContent = "↻ 重新扫描列表";
    if (hit) {
      state.embedOpen = false;
      await openSession(hit);
      toast("已打开新会话");
    } else {
      toast("仍未扫到，可点右上角 ↻ 或重启对应的 CLI 后重试");
    }
  };
  tip.appendChild(btn);
  chat.appendChild(tip);
}

// 首条消息跑完后，把新会话接进列表并打开；找不到就重试，最后也要给出可操作的收尾
async function afterCreate(j) {
  // 创建期间用户主动点开了别的会话（state.active 从 null 变成某个会话），
  // 说明他不想被拽走 —— 这时只提示、不改他的视图，也没必要反复扫描。
  const taken = !!state.active;
  const hit = await findCreated(j, taken ? 1 : 6, 700);

  if (taken) {
    toast(hit
      ? "「" + hit.title + "」已创建，可在左侧列表点开"
      : "已创建（id " + j.id + "），点右上角 ↻ 刷新可见");
    return;
  }

  if (hit) {
    // 新建完通常是接着聊，直接把输入栏展开 —— 让用户再点一次「页面内恢复」
    // 才出现输入框，会让人以为建完就发不了消息了。
    state.embedOpen = true;
    await openSession(hit);
    toast("已创建并打开新会话");
    return;
  }
  showCreateStuck(j);
}

function bindNewModal() {
  document.addEventListener("change", (e) => {
    if (e.target.id === "new-tool" || e.target.id === "new-cwd") updateNewCmd();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "new-cwd") { updateNewCmd(); cwdHint(); }
  });
  // Ctrl+Enter 直接页面内创建；Escape 关闭弹窗（创建中不响应，避免误关掉进度）
  document.addEventListener("keydown", (e) => {
    const modal = document.getElementById("modal");
    if (!modal || !modal.classList.contains("show")) return;
    if (e.key === "Escape") {
      if (state.creating) return;
      e.preventDefault();
      closeNew();
      return;
    }
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    doNewInPage(document.getElementById("new-inpage"));
  });
}
