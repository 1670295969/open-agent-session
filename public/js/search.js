/* 全文搜索：跨会话搜正文与思考内容，结果里直接带上下文片段
 *
 * 两种模式：
 *   标题（默认）—— 只在已加载的列表里匹配标题 / cwd，纯前端、即时、零请求
 *   全文       —— 走后端 /api/search，解析全部会话文件，搜正文 + 思考
 *
 * 为什么默认是标题：全文要读 180MB 会话文件（实测首次 3.5s，之后走缓存 15ms），
 * 每敲一个字符就触发一次会让输入变卡。切成全文后走 320ms 防抖 + 请求序号丢过期响应。
 */
"use strict";

const SEARCH_DEBOUNCE_MS = 320;

function toggleSearchMode() {
  state.searchMode = state.searchMode === "title" ? "full" : "title";
  const btn = $("#smode");
  const inp = $("#search");
  const full = state.searchMode === "full";
  if (btn) {
    btn.textContent = full ? "全文" : "标题";
    btn.classList.toggle("on", full);
    btn.title = full
      ? "当前搜索消息正文与思考内容，点一下回到只搜标题"
      : "当前只搜标题与路径，点一下改为搜正文与思考";
  }
  if (inp) {
    inp.placeholder = full
      ? "搜索正文 / 思考内容…（回车立即搜）"
      : "搜索标题 / 项目路径…（Ctrl+K）";
  }
  state.listPage = 0;
  // 切模式后立刻按新模式重算，否则要等下一次输入才有反应
  if (full) {
    if ((inp && inp.value || "").trim()) runFullSearch();
    else { state.searchRes = null; renderList(); }
  } else {
    state.searchRes = null;
    renderList();
  }
}

// 触发全文搜索（防抖）。空关键词直接清空结果回到普通列表。
function scheduleSearch() {
  const q = ($("#search").value || "").trim();
  clearTimeout(state.searchTimer);
  if (!q) {
    state.searchRes = null;
    state.searchBusy = false;
    state.searchSeq++;      // 让在飞的请求作废，否则它回来会覆盖成有结果
    renderList();
    return;
  }
  state.searchTimer = setTimeout(runFullSearch, SEARCH_DEBOUNCE_MS);
}

async function runFullSearch() {
  const q = ($("#search").value || "").trim();
  if (!q) { state.searchRes = null; renderList(); return; }

  const seq = ++state.searchSeq;
  state.searchBusy = true;
  renderList();   // 先画出「搜索中…」，别让用户以为没反应
  let j;
  try {
    const since = state.timeFilter
      ? Date.now() - state.timeFilter * 86400000 : 0;
    // tool 必须是有效值：state.typeFilter 万一被污染成 undefined，拼进 URL 就是
    // 字面量 "undefined"，后端按工具过滤会把所有会话滤掉（表现为「搜什么都没结果」）。
    const tool = state.typeFilter || "all";
    const url = "/api/search?q=" + encodeURIComponent(q) +
      "&tool=" + encodeURIComponent(tool) +
      "&since=" + since;
    j = await (await fetch(url)).json();
  } catch (e) {
    if (seq !== state.searchSeq) return;
    state.searchBusy = false;
    state.searchRes = { q, error: String(e), results: [], total: 0, took: 0 };
    renderList();
    return;
  }
  if (seq !== state.searchSeq) return;   // 期间用户又改了关键词，这次结果作废
  state.searchBusy = false;
  state.searchRes = (j && Array.isArray(j.results))
    ? j : { q, error: (j && j.error) || "搜索失败", results: [], total: 0, took: 0 };
  state.listPage = 0;
  renderList();
}

/* 命中片段：后端给的是 {pre, hit, post} 三段**纯文本**，
   这里先 esc 再拼 <mark>，会话内容里的尖括号永远进不了标签位置。
   片段的来源（正文 / 思考 / 命令）补一个小标签 —— 否则搜到「命令」里的命中时，
   用户看着一段脚本片段会以为那是助手说的话。 */
function snippetHtml(h) {
  const tag = h.fieldLabel
    ? '<span class="sfl">' + esc(h.fieldLabel) + '</span>' : "";
  return '<div class="snippet">' + tag + esc(h.pre) +
    '<mark>' + esc(h.hit) + '</mark>' + esc(h.post) + '</div>';
}

function searchItemEl(r) {
  const div = document.createElement("div");
  div.className = "sitem" +
    (state.active && state.active.file === r.file ? " active" : "");
  const tag = r.tool === "dsh" ? "DeepSeek" : (TOOL_LABELS[r.tool] || r.tool);

  const head = '<div class="stitle">' +
      '<span class="badge b-' + escAttr(r.tool) + '">' + esc(tag) + '</span>' +
      '<span class="stxt">' + esc(r.title || "(无标题)") + '</span>' +
      '<span class="scount">' + r.count + ' 处</span>' +
    '</div>' +
    '<div class="smeta">' + esc(fmtTime(r.mtime)) +
      ' · ' + esc(shortCwd(r.cwd || "")) + '</div>';

  const hits = r.hits.map((h, k) =>
    '<div class="shit' + (h.role === "user" ? " huser" : "") +
      (h.field === "tool" ? " htool" : "") + '" data-k="' + k + '">' +
      snippetHtml(h) +
    '</div>').join("");

  div.innerHTML = head + '<div class="shits">' + hits + '</div>';

  // 点任意片段：打开该会话并滚动到那条消息；点容器其余位置只打开会话
  div.querySelectorAll(".shit").forEach((el, k) => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openHit(r, r.hits[k]);
    });
  });
  div.addEventListener("click", () => openHit(r, r.hits[0]));
  return div;
}

/* 打开命中所在的会话，并滚到那条消息。
   列表里的会话对象是「扫描摘要」，真实会话对象要从 state.sessions 里取，
   否则 openSession 拿到的 cwd / resumeCmd 可能缺失（搜索结果是另一个接口给的）。 */
async function openHit(r, hit) {
  const s = state.sessions.find((x) => x.file === r.file) || {
    tool: r.tool, id: r.id, file: r.file, cwd: r.cwd, title: r.title, mtime: r.mtime,
  };
  await openSession(s);
  if (!hit) return;
  // 正文渲染完才能定位；openSession 内部已 await 完 fetch，这里可以直接找
  highlightMsg(hit.i, hit.field);
}

/* 滚动到第 i 条消息并闪一下。
   给该消息临时加 .hitflash（CSS 动画 1.6s 后自然消失，不用手动清类）。
   命中折叠内容时必须先展开 —— 否则滚过去只看到一行摘要，用户以为没定位到：
     think 命中 → 展开思考块
     tool  命中 → 展开工具命令块 */
function highlightMsg(i, field) {
  let chat = $("#chat");
  if (!chat) return;
  // 命中 tool 字段就先把工具调用打开再渲染：隐藏状态下 details 根本不存在，
  // 光滚过去是一张没有命令的卡片，等于没定位到。同时覆盖两种情况 —
  // ① 这条消息只有命令（隐藏时整张卡片没渲染）② 有正文但命令块被摘掉了。
  if (field === "tool" && state.toolOff) {
    state.toolOff = false;
    try { localStorage.setItem("opensession.toolOff", "0"); } catch {}
    renderChat();
    // 🔴 重绘后 #chat 是新的节点，必须重新取 —— 拿旧引用会找到已脱离文档的元素，
    // scrollIntoView 无声无息什么都不做。
    chat = $("#chat");
    if (!chat) return;
    const btn = $("#toolbtn");
    if (btn) btn.classList.add("on");
  }
  const el = chat.querySelector('.msg[data-i="' + i + '"]');
  if (!el) { toast("消息已变化（会话被追加过），请点 ↻ 刷新后重试"); return; }
  // 其余折叠块（思考 / 命令）命中时展开那一条，否则只看到一行摘要
  if (field === "think") {
    const box = el.querySelector("details.think");
    if (box) box.open = true;
  } else if (field === "tool") {
    const box = el.querySelector("details.toolcall");
    if (box) box.open = true;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("hitflash");
  // 强制重排后再加，动画才会重新播放（连点同一处两次也能闪）
  void el.offsetWidth;
  el.classList.add("hitflash");
}

// 搜索结果视图（替换 #list 内容）。分页沿用左侧统一的 LIST_PAGE_SIZE。
function renderSearchResults() {
  const list = $("#list");
  const res = state.searchRes;
  list.innerHTML = "";

  if (state.searchBusy) {
    // 首次搜索要解析全部会话文件（实测 161 个会话、正文约 7MB，冷启动 2–4s，
    // 之后走缓存 10–20ms）。不给说明的话，用户只会看到一个静止的「搜索中…」，
    // 以为卡死了 —— 这里把「首次会慢、之后会快」直接讲清楚。
    list.innerHTML = '<div class="sstatus">搜索中…' +
      '<br><span class="dim">首次搜索需要解析全部会话文件（约 2–4 秒），' +
      '之后同样的关键词会走缓存，几十毫秒内返回。</span></div>';
    renderListPager(1, 0);
    return;
  }
  if (res && res.error) {
    list.innerHTML = '<div class="sstatus">搜索失败：' + esc(res.error) + '</div>';
    renderListPager(1, 0);
    return;
  }
  const rows = res ? res.results : [];
  if (!rows.length) {
    list.innerHTML = '<div class="sstatus">没有找到包含「' + esc((res && res.q) || "") +
      '」的内容<br><span class="dim">试试更短的关键词，或点右上角切回「标题」模式</span></div>';
    renderListPager(1, 0);
    return;
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / LIST_PAGE_SIZE));
  if (state.listPage >= totalPages) state.listPage = totalPages - 1;
  if (state.listPage < 0) state.listPage = 0;
  const pageItems = rows.slice(state.listPage * LIST_PAGE_SIZE,
    (state.listPage + 1) * LIST_PAGE_SIZE);
  for (const r of pageItems) list.appendChild(searchItemEl(r));

  const summary = document.createElement("div");
  summary.className = "ssummary";
  summary.textContent = "「" + res.q + "」命中 " + res.total + " 个会话 · " +
    res.took + "ms" + (res.truncated ? " · 结果已截断" : "");
  list.insertBefore(summary, list.firstChild);

  renderListPager(totalPages, rows.length);
}

function bindSearchMode() {
  const el = $("#search");
  if (!el) return;
  el.addEventListener("input", () => {
    if (state.searchMode === "full") { scheduleSearch(); return; }
    // 标题模式：切回普通列表（全文结果不应残留在屏幕上）
    if (state.searchRes) { state.searchRes = null; }
    state.listPage = 0;
    renderList();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && state.searchMode === "full") {
      e.preventDefault();
      clearTimeout(state.searchTimer);
      runFullSearch();
    }
    if (e.key === "Escape" && el.value) {
      el.value = "";
      state.searchRes = null;
      renderList();
    }
  });
}
