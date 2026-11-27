/* 左侧会话列表：筛选、统一分页、分组渲染 */
"use strict";

const TOOL_LABELS = { codex: "Codex", claude: "Claude", pi: "Pi", dsh: "DeepSeek", hermes: "Hermes" };

function filteredSessions() {
  let set = state.sessions;
  if (state.typeFilter !== "all") set = set.filter((s) => s.tool === state.typeFilter);
  // 时间筛选：按 mtime 落在最近 N 天内。0 = 不限。
  if (state.timeFilter) {
    const since = Date.now() - state.timeFilter * 86400000;
    set = set.filter((s) => s.mtime >= since);
  }
  const q = ($("#search").value || "").toLowerCase().trim();
  if (q) {
    set = set.filter((s) =>
      String(s.title || "").toLowerCase().includes(q) ||
      String(s.cwd || "").toLowerCase().includes(q));
  }
  return set;
}

function itemEl(s, withBadge) {
  const div = document.createElement("div");
  const picked = state.selected && state.selected.has(s.file);
  div.className = "item" +
    (state.active && state.active.file === s.file ? " active" : "") +
    (state.selectMode ? " selecting" : "") +
    (picked ? " picked" : "");
  const badge = withBadge
    ? '<span class="badge b-' + s.tool + '">' + esc(TOOL_LABELS[s.tool] || s.tool) + '</span>'
    : "";
  // 空会话（只有元数据、没有对话正文）单独标一下，避免点开一片空白莫名其妙
  const emptyTag = s.empty
    ? '<span class="badge empty" title="该会话文件只有元数据，没有对话正文">空</span>'
    : "";

  // 多选模式下左侧显示勾选框，否则悬停显示删除按钮
  const check = state.selectMode
    ? '<span class="chk' + (picked ? " on" : "") + '"></span>'
    : "";

  div.innerHTML =
    check +
    '<div class="body">' +
      '<div class="title">' + esc(s.title) + '</div>' +
      '<div class="meta">' + badge + emptyTag +
        '<span>' + fmtTime(s.mtime) + '</span>' +
        '<span>' + fmtSize(s.size) + '</span>' +
        '<span title="' + escAttr(s.cwd) + '">' + esc(shortCwd(s.cwd)) + '</span>' +
      '</div>' +
    '</div>';

  // 删除按钮用 DOM API 绑定，不走内联 onclick——
  // 会话路径可能含中文、括号、单引号，拼进属性里容易把 onclick 打断
  if (!state.selectMode) {
    const btn = document.createElement("button");
    btn.className = "delbtn";
    btn.title = "移入回收站";
    btn.innerHTML = trashIcon();
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      askDelete(s.file);
    });
    div.appendChild(btn);
  }

  div.onclick = (ev) => onItemTap(s, ev);
  return div;
}


function renderList() {
  // 手机档「筛选」按钮上的条件摘要跟着列表一起更新：
  // 类型 / 时间 / 搜索词都只影响列表，挂在这里一次覆盖三条路径，
  // 不用在每个 setTypeFilter / bindTimeChips / 搜索回调里各补一行（漏一个就不同步）。
  if (typeof updateFilterBtn === "function") updateFilterBtn();
  // 全文搜索模式：列表位置交给搜索结果渲染。
  // 这里必须早返回 —— 否则下面会把搜索结果整片换成普通会话列表，
  // 用户搜完看到的还是全量列表，等于搜索没生效。
  if (state.searchMode === "full" && ($("#search").value || "").trim()) {
    renderSearchResults();
    return;
  }

  const set = filteredSessions();
  const totalPages = Math.max(1, Math.ceil(set.length / LIST_PAGE_SIZE));
  if (state.listPage >= totalPages) state.listPage = totalPages - 1;
  if (state.listPage < 0) state.listPage = 0;

  const pageItems = set.slice(state.listPage * LIST_PAGE_SIZE, (state.listPage + 1) * LIST_PAGE_SIZE);
  const list = $("#list");
  list.innerHTML = "";

  const flat = state.typeFilter !== "all" || ($("#search").value || "").trim();
  if (flat) {
    // 单类型 / 搜索：平铺，带徽标
    for (const s of pageItems) list.appendChild(itemEl(s, true));
  } else {
    // 「全部」视图：页内按工具分组，分页统一由底部全类分页器控制
    for (const tool of ["codex", "claude", "pi", "dsh", "hermes"]) {
      const items = pageItems.filter((s) => s.tool === tool);
      if (!items.length) continue;
      const gh = document.createElement("div");
      gh.className = "ghead";
      gh.innerHTML = '<span class="badge b-' + tool + '">' + TOOL_LABELS[tool] + '</span>' +
        '<span class="gcount">' + items.length + ' 个</span>';
      list.appendChild(gh);
      for (const s of items) list.appendChild(itemEl(s, false));
    }
  }

  if (!list.children.length) {
    list.innerHTML = '<div style="padding:20px;color:var(--dim);font-size:12px">无匹配会话</div>';
  }
  renderListPager(totalPages, set.length);
}

function renderListPager(totalPages, total) {
  const pager = $("#listpager");
  if (!pager) return;
  if (totalPages <= 1) { pager.innerHTML = ""; return; }
  pager.innerHTML =
    '<button onclick="gotoListPage(-1)"' + (state.listPage <= 0 ? " disabled" : "") + '>←</button>' +
    '<span>第 <span class="cur">' + (state.listPage + 1) + '</span> / ' + totalPages +
      ' 页 · 共 ' + total + ' 个</span>' +
    '<button onclick="gotoListPage(1)"' +
      (state.listPage >= totalPages - 1 ? " disabled" : "") + '>→</button>';
}

function gotoListPage(delta) {
  state.listPage += delta;
  if (state.listPage < 0) state.listPage = 0;
  renderList();
  const list = $("#list");
  if (list) list.scrollTop = 0;
}

function setTypeFilter(tool) {
  // 兜底：dataset.t 缺失时不要写进 state —— undefined 会让后面所有筛选都匹配不上，
  // 页面表现为「列表整片变空」，很难和别的 bug 区分。
  if (!tool) return;
  state.typeFilter = tool;
  state.listPage = 0;
  document.querySelectorAll(".tchip[data-t]").forEach((x) => x.classList.remove("on"));
  const chip = document.querySelector('.tchip[data-t="' + tool + '"]');
  if (chip) chip.classList.add("on");
  // 全文模式下类型是后端过滤条件，切 chip 要重搜
  if (state.searchMode === "full" && ($("#search").value || "").trim()) runFullSearch();
  else renderList();
}

async function loadSessions() {
  const r = await fetch("/api/sessions?force=1");
  state.sessions = await r.json();
  state.listPage = 0;
  renderList();
  updateStats();
}

// 刷新按钮：列表 + 当前打开的会话正文一起重取
async function refreshAll(btn) {
  if (btn) { btn.classList.add("spin"); btn.disabled = true; }
  const prev = state.active;
  try {
    await loadSessions();
    if (prev) {
      // 会话可能已被外部删除
      const still = state.sessions.find((s) => s.file === prev.file);
      if (still) await openSession(still);
      else {
        state.active = null; state.msgs = null;
        $("#main").innerHTML = '<div id="empty"><div class="empty-emoji">🗂️</div>' +
          "该会话已不存在（可能被外部删除）</div>";
        renderList();
      }
    }
    toast("已刷新 · " + state.sessions.length + " 个会话");
  } catch (e) {
    toast("刷新失败: " + e);
  } finally {
    if (btn) { btn.classList.remove("spin"); btn.disabled = false; }
  }
}

function updateStats() {
  const c = { codex: 0, claude: 0, pi: 0, dsh: 0, hermes: 0 };
  for (const s of state.sessions) c[s.tool] = (c[s.tool] || 0) + 1;
  const el = $("#stats");
  if (!el) return;
  // 用独立的 .st 元素而不是拼字符串：拼接的整串在窄侧栏里会从任意字间断开，
  // 「Hermes 23」会被拆到第二行独自占位。flex + nowrap 保证每项整体换行。
  const parts = [
    ["Codex", c.codex], ["Claude", c.claude], ["Pi", c.pi],
    ["DeepSeek", c.dsh], ["Hermes", c.hermes],
  ];
  el.innerHTML = parts.map(([name, n]) =>
    '<span class="st">' + esc(name) + ' <b>' + n + "</b></span>").join("");
}

function bindSearch() {
  bindSearchMode();
  bindTimeChips();
}

// 时间筛选 chip
function bindTimeChips() {
  document.querySelectorAll("#timebar .tchip").forEach((ch) => {
    ch.onclick = () => {
      state.timeFilter = Number(ch.dataset.d) || 0;
      document.querySelectorAll("#timebar .tchip").forEach((x) => x.classList.remove("on"));
      ch.classList.add("on");
      state.listPage = 0;
      // 全文模式下时间条件由后端过滤，必须重搜一次
      if (state.searchMode === "full" && ($("#search").value || "").trim()) runFullSearch();
      else renderList();
    };
  });
}

function bindTypeChips() {
  // 🔴 必须带 [data-t]：页面上有两组 .tchip（工具筛选 #typebar + 时间筛选 #timebar），
  // 用裸 `.tchip` 会把时间 chip 一起绑上，点击时 dataset.t 是 undefined，
  // state.typeFilter 被写成 undefined → filteredSessions 一个都不匹配，
  // 列表整片变空（连「回标题模式」都救不回来）。这个 bug 表现是「列表突然全空」，
  // 但根因在这里，不在筛选逻辑。
  document.querySelectorAll(".tchip[data-t]").forEach((ch) => {
    ch.onclick = () => setTypeFilter(ch.dataset.t);
  });
}
