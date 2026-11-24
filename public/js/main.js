/* 入口：装配各模块并启动 */
"use strict";

// ---- 左侧列表折叠 ----
// 折叠状态挂在 <html> 上（不是 body、也不是 #side）：
// #side 折叠后会被推出视口，但 #main 的内容是反复整体重绘的，
// 状态类只能放在比它们都高的节点上，重绘才不会把状态冲掉。
const SIDE_KEY = "opensession.sideCollapsed";

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

function boot() {
  initSide();
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
