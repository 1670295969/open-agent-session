/* 入口：装配各模块并启动 */
"use strict";

// 支持从 URL 预置筛选（asry-open --tool=xx / --q=xx 时用）
//   ?tool=claude&q=关键字
function applyUrlPrefs() {
  let p;
  try { p = new URLSearchParams(location.search); } catch { return; }
  const tool = p.get("tool");
  const q = p.get("q");
  if (tool && ["codex", "claude", "pi", "hermes"].includes(tool)) {
    state.typeFilter = tool;
    document.querySelectorAll(".tchip").forEach((x) => x.classList.remove("on"));
    const chip = document.querySelector('.tchip[data-t="' + tool + '"]');
    if (chip) chip.classList.add("on");
  }
  if (q) {
    const el = $("#search");
    if (el) el.value = q;
  }
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
