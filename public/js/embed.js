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
/* 把弹层夹进视口。
   弹层默认 right:0（右边缘贴按钮），但模型下拉在输入栏左侧、强度在右侧，
   宽度又远大于按钮（桌面 460、手机整行），于是窄屏上左边缘会被推出视口，
   左边一截（正是模型名开头）看不见。纯 CSS 夹不住 —— 两个下拉的基准点不同。
   这里按实测矩形算需要平移多少，用 left/right 覆盖回来。 */
function clampDD(box) {
  const list = box.querySelector(".ddlist");
  if (!list) return;
  // 先清掉上次的补偿，否则会越算越偏
  list.style.left = "";
  list.style.right = "";
  const r = list.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const pad = 8;
  let shift = 0;
  if (r.left < pad) shift = pad - r.left;              // 左边出去了，往右推
  else if (r.right > vw - pad) shift = (vw - pad) - r.right;  // 右边出去了，往左拉
  if (!shift) return;
  // 用「相对当前的偏移」写回，弹层是 absolute 定位于按钮，负 left 即向左平移
  const baseLeft = r.left - (box.getBoundingClientRect().left);
  list.style.left = Math.round(baseLeft + shift) + "px";
  list.style.right = "auto";
}

function toggleDD(id) {
  const box = document.getElementById(id);
  if (!box) return;
  const wasOpen = box.classList.contains("open");
  closeDD();
  if (!wasOpen) {
    box.classList.add("open");
    clampDD(box);
  }
}

function closeDD() {
  document.querySelectorAll("#inputbar .dd.open").forEach((b) => b.classList.remove("open"));
}

// ---- 模型 / 强度选择的记忆 ----
// 按「工具」分开记，存 localStorage（和侧栏折叠、命令显示的偏好一致）。
// 为什么不全局记一份：claude 的模型 id 给 codex 会直接报错，
// 所以 key 里必须带工具名。
function prefKey(kind, tool) { return "opensession.pick." + kind + "." + tool; }

function prefGet(kind, tool) {
  try { return localStorage.getItem(prefKey(kind, tool)) || ""; } catch { return ""; }
}

function prefSet(kind, tool, value) {
  try {
    if (value) localStorage.setItem(prefKey(kind, tool), value);
    else localStorage.removeItem(prefKey(kind, tool));
  } catch {}
}

function pickDD(kind, value, label, el) {
  const tool = state.active && state.active.tool;
  if (kind === "model") state.selModel = value;
  else state.selEffort = value;
  if (tool) prefSet(kind, tool, value);
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

/* 丢掉前端与后端的双层缓存重取。指向 / 还原 agent 之后必须走这条路：
   后端有 10 分钟缓存，前端还缓存着一整份，只清一层都还是旧清单。
   重取后若输入栏正开着，立刻按新清单重画下拉。 */
async function gwRefreshModelCatalog() {
  state.modelCatalog = null;
  try {
    state.modelCatalog = await (await fetch("/api/models?force=1")).json();
  } catch { /* 拉不到就下次 ensure 时再试，不该挡住指向操作 */ }
  if (document.getElementById("inputbar") &&
      document.getElementById("inputbar").classList.contains("show")) {
    await fillEmbedSelectors();
  }
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

  /* 🔴 这里以前无条件把 selModel / selEffort 清成空。
     而 openSession() 每次重绘都会走到这儿（发完一条消息也会），
     于是「选好模型 → 发送 → 显示回默认」，看着就是「模型改不了」。
     现在按工具各记一份：同一工具内重绘保留，换了工具才换另一套。
     跨工具绝对不能串 —— 把 claude 的模型 id 塞给 codex，CLI 直接报错。 */
  if (state.selTool !== tool) {
    state.selTool = tool;
    state.selModel = prefGet("model", tool);
    state.selEffort = prefGet("effort", tool);
  }
  // 记录里可能留着一个已经下线 / 被删掉的模型，那就退回默认，别让下拉显示一个不存在的名字
  if (state.selModel && !models.some((m) => m.id === state.selModel)) state.selModel = "";
  if (state.selEffort && !efforts.includes(state.selEffort)) state.selEffort = "";

  const curM = models.find((m) => m.id === state.selModel);
  fillList(mlist, "model", [{ value: "", label: "默认", selected: !state.selModel }].concat(
    models.map((m) => ({ value: m.id, label: m.label || m.id, selected: m.id === state.selModel }))));
  fillList(elist, "effort", [{ value: "", label: "默认", selected: !state.selEffort }].concat(
    efforts.map((x) => ({ value: x, label: x, selected: x === state.selEffort }))));

  const mb = document.querySelector("#dd-model .ddbtn > span");
  const eb = document.querySelector("#dd-effort .ddbtn > span");
  if (mb) mb.textContent = curM ? (curM.label || curM.id) : "默认";
  if (eb) eb.textContent = state.selEffort || "默认";
  // 列表为空时必须能看出来「不是坏了，是这家没有可选清单」，
  // 否则下拉里只有「默认」一项，用户只会觉得控件失灵。
  const dd = document.getElementById("dd-model");
  if (dd) {
    dd.classList.toggle("nocat", models.length === 0);
    dd.title = models.length ? "" :
      "没有读到 " + tool + " 的模型清单，只能用默认模型。指向网关后这里会列全池子的模型。";
  }
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
  if (badge) badge.style.display = state.embedOpen ? "inline-flex" : "none";
  // 顶栏按钮已收进 ⋯ 菜单：改成 null 调用（不传按钮），文案由 barMenuAct 负责。
  // 这里仍保留按钮分支，是为兼容任何直接传按钮的旧调用点。
  if (btn) btn.textContent = state.embedOpen ? "✕ 关闭页面内会话" : "💻 页面内继续对话";
  syncInputBarClass();
  if (state.embedOpen) {
    fillEmbedSelectors();
    const ta = document.getElementById("embed-input");
    if (ta) ta.focus();
  }
}

/* body.has-input 标记「底部有输入栏」，供 CSS 把右下角的提问导航按钮往上顶，
   否则它会压在发送按钮上。输入栏是「打开状态 + 当前会话可嵌入」两个条件同时成立
   才真的存在，所以不能只看 state.embedOpen。 */
function syncInputBarClass() {
  const ib = document.getElementById("inputbar");
  document.body.classList.toggle("has-input", !!(ib && ib.classList.contains("show")));
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
/* 实时消息的骨架必须和 chat.js 的 msgHtml 完全一致（.who > .dot/.role/.time，
   正文是 .msg > .bubble）。结构一旦不同，跑完刷新成历史渲染时会跳一下。 */
function appendLiveMsg(role, text, cls) {
  const chat = document.getElementById("chat");
  if (!chat) return null;
  const div = document.createElement("div");
  div.className = "msg " + role + (cls ? " " + cls : "") + " live";
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, "0") + ":" +
    String(now.getMinutes()).padStart(2, "0");
  div.innerHTML = '<div class="who"><i class="dot"></i><b class="role">' +
    (role === "user" ? "用户" : "助手") + '</b><span class="time">' + hhmm +
    '</span><span class="tag">页面内</span></div><div class="bubble raw"></div>';
  const bubble = div.querySelector(".bubble");
  bubble.textContent = text;
  chat.appendChild(div);
  scrollChatBottom();
  return bubble;
}

/* 思考容器，懒建：只有真的收到 think 增量才插进来。
   这样 pi 这种拿不到思考明文的工具不会多出一个空的折叠框。
   返回可写入的 .tbody 元素。
   live 传当前累计正文：正文先到、思考后到的情况下不能清空气泡，
   否则那一段正文要等下一次 delta 才回来，中间是一片空白。 */
function ensureThinkBox(bubble, live) {
  const wrap = bubble && bubble.parentElement;
  if (!wrap) return null;
  let box = wrap.querySelector("details.think");
  if (box) return box.querySelector(".tbody");
  box = document.createElement("details");
  box.className = "think live";
  // 实时对话期间默认展开 —— 这是「正在对话时能看到思考」的核心；
  // 历史会话里是折叠的，两者行为不同是有意的。
  box.open = true;
  box.innerHTML = '<summary>💭 思考过程 <span class="tmeta"></span></summary>' +
    '<div class="tbody raw"></div>';
  wrap.insertBefore(box, bubble);
  // 用户手动点过就尊重他的选择，收尾时不再自动折叠
  box.addEventListener("click", () => { box.dataset.touched = "1"; }, { once: true });
  // 「思考中…」占位让位给真正的思考内容，避免两句叠在一起；已有正文就别动。
  if (!live) bubble.textContent = "";
  return box.querySelector(".tbody");
}

// 思考字数：和 chat.js 的 thinkHtml 保持同一套写法
function thinkSize(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k 字" : n + " 字";
}

/* 收尾：撤掉「进行中」的所有痕迹。卡片上的 live 类控制绿色边框，
   思考块的 live 类控制「· 进行中」标记。两者若不去掉，收尾后界面上
   还会一直显示「正在跑」，用户以为没结束。 */
function markSettled(bubble) {
  const wrap = bubble && bubble.parentElement;
  if (!wrap) return;
  wrap.classList.remove("live");
  const box = wrap.querySelector("details.think");
  if (box) box.classList.remove("live");
}

/* 流结束后把思考块定型：转 Markdown（与正文渲染一致），并收起成一行摘要。
   流式期间是纯文本 + 展开，因为边打字边解析会闪；收尾一次成型最稳。 */
function settleThink(bubble, think) {
  const wrap = bubble && bubble.parentElement;
  const box = wrap && wrap.querySelector("details.think");
  if (!box) return;
  box.classList.remove("live");   // 撤掉「进行中」标记与呼吸动画
  const tb = box.querySelector(".tbody");
  const meta = box.querySelector(".tmeta");
  if (tb && think) {
    if (state.mdOff) { tb.className = "tbody raw"; tb.textContent = think; }
    else { tb.className = "tbody"; tb.innerHTML = mdToHtml(think); }
  }
  if (meta) meta.textContent = think ? thinkSize(think.length) : "";
  // 用户手动展开/收起过就不动它
  if (!box.dataset.touched) box.open = false;
}

/* 跑一条 /api/embed 的 SSE 流，把增量写进 bubble。
   返回 { live, think, created, errs }：live 是累计正文，think 是累计思考，
   created 是新建会话成功后后端回的 { tool, id, file }（恢复模式恒为 null），
   errs 是后端发过的错误文案（用于收尾叙述）。
   抽成函数是因为「页面内恢复」和「页面内新建」走的是同一条流，
   差别只在于消息发送前/后怎么处理，不必复制一遍 reader 循环。 */
async function runEmbedStream(body, bubble, onCreated) {
  let live = "", think = "", created = null;
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
      } else if (o.t === "think") {
        think += o.s;
        if (bubble && bubble.isConnected) {
          const tb = ensureThinkBox(bubble, live);
          if (tb) {
            tb.textContent = think;
            // 滚思考块内部，而不是把整页滚到思考末尾 —— 否则正文会被顶出视野
            tb.scrollTop = tb.scrollHeight;
            const meta = tb.parentElement && tb.parentElement.querySelector(".tmeta");
            if (meta) meta.textContent = thinkSize(think.length);
            scrollChatBottom();
          }
        }
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
  settleThink(bubble, think);
  return { live, think, created, errs };
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
  if (!text) return;
  // 没有 active 说明当前是「新建草稿」这类过渡视图，没有可恢复的目标。
  // 以前这里静默 return —— 用户按了回车、什么都没发生、也没提示，
  // 看起来就是「输入消息报错」。现在明确告诉他为什么没发出去。
  if (!state.active) {
    toast("当前没有打开的会话，先点左侧列表选一个，或等新建跑完");
    return;
  }

  // 记下本次回复属于哪个会话：流跑完要重画，若此时用户已切到别的会话，
  // 就不能拿旧会话去 openSession，否则会把用户刚点开的会话顶掉。
  const owner = state.active;
  setEmbedBusy(true);
  closeDD();
  if (ta) ta.value = "";

  appendLiveMsg("user", text);
  const bubble = appendLiveMsg("assistant", "思考中…", "");

  let live = "", think = "";
  try {
    const r = await runEmbedStream({
      tool: owner.tool, id: owner.id, file: owner.file,
      cwd: owner.cwd, message: text,
      model: state.selModel, effort: state.selEffort,
    }, bubble);
    live = r.live;
    think = r.think || "";
  } catch (e) {
    if (!bubble || bubble.isConnected) appendLiveMsg("assistant", "⚠ 请求失败: " + e, "errmsg");
  }

  // 收尾收拾：只有思考、没有正文时（模型想了但没答），把空正文气泡摘掉，
  // 保留思考块；两者都没有才把整张卡片删掉。
  if (bubble && bubble.isConnected) {
    markSettled(bubble);
    if (think && !live) bubble.remove();
    else if (!live && !think) {
      const wrap = bubble.parentElement;
      if (wrap) wrap.remove();
    }
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
        '<span id="livebadge" style="display:inline-flex">新建会话中</span></div>' +
      '<div class="cmd">' + esc("页面内新建 · " + (draft.tool || "")) +
      " · 首条消息跑完后自动切换</div></div></div>";
  $("#main").innerHTML = bar + '<div id="chat"></div>';
  appendLiveMsg("user", draft.message);
}

async function createInPage({ tool, cwd, message }) {
  state.creating = true;
  appendNewChat({ tool, cwd, message });
  const bubble = appendLiveMsg("assistant", "思考中…", "");
  let live = "", think = "", created = null, failed = "";

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
      think = r.think || "";
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

  // 只有思考没有正文时也要留着（模型想过但没答），只摘掉空正文气泡
  if (bubble && bubble.isConnected) markSettled(bubble);
  if (!live && think && bubble && bubble.isConnected) bubble.remove();
  else if (!live && !think && bubble) {
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

