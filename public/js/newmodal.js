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

// 首条消息跑完后，把新会话接进列表并打开；找不到就提示刷新
async function afterCreate(j) {
  try {
    state.sessions = await (await fetch("/api/sessions?force=1")).json();
    renderList();
    updateStats();
  } catch {}
  // pi 扫描器给的 id 是文件名尾 8 位，与这里拿到的大写 uuid 对不上，
  // 所以除了 id 还要比一下文件名，避免明明在列表里却报「没找到」。
  const base = j.file ? j.file.split(/[\\/]/).pop() : "";
  const hit = (j.file && state.sessions.find((s) => s.file === j.file)) ||
    (base && state.sessions.find((s) => (s.file || "").endsWith(base))) ||
    (j.id && state.sessions.find((s) => s.id === j.id && s.tool === j.tool)) ||
    (j.id && state.sessions.find((s) => s.tool === j.tool && String(s.fullId || "").includes(j.id)));

  // 创建期间用户主动点开了别的会话（state.active 从 null 变成某个会话），
  // 说明他不想被拽走——这时只提示、不改他的视图。一开始是 null，
  // 只有「一直在看新建草稿」的情况才自动跳过去。
  if (state.active) {
    toast(hit
      ? "「" + hit.title + "」已创建，可在左侧列表点开"
      : "已创建（id " + j.id + "），点右上角 ↻ 刷新可见");
    return;
  }

  if (hit) {
    state.embedOpen = false;
    await openSession(hit);
    toast("已创建并打开新会话");
  } else {
    toast("已创建（id " + j.id + "），列表还没刷出来，点右上角 ↻ 刷新");
  }
}

function bindNewModal() {
  document.addEventListener("change", (e) => {
    if (e.target.id === "new-tool" || e.target.id === "new-cwd") updateNewCmd();
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "new-cwd") updateNewCmd();
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
