/* 右侧正文：打开会话、渲染消息、分页、顶部操作栏 */
"use strict";

async function openSession(s) {
  state.active = s;
  renderList();
  const main = $("#main");
  main.innerHTML = '<div id="chat"><p style="color:var(--dim)">加载中…</p></div>';
  const url = "/api/session?file=" + encodeURIComponent(s.file) + "&tool=" + s.tool;
  let msgs;
  try { msgs = await (await fetch(url)).json(); }
  catch (e) {
    main.innerHTML = '<div id="empty">解析失败: ' + esc(String(e)) + '</div>';
    return;
  }
  if (!Array.isArray(msgs)) {
    main.innerHTML = '<div id="empty">解析失败: ' + esc(msgs && msgs.error || "") + '</div>';
    return;
  }
  state.msgs = msgs;
  renderChat();
}

// 思考过程：默认折叠，点一行摘要展开。
// 用原生 <details> 而不是自绘 div：键盘 / 读屏天然可用，也不用自己管展开状态。
// 折叠状态下只有一行摘要（💭 思考过程 + 字数），不会把正文挤走。
// 注意：折叠时内容虽在 DOM 里，但浏览器内查找（Ctrl+F）搜不到 —— 实测
// window.find 返回 false，展开后才能命中。想全库搜思考内容需要先点开。
function thinkHtml(t) {
  if (!t) return "";
  const body = state.mdOff
    ? '<div class="raw">' + esc(t) + "</div>"
    : mdToHtml(t);
  const n = t.length;
  const size = n >= 1000 ? (n / 1000).toFixed(1) + "k 字" : n + " 字";
  return '<details class="think">' +
      '<summary>💭 思考过程 <span class="tmeta">' + size + "</span></summary>" +
      '<div class="tbody">' + body + "</div>" +
    "</details>";
}

function msgHtml(m) {
  const toolHtml = m.tool
    ? '<div class="toolchip" title="' + escAttr(m.tool) + '">⚙ ' + esc(m.tool) + '</div>' : "";
  const sc = m.sidechain ? " sidechain" : "";
  const who = m.role === "user" ? "👤 用户" : "🤖 助手";
  const time = m.time ? esc(String(m.time).replace("T", " ").slice(0, 19)) : "";
  // 正文走 Markdown 渲染（md.js），已是安全 HTML，不再 esc
  const body = m.text
    ? (state.mdOff ? '<div class="raw">' + esc(m.text) + "</div>" : mdToHtml(m.text))
    : "";
  return '<div class="msg ' + m.role + sc + '">' +
      '<div class="who">' + who + ' ' + time + (m.sidechain ? " · sidechain" : "") + '</div>' +
      thinkHtml(m.think) +
      (body ? '<div class="bubble md">' + body + '</div>' : "") + toolHtml +
    '</div>';
}

function renderChat() {
  const s = state.active;
  const msgs = state.msgs || [];

  // 正文不分页：一次性全部渲染。会话消息数最多几百条，直接铺完比翻页更好用
  // （找上下文时不用来回翻页，Ctrl+F 浏览器内查找也能命中全部内容）。
  // 无正文时给出解释，别只留一片空白
  const emptyHint = msgs.length
    ? ""
    : '<div class="emptyhint">' +
        '<div class="eh-title">该会话没有对话内容</div>' +
        '<div class="eh-body">文件里只有会话元数据（启动记录 / 中断标记），没有用户提问和助手回复。' +
        '常见原因：<br>' +
        '· <b>codex exec</b> 启动后立即被中断（<code>turn_aborted</code>）<br>' +
        '· 会话刚创建就退出，或上下文压缩后原消息被清理<br><br>' +
        '可以点右上角「▶ 终端恢复会话」继续这个会话，或直接删除。' +
      '</div>';
  const chat = '<div id="chat">' + msgs.map(msgHtml).join("") + emptyHint + "</div>";

  const embedOn = state.embedOpen && isEmbeddable(s);
  const badge = isEmbeddable(s)
    ? '<span id="livebadge" style="display:' + (embedOn ? "inline-block" : "none") + '">● 嵌入会话中</span>'
    : "";
  const bar = '<div id="bar"><div class="info">' +
      '<div class="cwd">📁 ' + esc(s.cwd || "(未知目录)") + badge + '</div>' +
      '<div class="cmd">' + cmdPrompt() + ' ' + esc(s.resumeCmd) + '</div></div>' +
      '<button id="mdbtn" class="' + (state.mdOff ? "" : "on") + '" onclick="toggleMd(this)" ' +
        'title="切换 Markdown 渲染 / 纯文本">M↓ Markdown</button>' +
      '<button onclick="reloadActive(this)" title="重新读取本会话">↻ 刷新</button>' +
      '<button onclick="copyCmd()">复制命令</button>' +
      '<button onclick="doExport()">导出 MD</button>' +
      (isEmbeddable(s)
        ? '<button onclick="toggleEmbed(this)">' +
            (embedOn ? "✕ 关闭页面内会话" : "💻 页面内恢复") + '</button>' : '') +
      '<button class="primary" onclick="doResume(this)">▶ 终端恢复会话</button></div>';

  $("#main").innerHTML = bar + chat + (isEmbeddable(s) ? inputBarHtml(embedOn) : "");
  bindEmbedInput();
  if (embedOn) {
    fillEmbedSelectors();
    const ta = $("#embed-input");
    if (ta) ta.focus();
  }
}

function scrollChatBottom() {
  const chat = $("#chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}

// ---- Markdown 开关 ----
function toggleMd(btn) {
  state.mdOff = !state.mdOff;
  btn.classList.toggle("on", !state.mdOff);
  renderChat();
  scrollChatTop();
}

// ---- 刷新当前会话（重读文件） ----
async function reloadActive(btn) {
  const s = state.active;
  if (!s) return;
  if (btn) { btn.classList.add("spin"); btn.disabled = true; }
  try {
    const url = "/api/session?file=" + encodeURIComponent(s.file) + "&tool=" + s.tool + "&t=" + Date.now();
    const msgs = await (await fetch(url)).json();
    if (!Array.isArray(msgs)) throw new Error(msgs && msgs.error || "解析失败");
    state.msgs = msgs;
    renderChat();
    scrollChatTop();
    toast("已刷新 · " + msgs.length + " 条消息");
  } catch (e) {
    toast("刷新失败: " + e);
  } finally {
    if (btn) { btn.classList.remove("spin"); btn.disabled = false; }
  }
}

function scrollChatTop() {
  const chat = $("#chat");
  if (chat) chat.scrollTop = 0;
}

// ---- 顶部操作 ----
function copyCmd() {
  if (!state.active) return;
  navigator.clipboard.writeText(state.active.resumeCmd).then(() => toast("已复制")).catch(() => {});
}

function doExport() {
  const s = state.active;
  if (!s) return;
  location.href = "/api/export?file=" + encodeURIComponent(s.file) +
    "&tool=" + s.tool +
    "&title=" + encodeURIComponent(s.title) +
    "&id=" + encodeURIComponent(s.id || "") +
    "&cwd=" + encodeURIComponent(s.cwd || "");
}

async function doResume(btn) {
  const s = state.active;
  if (!s) return;
  let j;
  try {
    const r = await fetch("/api/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool: s.tool, id: s.id, file: s.file, cwd: s.cwd }),
    });
    j = await r.json();
  } catch (e) {
    toast("请求失败: " + e);
    return;
  }
  if (j.ok) {
    btn.textContent = "已打开终端 ✓";
    toast("终端: " + j.terminal);
    setTimeout(() => { btn.textContent = "▶ 终端恢复会话"; }, 2000);
  } else {
    toast("失败: " + j.error + " — 命令已复制");
    navigator.clipboard.writeText(s.resumeCmd).catch(() => {});
  }
}
