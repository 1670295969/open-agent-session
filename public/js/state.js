/* 全局状态与通用小工具（最先加载） */
"use strict";

// ---- 全局状态 ----
const state = {
  sessions: [],      // 全部会话
  active: null,      // 当前打开会话
  typeFilter: "all", // all | codex | claude | pi | dsh | hermes
  listPage: 0,       // 列表分页页码（统一全类分页）
  msgs: null,        // 当前会话消息
  embedBusy: false,
  embedOpen: false,
  creating: false,   // 页面内新建会话是否在进行中（并发创建会互相覆盖界面）
  modelCatalog: null,
  selModel: "",
  selEffort: "",
  // 上次填下拉时用的是哪个工具的清单。换了工具才重置选择，
  // 同一工具重绘（发完消息会重绘）必须保留 —— 否则选好模型一发就回默认。
  selTool: null,
  selectMode: false, // 多选删除模式
  selected: new Set(), // 已勾选的 file 集合
  mdOff: false,      // 正文是否关闭 Markdown 渲染（退回纯文本）
  // 工具调用（⚙ exec_command…）是否隐藏。默认隐藏：一次回答背后常有十几个
  // write_stdin / exec_command，铺在正文里把答案淹了。顶栏「⚙ 命令」可切回显示。
  toolOff: true,
  sideCollapsed: false, // 左侧列表是否折叠（localStorage 记住偏好）
  // 搜索：title = 只匹配标题/cwd（本地过滤，即时）；full = 服务端全文搜索
  searchMode: "title",
  searchRes: null,   // 全文搜索结果 { q, took, total, results }
  searchBusy: false,
  searchSeq: 0,      // 请求序号，丢弃过期响应（连打关键字时后到的旧结果会盖掉新的）
  timeFilter: 0,     // 0 = 全部，否则为「最近 N 天」
  filtersOpen: false, // 手机档筛选区是否展开（桌面档 CSS 直接忽略此状态）
  // 运行环境信息（后端 /api/trash 返回）：回收站路径与平台名，
  // 删除提示文案、路径缩短都按它走，避免把 Linux 的 ~/.local/share/Trash
  // 写死在页面里给 Windows 用户看
  platform: { name: "", isWin: false, isMac: false, trashDir: "" },
};

const LIST_PAGE_SIZE = 25;
// 正文不分页，没有消息分页尺寸

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

// 属性值专用转义：esc() 走 textContent，只处理 & < >，**不转义引号**。
// 直接拼进 title="..." / value="..." 时，值里一旦有 " 就会提前闭合属性，
// 后面的内容被吞掉（表现为消息整条不显示）。属性里一律用 escAttr。
function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
