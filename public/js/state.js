/* 全局状态与通用小工具（最先加载） */
"use strict";

// ---- 全局状态 ----
const state = {
  sessions: [],      // 全部会话
  active: null,      // 当前打开会话
  typeFilter: "all", // all | codex | claude | pi | hermes
  listPage: 0,       // 列表分页页码（统一全类分页）
  msgPage: 0,        // 消息分页页码
  msgs: null,        // 当前会话消息
  embedBusy: false,
  embedOpen: false,
  creating: false,   // 页面内新建会话是否在进行中（并发创建会互相覆盖界面）
  modelCatalog: null,
  selModel: "",
  selEffort: "",
  selectMode: false, // 多选删除模式
  selected: new Set(), // 已勾选的 file 集合
  mdOff: false,      // 正文是否关闭 Markdown 渲染（退回纯文本）
  // 运行环境信息（后端 /api/trash 返回）：回收站路径与平台名，
  // 删除提示文案、路径缩短都按它走，避免把 Linux 的 ~/.local/share/Trash
  // 写死在页面里给 Windows 用户看
  platform: { name: "", isWin: false, isMac: false, trashDir: "" },
};

const LIST_PAGE_SIZE = 25;
const MSG_PAGE_SIZE = 100;

const $ = (s) => document.querySelector(s);

// ---- 通用格式化 ----
function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString("zh-CN") + " " +
    d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function fmtSize(b) {
  return b > 1048576 ? (b / 1048576).toFixed(1) + "MB" : Math.ceil(b / 1024) + "KB";
}

// 命令提示符：zsh/bash 用 `$`，Windows 用 `>`（与各自 shell 一致；zsh 也认 `$`）
function cmdPrompt() {
  return (state.platform && state.platform.isWin) ? ">" : "$";
}

// 工作目录缩写：把家目录压成 ~
//   Linux   /home/xxx
//   macOS   /Users/xxx
//   Windows C:\Users\xxx（只对这类路径做反斜杠归一，避免误改 Linux 上
//           文件名里合法出现的反斜杠）
function shortCwd(c) {
  const s = String(c || "");
  if (/^[A-Za-z]:\\/.test(s) || /^\\\\/.test(s)) {
    return s.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "~").replace(/\\/g, "/");
  }
  return s
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^\/Users\/[^/]+/, "~");
}
