/* 文件 / 链接预览弹窗
 *
 * 正文里被 md.js 标成 .filelink 的本地路径，点一下在这里看内容：
 *   · 文本：目标行附近 400 行，行号列对齐，命中行高亮
 *   · 图片：直接显示（走 /api/raw）
 *   · 目录：列出条目
 *   · 二进制 / 过大：只给元信息 + 「用系统程序打开」
 *
 * 为什么不用 window.open 交给浏览器：chrome 打不开 file:// （安全策略），
 * 而且会话正文里的路径多数是相对路径，浏览器不知道相对谁。
 *
 * 为什么行号只在弹窗里给「那一段」而不是整篇：实测 logcat.txt 90 万行 / 50MB，
 * 整篇塞进 DOM 必卡死；读代码只需要命中行加前后上下文。
 */
"use strict";

const PEEK = {
  open: false,
  cur: null,       // { path, line, cwd, kind, ... }
  seq: 0,          // 请求序号：连点两个链接时丢弃过期响应
  // 弹窗必须挂在 body 上而不是 #main 里：#main 每次 renderChat 都整体重建，
  // 挂在里面会随重绘一起消失。
  el: null,
};

function peekEl() {
  if (PEEK.el && document.body.contains(PEEK.el)) return PEEK.el;
  let box = document.getElementById("peek");
  if (!box) {
    box = document.createElement("div");
    box.id = "peek";
    box.innerHTML =
      '<div class="pk">' +
        '<div class="pkhead">' +
          '<span class="pktitle"></span>' +
          '<span class="pkmeta"></span>' +
          '<span class="pkgap"></span>' +
          '<button class="pkopen" title="在编辑器里打开并定位到这一行">✎ 编辑器</button>' +
          '<button class="pkcopy" title="复制这个路径">⧉ 路径</button>' +
          '<button class="pkclose" title="关闭（Esc）">✕</button>' +
        '</div>' +
        '<div class="pkbody"></div>' +
        '<div class="pkfoot"></div>' +
      '</div>';
    document.body.appendChild(box);
    // 点遮罩关闭（点内容区不关）
    box.addEventListener("click", (e) => { if (e.target === box) closePeek(); });
    bindPeekButtons(box);
  }
  PEEK.el = box;
  return box;
}

function bindPeekButtons(box) {
  box.querySelector(".pkclose").addEventListener("click", closePeek);
  box.querySelector(".pkcopy").addEventListener("click", () => {
    if (!PEEK.cur) return;
    const p = PEEK.cur.path + (PEEK.cur.line > 0 ? ":" + PEEK.cur.line : "");
    copyText(p, "已复制路径");
  });
  box.querySelector(".pkopen").addEventListener("click", async (e) => {
    if (!PEEK.cur) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: PEEK.cur.path, line: PEEK.cur.line || 0 }),
      });
      const j = await r.json();
      if (j.ok) toast("已用 " + j.via + " 打开" + (j.noLine ? "（该程序不支持定位行）" : ""));
      else toast(j.error || "打开失败");
    } catch (err) {
      toast("打开失败: " + err);
    } finally { btn.disabled = false; }
  });
}

/* 当前会话的工作目录：相对路径全靠它解析。
   state.active 为 null 时（页面内新建会话进行中）退到顶栏那行 cwd 的文本 ——
   那段路径是 draft.cwd，就是对的位置，不必等会话落盘。 */
function peekCwd() {
  if (state.active && state.active.cwd) return state.active.cwd;
  const el = document.querySelector("#bar .cwd .cwdpath");
  if (!el) return "";
  return (el.dataset && el.dataset.file) || String(el.textContent || "").replace(/^📁\s*/, "").trim();
}

/* 打开预览。arg 可以是字符串（路径）或 {path, line}。 */
async function openPeek(arg) {
  const path = typeof arg === "string" ? arg : arg.path;
  const line = typeof arg === "string" ? 0 : Number(arg.line) || 0;
  if (!path) return;
  const cwd = peekCwd();
  PEEK.open = true;
  PEEK.cur = { path, line, cwd };
  const box = peekEl();
  box.classList.add("show");
  await loadPeek(0);
}

// from > 0 表示「翻到第 from 行开始看」，不是重新定位
async function loadPeek(from) {
  const seq = ++PEEK.seq;
  const box = peekEl();
  const body = box.querySelector(".pkbody");
  const title = box.querySelector(".pktitle");
  const meta = box.querySelector(".pkmeta");
  const foot = box.querySelector(".pkfoot");
  const cur = PEEK.cur;
  title.textContent = cur.path;
  title.title = cur.path;
  meta.textContent = "";
  foot.innerHTML = "";
  body.innerHTML = '<div class="pkload">读取中…</div>';

  let j;
  try {
    const url = "/api/peek?path=" + encodeURIComponent(cur.path) +
      "&cwd=" + encodeURIComponent(cur.cwd || "") +
      (from ? "&from=" + from : "") +
      // 行号单独传：cur.path 是不带 `:44` 的纯路径（data-file 拆过了）
      (cur.line ? "&line=" + cur.line : "");
    j = await (await fetch(url)).json();
  } catch (e) {
    if (seq !== PEEK.seq) return;
    body.innerHTML = '<div class="pkerr">请求失败：' + esc(String(e)) + "</div>";
    return;
  }
  // 连点两个链接时，后发的请求可能先返回；丢掉过期结果
  if (seq !== PEEK.seq) return;

  if (!j.ok) {
    body.innerHTML = '<div class="pkerr">' + esc(j.error || "读不到这个文件") + "</div>";
    if (j.path) {
      title.textContent = j.path;
      title.title = j.path;
    }
    foot.innerHTML = '<span class="pkhint">路径由会话工作目录解析；写相对路径时请确认会话里有 cwd。</span>';
    return;
  }

  PEEK.cur = { ...cur, ...j };
  title.textContent = j.path;
  title.title = j.path;
  meta.textContent = peekMetaText(j);

  if (j.kind === "image") {
    body.innerHTML = '<div class="pkimg"><img src="/api/raw?path=' +
      encodeURIComponent(j.path) + '" alt=""></div>';
    return;
  }
  if (j.kind === "dir") {
    body.innerHTML = '<div class="pkdir">' +
      (j.entries.length
        ? j.entries.map((e) =>
            '<a class="pke' + (e.dir ? " isdir" : "") + '" href="#" data-file="' +
            escAttr(j.path.replace(/\/$/, "") + "/" + e.name) + '">' +
            (e.dir ? "📁 " : "📄 ") + esc(e.name) + "</a>").join("")
        : '<span class="pkhint">空目录</span>') +
      (j.more ? '<div class="pkhint">…另有 ' + j.more + ' 项</div>' : "") +
      '</div>';
    return;
  }
  if (j.kind === "binary") {
    body.innerHTML = '<div class="pkerr">二进制文件，不能按文本预览。<br>' +
      '<span class="pkhint">点右上角「✎ 编辑器」用系统程序打开。</span></div>';
    return;
  }

  // 文本：行号列 + 代码块。行号用 CSS counter 而不是逐行拼两列 DOM ——
  // 400 行拼两遍没必要，counter 让序号和行天然对齐。
  // 🔴 counter-reset 必须从「窗口首行 - 1」开始，否则翻到第 3000 行时
  // 行号又从 1 数起，读日志会彻底错位。
  const hl = j.line;
  const rows = j.lines.map((t, i) => {
    const n = j.from + i;
    const cls = n === hl ? "pkl hit" : "pkl";
    return '<span class="' + cls + '" data-n="' + n + '">' + (t === "" ? "\u200b" : esc(t)) + "</span>";
  }).join("");
  body.innerHTML = '<pre class="pkpre" style="counter-reset:pkln ' + (j.from - 1) + '">' +
    rows + "</pre>";

  // 底部导航：前后各一段 + 位置说明
  const hasPrev = j.from > 1;
  const hasNext = j.to < j.totalLines;
  foot.innerHTML =
    '<button class="pkprev"' + (hasPrev ? "" : " disabled") + '>↑ 上一段</button>' +
    '<button class="pknext"' + (hasNext ? "" : " disabled") + '>↓ 下一段</button>' +
    '<span class="pkhint">第 ' + j.from + "–" + j.to + " 行 / 共 " + j.totalLines + " 行" +
    (j.truncated ? "（大了，只显示一段）" : "") + "</span>";
  const prev = foot.querySelector(".pkprev");
  const next = foot.querySelector(".pknext");
  if (prev) prev.addEventListener("click", () => loadPeek(Math.max(1, j.from - 400)));
  if (next) next.addEventListener("click", () => loadPeek(j.to + 1));

  // 滚动到命中行：不放到窗口顶端，留 1/4 屏上下文更好读
  const hit = body.querySelector(".pkl.hit");
  if (hit) {
    const pre = body.querySelector(".pkpre");
    pre.scrollTop = Math.max(0, hit.offsetTop - pre.clientHeight / 4);
  }
}

function peekMetaText(j) {
  const bits = [];
  // 目录的 size 是 4096 这类 inode 大小，写出来只会让人困惑
  if (j.kind === "dir") bits.push(j.total + " 项");
  else {
    if (j.totalLines) bits.push(j.totalLines + " 行");
    if (j.size != null) bits.push(fmtSize(j.size));
  }
  if (j.ext) bits.push(j.ext);
  if (j.mtime) bits.push(fmtTime(j.mtime));
  return bits.join(" · ");
}

function closePeek() {
  PEEK.open = false;
  PEEK.seq++;          // 让在途请求的结果失效
  const box = document.getElementById("peek");
  if (box) box.classList.remove("show");
}

/* 全局点击委托：正文里的 .filelink / 预览弹窗里的目录条目都走这里。
   顶栏的 .cwdpath 也算 —— 它是 <a data-file>，正好一套逻辑。
   为什么用委托：#chat 每次重绘整体重建，逐个绑监听会泄漏。 */
document.addEventListener("click", (e) => {
  const a = e.target.closest("a.filelink, a.pke, a.cwdpath");
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const file = a.dataset.file || "";
  const line = Number(a.dataset.line) || 0;
  if (!file) return;
  openPeek({ path: file, line });
});

// Esc 关闭（弹窗打开时才拦，避免影响别的场景）
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && PEEK.open) {
    e.preventDefault();
    closePeek();
  }
});
