/* 右侧正文：打开会话、渲染消息、分页、顶部操作栏 */
"use strict";

async function openSession(s) {
  state.active = s;
  renderList();
  // 手机档：选中会话后把正文滑进来（桌面档 applyMobileView 无副作用，
  // 因为 CSS 只在 ≤640px 时才会让 #main 位移）
  if (isPhone()) applyMobileView(true);
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

/* 消息时间戳：同一天只显示 HH:MM，跨天补上 MM-DD。
   ⚠️ 不能叫 fmtTime —— state.js 已有同名函数（吃毫秒时间戳，列表在用），
   重名会把它整个覆盖掉，左侧列表的时间全变成一串数字。 */
function fmtMsgTime(t) {
  if (!t) return "";
  const s = String(t).replace("T", " ");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})/);
  if (!m) return s.slice(0, 16);
  const now = new Date();
  const today = +m[1] === now.getFullYear() &&
    +m[2] === now.getMonth() + 1 && +m[3] === now.getDate();
  return (today ? "" : m[2] + "-" + m[3] + " ") + m[4] + ":" + m[5];
}

/* 这条消息渲染出来会不会是一张空卡片。
   隐藏工具调用后，「只调了个工具、没说话」的消息会只剩一个角色行，白占一张卡片。
   实测全库 9546 条消息里 3915 条除工具调用外什么都没有 —— 不过滤就是 3915 张空卡。
   判断要和 msgHtml 里实际渲染的三个部分（text / think / tool）严格对齐，否则会误删有内容的行。 */
function msgEmpty(m) {
  if (!m) return true;
  if (m.text) return false;
  if (m.think) return false;
  if (m.tool && !state.toolOff) return false;
  return true;
}

/* 工具调用：默认整块不显示，顶栏「⚙ 命令」打开才铺出来。
   🔴 为什么默认隐藏：一次回答背后常挂着十几个 exec_command / write_stdin，
   实测全库 7319 条带工具调用的消息里 3915 条除了调用什么都没有，
   铺在正文里等于把答案淹了。打开后每条只显示一行摘要 chip，点开才看完整命令。 */
function toolHtml(m) {
  if (state.toolOff) return "";
  if (!m.tool) return "";
  const chip = '<span class="toolchip">⚙ ' + esc(m.tool) + "</span>";
  if (!Array.isArray(m.toolFull) || !m.toolFull.length) return chip;

  // 每个完整命令一块：名字 + 复制按钮 + 保留缩进的原文。
  // 只有 1 条时省掉块头里的函数名 —— summary 那行 chip 已经写了
  // `exec_command("…")`，展开后再顶一遍同名标题纯属重复占位。
  const blocks = m.toolFull.map((f, k) => {
    const title = m.toolFull.length > 1
      ? '<div class="tfhead"><b>' + esc(f.name) + '</b>'
          + '<span class="tfmeta">' + f.body.length + ' 字</span>'
          + '<button class="tfcopy" data-k="' + k + '" title="复制这段命令原文">⧉ 复制</button></div>'
      : '<div class="tfhead"><button class="tfcopy" data-k="' + k +
          '" title="复制这段命令原文">⧉ 复制命令</button></div>';
    return '<div class="tfblock">' + title +
      '<pre class="tfbody">' + esc(f.body) + '</pre></div>';
  }).join("");

  // 多个调用时 summary 里补个数量，否则展开后对不上「哪来的三条」
  const more = m.toolFull.length > 1
    ? '<span class="tfcount">展开 ' + m.toolFull.length + ' 条命令</span>' : "";
  return '<details class="toolcall">' +
      '<summary>' + chip + more + '</summary>' +
      '<div class="tfold">' + blocks + '</div>' +
    '</details>';
}

/* cont = 上一条也是助手，属于同一轮里的后续动作。
   助手一次回答常被拆成「一句话 + 一串工具调用」（实测某会话连续 5 条），
   每条都重印「助手 18:02:18」会糊成一片。cont 的消息不画角色行，
   只在组首标一次时间，读起来才像「一次回答里的几个步骤」。 */
function msgHtml(m, cont, end, idx) {
  const sc = m.sidechain ? " sidechain" : "";
  const role = m.role === "user" ? "用户" : "助手";
  const rawTime = m.time ? String(m.time).replace("T", " ") : "";
  const time = fmtMsgTime(m.time);
  const timeHtml = time
    ? '<span class="time" title="' + escAttr(rawTime) + '">' + esc(time) + "</span>" : "";
  const sideHtml = m.sidechain ? '<span class="tag">sidechain</span>' : "";
  // 正文走 Markdown 渲染（md.js），已是安全 HTML，不再 esc
  const body = m.text
    ? (state.mdOff ? '<div class="raw">' + esc(m.text) + "</div>" : mdToHtml(m.text))
    : "";
  const who = cont ? "" :
    '<div class="who"><i class="dot"></i><b class="role">' + role + "</b>" +
      timeHtml + sideHtml + "</div>";
  const cls = "msg " + m.role + sc + (cont ? " cont" : "") + (end ? " end" : "");
  // data-i 是消息序号：全文搜索命中后要按序号滚到那一条并高亮（search.js 用）
  const di = idx == null ? "" : ' data-i="' + idx + '"';
  // 悬停出现的复制按钮。用 DOM 绑定而不是内联 onclick：消息正文里可能带引号，
  // 拼进属性会把 onclick 打断（这个坑 escAttr 那节记过一次）。
  return '<div class="' + cls + '"' + di + ">" +
      '<button class="msgcopy" title="复制这条消息的原文">⧉</button>' +
      who + thinkHtml(m.think) +
      (body ? '<div class="bubble md">' + body + "</div>" : "") + toolHtml(m) +
    "</div>";
}

/* 会话规模摘要：消息数 + 时间跨度。
   放在 cwd 行里而不是新加一行 —— #bar 已经两行（cwd / 命令），
   再加一行会把固定栏压得很高，正文可见区域变小。
   时间跨度用「首次→末次」而不是「耗时」：中间可能隔了好几天没用，
   说耗时是错的，只有首末时间是真事实。
   隐藏工具调用时条数按**看得见的**算 —— 顶上写「139 条」而正文只有几十张卡片，
   用户会以为渲染漏了。原始条数放进 title，要核对时悬停即可。
   🔴 时间跨度仍用**全部**消息算：跨度描述的是「这段会话活跃了多久」，
   工具调用也是真实发生过的动作，按可见消息算会把首尾削掉。 */
function spanHtml(visible, all) {
  if (!visible.length) return "";
  const times = all.map((m) => m.time).filter(Boolean).sort();
  let span = "";
  if (times.length >= 2) {
    const a = new Date(String(times[0]).replace(" ", "T"));
    const b = new Date(String(times[times.length - 1]).replace(" ", "T"));
    const d = (b - a) / 1000;
    if (isFinite(d) && d > 0) {
      const fmt = (s) => s < 60 ? Math.round(s) + " 秒"
        : s < 3600 ? Math.round(s / 60) + " 分"
        : s < 86400 ? (s / 3600).toFixed(1) + " 小时"
        : (s / 86400).toFixed(1) + " 天";
      span = " · 跨 " + fmt(d);
    }
  }
  const hidden = all.length > visible.length
    ? "（全文共 " + all.length + " 条原始记录）" : "";
  return '<span class="cwdmeta" title="消息条数与首次到末次的时间跨度' + hidden + '">' +
    visible.length + " 条" + span + "</span>";
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
  // 连续助手消息归成一组：组内不重复画角色行，只在组首标一次。
  // 用户消息永远独立成块（问题本身就是一块，不跟上一轮混）。
  // 🔴 隐藏工具调用后，「只有工具调用、没有正文和思考」的消息会变成一张空卡片
  // （只剩角色行），必须先滤掉再算 cont/end —— 否则分组间距按不存在的消息走，
  // 正文之间会冒出莫名其妙的空白。data-i 仍用原始序号，搜索定位不能错位。
  const visible = [];
  for (let i = 0; i < msgs.length; i++) if (!msgEmpty(msgs[i])) visible.push({ m: msgs[i], i });
  const html = visible.map((it, k) => {
    const prev = visible[k - 1], next = visible[k + 1];
    const cont = !!prev && it.m.role === "assistant" && prev.m.role === "assistant";
    // 组尾：下一条不是助手了，这条才拿回正常的大间距，把轮次分开
    const end = !next || next.m.role !== "assistant" || !!next.m.sidechain;
    return msgHtml(it.m, cont, end, it.i);
  }).join("");

  // 工具调用条数：顶栏按钮上标个数字，隐藏时用户才知道「下面到底有没有东西」
  const toolN = msgs.reduce((n, m) => n + (m.tool ? 1 : 0), 0);
  // 全部消息都被滤掉（只有工具调用）时不能留白页 —— 说清楚为什么空、怎么切回去
  const onlyTools = !visible.length && toolN > 0
    ? '<div class="emptyhint">' +
        '<div class="eh-title">本会话只有工具调用</div>' +
        '<div class="eh-body">这段记录里没有用户提问和助手回复，只有 ' + toolN +
        ' 次工具调用（命令 / 读写文件）。<br>工具调用默认隐藏，点右上角 <b>⚙ 命令</b> 可以展开查看。' +
        '</div></div>'
    : "";
  const chat = '<div id="chat">' + html + (visible.length ? "" : onlyTools || emptyHint) + "</div>";

  const embedOn = state.embedOpen && isEmbeddable(s);
  const badge = isEmbeddable(s)
    ? '<span id="livebadge" style="display:' + (embedOn ? "inline-flex" : "none") + '">嵌入会话中</span>'
    : "";
  // 路径必须包一层可收缩的 span：#bar .cwd 是 flex 容器，直接放文本节点
  // 无法收缩，路径一长就把右侧的条数/跨度整个挤出可视区（overflow:hidden 吞掉）。
  // 同时做成可点的：点一下直接浏览这个目录（正文里的相对路径也靠它兜底，
  // 用户能先确认会话的工作目录到底是哪个）。
  // 手机档专用返回键：CSS 里默认 display:none，只有 ≤640px 且
  // html.m-view 时才显形，桌面和平板完全看不到这个按钮。
  // 放在 #bar 最前面，手指够得着的同时不打断既有按钮的换行节奏。
  // 🔴 顶栏按钮预算：这里每加一个按钮都要重新量一遍。
  // 2026-11-27 之前是 7 个常驻按钮（命令 / Markdown / 刷新 / 复制 / 导出 /
  // 页面内恢复 / 终端恢复），合计 697px —— 1024px 窗口下 info 只剩 256px，
  // 路径被截成 "/media/liu/source/download/0179..."，恢复命令也看不全，
  // 顶栏还被挤成 4 行（实测 112px 高）。
  // 现在只留「高频开关 + 主操作」，低频四项收进 ⋯ 菜单，按钮合计约 270px。
  const menu = [
    '<button data-act="reload" onclick="barMenuAct(\'reload\',this)">↻ 刷新本会话</button>',
    '<button data-act="copy" onclick="barMenuAct(\'copy\',this)">⧉ 复制恢复命令</button>',
    '<button data-act="export" onclick="barMenuAct(\'export\',this)">⤓ 导出 Markdown</button>',
    isEmbeddable(s)
      ? '<button data-act="embed" onclick="barMenuAct(\'embed\',this)">' +
          (embedOn ? "✕ 关闭页面内会话" : "💻 页面内继续对话") + '</button>' : "",
  ].join("");
  const bar = '<div id="bar">' +
      '<button id="backbtn" onclick="backToList()" title="返回会话列表">‹ 列表</button>' +
      '<div class="info">' +
      '<div class="cwd">' +
        '<a class="cwdpath" href="#" data-file="' + escAttr(s.cwd || "") + '"' +
          ' title="点击浏览这个目录：' + escAttr(s.cwd || "") + '">📁 ' +
          esc(s.cwd || "(未知目录)") + '</a>' +
        badge + spanHtml(visible.map((it) => it.m), msgs) + '</div>' +
      '<div class="cmd">' + cmdPrompt() + ' ' + esc(s.resumeCmd) + '</div></div>' +
      '<button id="toolbtn" class="' + (state.toolOff ? "" : "on") + '" onclick="toggleTools(this)" ' +
        'title="显示 / 隐藏正文里的工具调用（本会话共 ' + toolN + ' 条）">⚙ 命令' +
        (state.toolOff && toolN ? ' <span class="btnnum">' + (toolN > 99 ? "99+" : toolN) + '</span>' : "") +
        '</button>' +
      '<button id="mdbtn" class="' + (state.mdOff ? "" : "on") + '" onclick="toggleMd(this)" ' +
        'aria-label="Markdown 渲染开关" ' +
        'title="' + (state.mdOff ? "当前为纯文本，点击恢复 Markdown 渲染" : "当前渲染 Markdown，点击切为纯文本") +
        '">M↓<span class="btnlong"> Markdown</span></button>' +
      '<span class="bmwrap" id="bmwrap">' +
        '<button id="morebtn" onclick="barMenu(event)" aria-haspopup="true" aria-expanded="false" ' +
          'title="更多：刷新 / 复制命令 / 导出 / 页面内继续">⋯</button>' +
        '<div id="barmenu" role="menu">' + menu + '</div>' +
      '</span>' +
      '<button class="primary" id="resumebtn" onclick="doResume(this)" title="在终端里恢复这个会话">' +
        '▶<span class="btnhalf"> 恢复</span><span class="btnlong"> 终端恢复会话</span></button></div>';

  $("#main").innerHTML = bar + chat + (isEmbeddable(s) ? inputBarHtml(embedOn) : "");
  bindEmbedInput();
  syncInputBarClass();
  // 提问导航随会话内容重建：换会话 / 追加消息后，大纲里的条目必须跟着变，
  // 否则点进去会跳到已经不存在的序号。
  renderOutline();
  if (embedOn) {
    fillEmbedSelectors();
    const ta = $("#embed-input");
    if (ta) ta.focus();
  }
}

// ---- 单条消息复制 ----
// 用事件委托而不是给每个按钮绑 onclick：#chat 每次重绘都整体重建，
// 逐个绑会在长会话里挂上几百个监听，且重绘后旧引用全部泄漏。
document.addEventListener("click", (e) => {
  // 工具命令块的复制按钮：先判它，否则会被下面的 .msgcopy 逻辑当成整条消息复制
  const tc = e.target.closest(".tfcopy");
  if (tc) {
    e.stopPropagation();   // 别让点击冒泡到 <summary>，否则一复制就顺手折叠/展开
    e.preventDefault();
    const wrap = tc.closest(".msg");
    const i = wrap ? Number(wrap.dataset.i) : -1;
    const m = (state.msgs || [])[i];
    const k = Number(tc.dataset.k);
    const f = m && Array.isArray(m.toolFull) ? m.toolFull[k] : null;
    if (!f) return;
    copyText(f.body, "已复制命令原文");
    return;
  }
  const btn = e.target.closest(".msgcopy");
  if (!btn) return;
  e.stopPropagation();
  const wrap = btn.closest(".msg");
  const i = wrap ? Number(wrap.dataset.i) : -1;
  const m = (state.msgs || [])[i];
  if (!m) return;
  // 复制「原文」：正文 + 工具调用，不带思考（思考是旁注，混进去反而不好用）。
  // 想看思考就展开后手动选中。
  // 工具有完整命令时用原文而不是 chip 里那个 70 字摘要 —— 复制出去就是要能直接跑的。
  const parts = [];
  if (m.text) parts.push(m.text);
  if (Array.isArray(m.toolFull) && m.toolFull.length) {
    parts.push(m.toolFull.map((f) => "⚙ " + f.name + ":\n" + f.body).join("\n\n"));
  } else if (m.tool) {
    parts.push("⚙ " + m.tool);
  }
  const text = parts.join("\n\n");
  if (!text) { toast("这条消息只有思考内容，展开后可手动选中复制"); return; }
  copyText(text, "已复制这条消息");
});

// 复制并提示（剪贴板 API 不可用时自动退回 execCommand）
function copyText(text, okMsg) {
  if (!text) return;
  const done = () => toast(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

// 非安全上下文（http 且非 localhost）下 clipboard API 不可用，退回到 execCommand
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand("copy"); done(); } catch { toast("复制失败"); }
  ta.remove();
}

function scrollChatBottom() {
  const chat = $("#chat");
  if (chat) chat.scrollTop = chat.scrollHeight;
}

// ---- 工具调用开关 ----
// 默认隐藏：正文只看「人话」。想核对某一步执行了什么时点开。
// 偏好存 localStorage（和侧栏折叠一致），下次打开还是同一套读法。
function toggleTools(btn) {
  state.toolOff = !state.toolOff;
  if (btn) btn.classList.toggle("on", !state.toolOff);
  try { localStorage.setItem("opensession.toolOff", state.toolOff ? "1" : "0"); } catch {}
  renderChat();
  toast(state.toolOff ? "已隐藏工具调用" : "已显示工具调用");
}

// ---- 顶栏溢出菜单 ----
// 为什么要有：顶栏原来平铺 7 个按钮，1024px 下把路径和恢复命令挤成一条缝，
// 还撑成 4 行。刷新 / 复制命令 / 导出 / 页面内继续都是低频动作，
// 收进「⋯」既保住信息区宽度，也让「终端恢复」这个主操作更显眼。
function barMenu(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  const wrap = document.getElementById("bmwrap");
  if (!wrap) return;
  const open = !wrap.classList.contains("open");
  wrap.classList.toggle("open", open);
  const btn = document.getElementById("morebtn");
  if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) clampBarMenu();
}

// 菜单默认右对齐到「⋯」按钮（CSS right:0）。手机上「⋯」不在行末（后面还有终端恢复），
// 右对齐会让 178px 的菜单左侧探出视口（390px 实测 left=-22）。
// 所以只在**真的越界时**才修正，能贴着按钮就不动 —— 否则宽屏下菜单会飘到屏幕最右边，
// 跟「⋯」失去视觉联系。
function clampBarMenu() {
  const m = document.getElementById("barmenu");
  if (!m) return;
  const pad = 8;
  // 每次打开先清掉上次的修正，回到 CSS 的默认右对齐再量
  m.style.left = "";
  m.style.right = "";
  // 极窄屏（<=320）下 178px 也放不下时收窄，宁可折行也别出界
  m.style.maxWidth = window.innerWidth - pad * 2 + "px";
  let r = m.getBoundingClientRect();
  // ① 左边越界（手机档的典型情况）：整体右移到贴边
  if (r.left < pad) {
    m.style.left = pad - r.left + "px";
    m.style.right = "auto";
    r = m.getBoundingClientRect();
  }
  // ② 右边越界（按钮贴着视口右缘时可能出现）：整体左移到贴边
  if (r.right > window.innerWidth - pad) {
    m.style.left = "0px";
    m.style.right = "auto";
    const base = m.getBoundingClientRect().left;   // left:0 时的左边缘
    const target = window.innerWidth - pad - m.getBoundingClientRect().width;
    m.style.left = target - base + "px";
  }
}

function closeBarMenu() {
  const wrap = document.getElementById("bmwrap");
  if (wrap) wrap.classList.remove("open");
  const btn = document.getElementById("morebtn");
  if (btn) btn.setAttribute("aria-expanded", "false");
}

function barMenuAct(act, btn) {
  closeBarMenu();
  if (act === "reload") return reloadActive(btn);
  if (act === "copy") return copyCmd();
  if (act === "export") return doExport();
  if (act === "embed") {
    // 传 null：按钮文案由下面按状态改，交给 toggleEmbed 改会把菜单项文字写死
    toggleEmbed(null);
    if (btn) btn.textContent = state.embedOpen ? "✕ 关闭页面内会话" : "💻 页面内继续对话";
  }
}

// 点别处 / 按 Esc 收起菜单。#bar 每次重绘都会重建菜单，所以监听挂在 document 上，
// 用 closest 判断是否点在菜单内部（重绘后依然有效，不依赖元素引用）。
document.addEventListener("click", (e) => {
  if (!e.target.closest("#bmwrap")) closeBarMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeBarMenu();
});

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
