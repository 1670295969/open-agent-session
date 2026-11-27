/* 入口：装配各模块并启动 */
"use strict";

// ---- 左侧列表折叠 ----
// 折叠状态挂在 <html> 上（不是 body、也不是 #side）：
// #side 折叠后会被推出视口，但 #main 的内容是反复整体重绘的，
// 状态类只能放在比它们都高的节点上，重绘才不会把状态冲掉。
const SIDE_KEY = "opensession.sideCollapsed";
// 工具调用的显示偏好：默认隐藏（1），用户点开过「⚙ 命令」就记住显示（0）
const TOOL_KEY = "opensession.toolOff";

function applySideCollapsed(on, save) {
  state.sideCollapsed = !!on;
  document.documentElement.classList.toggle("side-collapsed", !!on);
  if (save) {
    try { localStorage.setItem(SIDE_KEY, on ? "1" : "0"); } catch {}
  }
}

function toggleSide() {
  applySideCollapsed(!state.sideCollapsed, true);
}

// ---- 手机档：列表 / 正文 两屏切换 ----
// 桌面上 #side 和 #main 并排；手机屏放不下两个，改成 #main 覆盖整屏滑入。
// 状态挂在 <html>.m-view：和 side-collapsed 同样的理由，正文会整体重绘，
// 状态类必须放在比它高的节点上。
// 只切 class，具体表现交给 CSS 的 @media (max-width:640px)，桌面端完全不受影响。
function isPhone() {
  return window.matchMedia("(max-width: 640px)").matches;
}

function applyMobileView(on) {
  document.documentElement.classList.toggle("m-view", !!on);
}

// 手机档返回列表；桌面档等价于「收起侧栏」，没有意义，直接忽略
function backToList() {
  if (!isPhone()) return;
  applyMobileView(false);
}

// ---- 手机档：筛选区折叠 ----
// 手机上「统计 + 工具 chip + 时间 chip」是三层，合计近 200px，列表被挤到只剩两三条。
// 折叠后只留一行按钮，按钮里带当前条件摘要，收起也知道列表为什么少。
// 状态挂 <html>.f-open（和 m-view 同理：正文/列表反复重绘，状态类必须放更高层）。
// 桌面档 #fbtn 恒为 display:none，且所有隐藏规则都在 640px 的媒体查询里，
// 所以桌面端加了这套东西以后布局零变化。
function toggleFilters() {
  state.filtersOpen = !state.filtersOpen;
  document.documentElement.classList.toggle("f-open", state.filtersOpen);
  const btn = $("#fbtn");
  if (btn) btn.setAttribute("aria-expanded", state.filtersOpen ? "true" : "false");
}

// 把当前筛选条件写进按钮摘要。收起状态靠它传达信息，展开时是个快捷回显。
function updateFilterBtn() {
  const btn = $("#fbtn");
  if (!btn) return;
  const parts = [];
  const tool = state.typeFilter && state.typeFilter !== "all"
    ? (TOOL_LABELS[state.typeFilter] || state.typeFilter) : "";
  if (tool) parts.push(tool);
  if (state.timeFilter) parts.push(state.timeFilter === 1 ? "今天" : state.timeFilter + " 天");
  const q = ($("#search") && $("#search").value || "").trim();
  if (q) parts.push("“" + (q.length > 8 ? q.slice(0, 8) + "…" : q) + "”");
  const sum = $("#fbtsum");
  if (sum) sum.textContent = parts.length ? parts.join(" · ") : "全部";
  // 摘要非默认（有筛选/有搜索）→ 按钮描边高亮，提示「列表被筛过」
  btn.classList.toggle("on", parts.length > 0);
}

function initMobile() {
  // 手机上先看列表（不记忆偏好：每次进来都是列表更符合预期）
  applyMobileView(false);
  // 筛选区默认收起：手机上它占的高度比列表还多，谁要找筛选会主动点。
  // 桌面档这段状态无害（CSS 忽略），但不影响用户，也不写 localStorage。
  state.filtersOpen = false;
  document.documentElement.classList.remove("f-open");
  // 跨档位缩放时的两种方向都要处理，只做一边会留下视觉 bug：
  //   ① 手机 → 桌面：必须清掉 m-view，否则 #main 的 translateX(0) 残留，
  //      但桌面档 CSS 不覆盖 position:fixed，正文会盖在列表上。
  //   ② 桌面 → 手机：CSS 立刻把 #main 推到屏外，若 m-view 还是 false，
  //      用户看到的是「点了会话正文不见了」（实测 mainLeft=390）。
  //      这里回落到列表态，让用户重新点一次，行为可预期。
  //   ③ 手机档内部换设备（390→414）：保持当前状态不动，别把用户正在读的正文弹掉。
  const mq = window.matchMedia("(max-width: 640px)");
  let wasPhone = mq.matches;
  const onChange = (e) => {
    if (!mq.matches) {
      applyMobileView(false);          // 变宽：一定是并排布局
    } else if (!wasPhone) {
      applyMobileView(false);          // 刚变窄：回到列表，避免正文凭空消失
    }
    wasPhone = mq.matches;
  };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange); // Safari < 14
  // Esc 也能退出正文（有键盘的平板 / 外接键盘时）
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPhone() && document.documentElement.classList.contains("m-view")) {
      applyMobileView(false);
    }
  });
}

function initSide() {
  let saved = null;
  try { saved = localStorage.getItem(SIDE_KEY); } catch {}
  applySideCollapsed(saved === "1", false);
  // Ctrl+B 切换（与多数编辑器/浏览器的侧栏习惯一致）
  // Ctrl+K 聚焦搜索框（浏览器的 Ctrl+K 是「搜索地址栏」，这里覆盖掉更顺手）
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
        (e.key === "b" || e.key === "B")) {
      // 焦点在输入框/文本域里时不劫持，避免影响正常输入
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) return;
      e.preventDefault();
      toggleSide();
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey &&
        (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      // 侧栏折叠时先展开，否则搜索框在屏幕外，聚焦了也看不见
      if (state.sideCollapsed) applySideCollapsed(false, true);
      const el = $("#search");
      if (el) { el.focus(); el.select(); }
    }
  });
}

// 支持从 URL 预置筛选（opensession-open --tool=xx / --q=xx 时用）
//   ?tool=claude&q=关键字
function applyUrlPrefs() {
  let p;
  try { p = new URLSearchParams(location.search); } catch { return; }
  const tool = p.get("tool");
  const q = p.get("q");
  if (tool && ["codex", "claude", "pi", "dsh", "hermes"].includes(tool)) {
    state.typeFilter = tool;
    document.querySelectorAll(".tchip[data-t]").forEach((x) => x.classList.remove("on"));
    const chip = document.querySelector('.tchip[data-t="' + tool + '"]');
    if (chip) chip.classList.add("on");
  }
  if (q) {
    const el = $("#search");
    if (el) el.value = q;
    // 启动参数可以带 --full=关键词 直接进全文模式（不加则按标题过滤，保持原行为）
    if (p.get("full") === "1") {
      state.searchMode = "full";
      const btn = $("#smode");
      if (btn) { btn.textContent = "全文"; btn.classList.add("on"); }
      const inp = $("#search");
      if (inp) inp.placeholder = "搜索正文 / 思考内容…（回车立即搜）";
      if (q) setTimeout(runFullSearch, 300);
    }
  }
  // 折叠状态也可由启动参数强制指定：--noside
  if (p.get("side") === "0") applySideCollapsed(true, true);
}

// 读运行环境信息（平台名 / 回收站位置）。失败不阻塞主流程——
// 拿不到就退回 Linux 文案，反正删除本身由后端决定，与提示措辞无关。
function loadEnv() {
  return fetch("/api/trash")
    .then((r) => r.json())
    .then((j) => {
      state.platform = {
        name: j.platform || "",
        isWin: !!j.isWin,
        // isMac 必须一起存：漏了它 del.js 里「废纸篓」的分支永远走不到，
        // macOS 用户会看到 Linux 的 ~/.local/share/Trash 文案（后端一直在返回这个字段）
        isMac: !!j.isMac,
        trashDir: j.dir || "",
      };
    })
    .catch(() => {});
}

function initToolPref() {
  try {
    const v = localStorage.getItem(TOOL_KEY);
    // 默认隐藏（toolOff=true）。只有明确存过 "0" 才显示。
    if (v === "0") state.toolOff = false;
  } catch {}
}

function boot() {
  initSide();
  initMobile();
  initToolPref();
  applyUrlPrefs();
  loadEnv();
  bindSearch();
  bindTypeChips();
  bindNewModal();
  loadSessions().catch((e) => {
    console.error(e);
    toast("加载会话列表失败: " + e);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
