/* 页面内恢复：输入栏、模型/思考强度自绘下拉、SSE 流式收发 */
"use strict";

// hermes 会话是只读存储，不支持页面内恢复
function isEmbeddable(s) { return !!s && s.tool !== "hermes"; }

function inputBarHtml(embedOn) {
  return '<div id="inputbar" class="' + (embedOn ? "show" : "") + '">' +
    '<textarea id="embed-input" placeholder="继续此会话…" ' +
      'title="Enter 发送，Shift+Enter 换行"></textarea>' +
    '<div class="selcol col-model"><label>模型</label>' +
      '<div class="dd" id="dd-model">' +
        '<div class="ddbtn" onclick="toggleDD(\'dd-model\')"><span>默认</span></div>' +
        '<div class="ddlist" id="dd-model-list"></div>' +
      '</div></div>' +
    '<div class="selcol col-effort"><label>思考强度</label>' +
      '<div class="dd" id="dd-effort">' +
        '<div class="ddbtn" onclick="toggleDD(\'dd-effort\')"><span>默认</span></div>' +
        '<div class="ddlist" id="dd-effort-list"></div>' +
      '</div></div>' +
    '<button class="primary" id="embed-send" onclick="sendEmbed()">发送</button>' +
  '</div>';
}

// ---- 自绘下拉（原生 <select> 弹层宽度不可控，故自己画） ----
function toggleDD(id) {
  const box = document.getElementById(id);
  if (!box) return;
  const wasOpen = box.classList.contains("open");
  closeDD();
  if (!wasOpen) box.classList.add("open");
}

function closeDD() {
  document.querySelectorAll("#inputbar .dd.open").forEach((b) => b.classList.remove("open"));
}

function pickDD(kind, value, label, el) {
  if (kind === "model") state.selModel = value;
  else state.selEffort = value;
  const box = document.getElementById("dd-" + kind);
  if (box) {
    const span = box.querySelector(".ddbtn > span");
    if (span) span.textContent = label || "默认";
    box.querySelectorAll(".ddopt").forEach((o) => o.classList.remove("sel"));
    if (el) el.classList.add("sel");
  }
  closeDD();
}

async function ensureModelCatalog() {
  if (state.modelCatalog) return state.modelCatalog;
  try {
    state.modelCatalog = await (await fetch("/api/models")).json();
  } catch {
    state.modelCatalog = { claude: [], codex: [], pi: [], efforts: {} };
  }
  return state.modelCatalog;
}

// 选项元素用 DOM 构造，避免拼字符串时的引号转义问题
function createOptionEl(kind, value, label, selected) {
  const el = document.createElement("div");
  el.className = "ddopt" + (selected ? " sel" : "");
  el.textContent = label;
  el.onclick = () => pickDD(kind, value, label, el);
  return el;
}

function fillList(box, kind, entries) {
  box.innerHTML = "";
  for (const { value, label, selected } of entries) {
    box.appendChild(createOptionEl(kind, value, label, selected));
  }
}

async function fillEmbedSelectors() {
  const tool = state.active && state.active.tool;
  const mlist = document.getElementById("dd-model-list");
  const elist = document.getElementById("dd-effort-list");
  if (!mlist || !elist || !tool) return;

  const cat = await ensureModelCatalog();
  const models = cat[tool] || [];
  const efforts = (cat.efforts && cat.efforts[tool]) || [];

  fillList(mlist, "model", [{ value: "", label: "默认", selected: true }].concat(
    models.map((m) => ({ value: m.id, label: m.label || m.id, selected: false }))));
  fillList(elist, "effort", [{ value: "", label: "默认", selected: true }].concat(
    efforts.map((x) => ({ value: x, label: x, selected: false }))));

  state.selModel = "";
  state.selEffort = "";
  const mb = document.querySelector("#dd-model .ddbtn > span");
  const eb = document.querySelector("#dd-effort .ddbtn > span");
  if (mb) mb.textContent = "默认";
  if (eb) eb.textContent = "默认";
}

// 点击空白处收起弹层
document.addEventListener("click", (e) => {
  if (!e.target.closest("#inputbar .dd")) closeDD();
});

// ---- 展开 / 收起输入栏 ----
function toggleEmbed(btn) {
  state.embedOpen = !state.embedOpen;
  const ib = document.getElementById("inputbar");
  const badge = document.getElementById("livebadge");
  if (ib) ib.classList.toggle("show", state.embedOpen);
  if (badge) badge.style.display = state.embedOpen ? "inline-block" : "none";
  if (btn) btn.textContent = state.embedOpen ? "✕ 关闭页面内会话" : "💻 页面内恢复";
  if (state.embedOpen) {
    fillEmbedSelectors();
    const ta = document.getElementById("embed-input");
    if (ta) ta.focus();
  }
}

function bindEmbedInput() {
  const ta = document.getElementById("embed-input");
  if (!ta) return;
  ta.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!state.embedBusy) sendEmbed();
    }
  };
}

// ---- 流式消息 ----
function appendLiveMsg(role, text, cls) {
  let chat = document.getElementById("chat");
  if (!chat) return null;
  const div = document.createElement("div");
  div.className = "msg " + role + (cls ? " " + cls : "") + " live";
  div.innerHTML = '<div class="who">' + (role === "user" ? "👤 用户" : "🤖 助手") +
    ' <span style="opacity:.6">· 页面内</span></div><div class="bubble raw"></div>';
  const bubble = div.querySelector(".bubble");
  bubble.textContent = text;
  chat.appendChild(div);
  scrollChatBottom();
  return bubble;
}

/* 跑一条 /api/embed 的 SSE 流，把增量写进 bubble。
   返回 { live, created, errs }：live 是累计正文，created 是新建会话成功后后端回的
   { tool, id, file }（恢复模式恒为 null），errs 是后端发过的错误文案（用于收尾叙述）。
   抽成函数是因为「页面内恢复」和「页面内新建」走的是同一条流，
   差别只在于消息发送前/后怎么处理，不必复制一遍 reader 循环。 */
async function runEmbedStream(body, bubble, onCreated) {
  let live = "", created = null;
  const errs = [];
  const r = await fetch("/api/embed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.body) throw new Error("HTTP " + r.status);

  // 正常是 200 + text/event-stream。请求体不合法等异常走的是 JSON 分支
  // （router 的 catch 返回 500 JSON），此时绝不能当 SSE 读——那样一个字节都
  // 匹配不上 `data: `，界面会安静地什么都没有，用户以为点了没反应。
  const ctype = r.headers.get("Content-Type") || "";
  if (!ctype.includes("text/event-stream")) {
    let detail = "";
    try {
      const j = await r.json();
      detail = j && (j.error || j.s);
    } catch {}
    throw new Error("HTTP " + r.status + (detail ? " · " + detail : ""));
  }

  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data: ")) continue;
      let o;
      try { o = JSON.parse(chunk.slice(6)); } catch { continue; }
      if (o.t === "delta") {
        live += o.s;
        // 用户可能在流没跑完时切到别的会话，此时 bubble 已不在文档里，
        // 再写只是改一个游离节点；滚动也无意义。
        if (bubble && bubble.isConnected) { bubble.textContent = live; scrollChatBottom(); }
      } else if (o.t === "err") {
        errs.push(String(o.s));
        // 同理：不能往「当前」#chat 里塞上一个会话的错误，那会张冠李戴
        if (!bubble || bubble.isConnected) appendLiveMsg("assistant", "⚠ " + o.s, "errmsg");
      } else if (o.t === "created") {
        created = { tool: o.tool, id: o.id, file: o.file };
        if (onCreated) onCreated(created);
      }
    }
  }
  return { live, created, errs };
}


function setEmbedBusy(busy) {
  state.embedBusy = busy;
  const ta = document.getElementById("embed-input");
  const btn = document.getElementById("embed-send");
  const mdd = document.getElementById("dd-model");
  const edd = document.getElementById("dd-effort");
  if (ta) ta.disabled = busy;
  if (btn) { btn.disabled = busy; btn.textContent = busy ? "运行中…" : "发送"; }
  if (mdd) mdd.style.pointerEvents = busy ? "none" : "";
  if (edd) edd.style.pointerEvents = busy ? "none" : "";
  if (!busy && ta) ta.focus();
}

async function sendEmbed() {
  if (state.embedBusy) return;
  const ta = document.getElementById("embed-input");
  const text = (ta && ta.value || "").trim();
  if (!text || !state.active) return;

  // 记下本次回复属于哪个会话：流跑完要重画，若此时用户已切到别的会话，
  // 就不能拿旧会话去 openSession，否则会把用户刚点开的会话顶掉。
  const owner = state.active;
  setEmbedBusy(true);
  closeDD();
  if (ta) ta.value = "";

  appendLiveMsg("user", text);
  const bubble = appendLiveMsg("assistant", "思考中…", "");

  let live = "";
  try {
    const r = await runEmbedStream({
      tool: owner.tool, id: owner.id, file: owner.file,
      cwd: owner.cwd, message: text,
      model: state.selModel, effort: state.selEffort,
    }, bubble);
    live = r.live;
  } catch (e) {
    if (!bubble || bubble.isConnected) appendLiveMsg("assistant", "⚠ 请求失败: " + e, "errmsg");
  }

  if (!live && bubble) {
    const wrap = bubble.parentElement;
    if (wrap) wrap.remove();
  }
  // 流式期间是纯文本（边打字边解析会闪烁），结束后一次性转 Markdown
  if (live && bubble && bubble.isConnected && !state.mdOff) {
    bubble.innerHTML = mdToHtml(live);
    bubble.classList.remove("raw");
  }
  setEmbedBusy(false);
  // 嵌入会话已写回文件，刷新列表与消息
  try {
    state.sessions = await (await fetch("/api/sessions?force=1")).json();
    renderList();
    updateStats();
  } catch {}
  // 只有用户还停在这个会话上才重载；否则会把他正在看的会话换掉，
  // 但要告诉他回复落在哪个会话里，不然他以为没发出去。
  if (state.active && state.active.file === owner.file) openSession(state.active);
  else toast("「" + owner.title + "」已回复，切回该会话可查看");
}

/* ---- 页面内新建会话：不弹终端，直接在本页跑第一条消息 ---- */
function appendNewChat(draft) {
  state.active = null;
  state.msgs = [];
  state.embedOpen = false;
  // 左侧列表要跟着取消高亮：新会话还没落盘，此时任何高亮的旧会话都是错觉
  renderList();
  const bar = '<div id="bar"><div class="info">' +
      '<div class="cwd">📁 ' + esc(draft.cwd) +
        '<span id="livebadge" style="display:inline-block">● 新建会话中</span></div>' +
      '<div class="cmd">' + esc("页面内新建 · " + (draft.tool || "")) +
      ' · 首条消息跑完后自动切换</div></div></div>';
  $("#main").innerHTML = bar + '<div id="chat"></div>';
  appendLiveMsg("user", draft.message);
}

async function createInPage({ tool, cwd, message }) {
  state.creating = true;
  appendNewChat({ tool, cwd, message });
  const bubble = appendLiveMsg("assistant", "思考中…", "");
  let live = "", created = null, failed = "";

  try {
    // 不传 model / effort：弹窗里没有模型选择，带上前一个会话的残留值
    // 会把 A 工具的模型 id 塞给 B 工具，CLI 直接报错。新建一律用各 CLI 默认。
    let r;
    try {
      r = await runEmbedStream({
        create: true, tool, cwd, message,
      }, bubble, (c) => {
        created = c;
        const badge = document.getElementById("livebadge");
        if (badge) badge.textContent = "● 已落盘 " + c.id.slice(-8);
      });
      live = r.live;
      created = r.created || created;
      // 后端明确报错（如目录不存在）时，即便 created 有值也以错误叙述为主，
      // 免得界面显示"成功"而用户不知道其实没跑起来。这里只收集不覆盖。
      if (r.errs && r.errs.length && !failed) failed = r.errs[0];
    } catch (e) {
      failed = String(e.message || e);
      appendLiveMsg("assistant", "⚠ 请求失败: " + failed, "errmsg");
    }
  } finally {
    state.creating = false;
  }

  // 先判断草稿视图还在不在：下面没正文时会把这个 bubble 连壳删掉，
  // 删完 isConnected 就是 false，不能再拿它当「用户切走了」的证据。
  const stillDraft = !state.active && !!document.getElementById("chat");

  if (!live && bubble) {
    const wrap = bubble.parentElement;
    if (wrap) wrap.remove();
  }
  if (live && bubble && !state.mdOff) {
    bubble.innerHTML = mdToHtml(live);
    bubble.classList.remove("raw");
  }

  if (created) return afterCreate(created);

  // 创建期间用户已切到别的会话：草稿视图已被换掉，别再往人家页面上贴失败卡片
  if (!stillDraft) {
    toast("新建失败：" + (failed || "命令行工具没有返回新会话 id"));
    return;
  }

  // 没拿到 created：这条会话在列表里不存在，留在「新建会话中」的假状态里
  // 会让用户以为还在跑（输入栏也没有，无处可退）。明确收尾，给出下一步。
  const badge = document.getElementById("livebadge");
  if (badge) {
    badge.textContent = "● 未创建";
    badge.style.background = "#5c1d1d";
    badge.style.color = "#fca5a5";
  }
  const chat = document.getElementById("chat");
  if (chat) {
    const tip = document.createElement("div");
    tip.className = "emptyhint";
    tip.innerHTML = '<div class="eh-title">没有创建成功</div><div class="eh-body">' +
      esc(failed || "命令行工具没有返回新会话 id。") +
      '<br><br>可以点左上角「＋ 新建会话」改填工作目录后重试，' +
      '或改用「启动终端」在终端里创建。若命令行工具本身报错，' +
      '先在同一目录下用终端跑一次排查看具体原因。</div>';
    chat.appendChild(tip);
  }
  // 至少把列表刷出来（万一文件其实落盘了，只是没回 id）
  try {
    state.sessions = await (await fetch("/api/sessions?force=1")).json();
    renderList();
    updateStats();
  } catch {}
}

