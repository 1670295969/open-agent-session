/* 提问导航（大纲）
 *
 * 解决什么问题：会话动辄上百条消息，想回到「刚才问的那个问题」只能靠滚动找。
 * 这里把所有**用户提问**抽成短列表，点一条跳到对应位置。
 *
 * 只列提问，不列回答：回答太长且连续，列出来就是第二个正文；而「找某个话题」
 * 时人记得的是自己问过什么。
 *
 * 为什么不放在 #bar：那里已经有 6 个按钮，窄窗口下再加一个会挤成两行
 * （实测 --read-w 收窄那次就是被按钮挤的）。浮在右下角不占布局。
 */
"use strict";

function chatQuestions() {
  const msgs = state.msgs || [];
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== "user" || !m.text || m.sidechain) continue;
    // 单行摘要：换行压成空格，长提问截断。原始文本留在 title 里做悬停提示。
    const one = String(m.text).replace(/\s+/g, " ").trim();
    out.push({
      i,
      short: one.length > 68 ? one.slice(0, 68) + "…" : one,
      full: one,
      time: fmtMsgTime(m.time),
    });
  }
  return out;
}

function renderOutline() {
  const box = $("#outline");
  if (!box) return;
  const list = box.querySelector(".olist");
  const qs = chatQuestions();

  // 少于 2 个提问时导航没有意义 —— 隐藏按钮比给一个只有一条的列表更诚实
  const fab = $("#navbtn");
  if (fab) fab.style.display = qs.length >= 2 ? "" : "none";
  if (qs.length < 2) { box.classList.remove("show"); return; }

  list.innerHTML = qs.map((q, k) =>
    '<div class="oitem" data-i="' + q.i + '" title="' + escAttr(q.full) + '">' +
      '<span class="onum">' + (k + 1) + '</span>' +
      '<span class="otxt">' + esc(q.short) + '</span>' +
      (q.time ? '<span class="otime">' + esc(q.time) + '</span>' : "") +
    '</div>').join("");

  list.querySelectorAll(".oitem").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      const chat = $("#chat");
      const target = chat && chat.querySelector('.msg[data-i="' + i + '"]');
      if (target) {
        // 与 jumpQ 用同一套坐标换算，别混用 scrollIntoView（它会连带滚动祖先容器）
        chat.scrollTo({ top: chatTopOf(target, chat), behavior: "smooth" });
        target.classList.remove("hitflash");
        void target.offsetWidth;
        target.classList.add("hitflash");
      }
      list.querySelectorAll(".oitem").forEach((x) => x.classList.remove("on"));
      el.classList.add("on");
    };
  });
}

function toggleOutline(ev) {
  if (ev) ev.stopPropagation();
  const box = $("#outline");
  if (!box) return;
  if (!box.classList.contains("show")) renderOutline();
  box.classList.toggle("show");
}

/* 上/下一个提问（Alt+↑ / Alt+↓）：按当前滚动位置找最近的边界，
   而不是维护「当前第几条」的状态 —— 用户可能自己滚过，状态会漂。

   🔴 位置必须换算到 #chat 的滚动坐标系里。
   直接用 el.offsetTop 是错的：#chat 是 position:static，.msg 的 offsetParent
   会一路找到 body，offsetTop 里混进了 #bar 的高度和页面偏移，与 scrollTop
   不同量纲 —— 比较结果永远成立/永远不成立，实测按键完全没反应（scrollTop 不动）。
   用 getBoundingClientRect 相对 #chat 的差值，再加回 scrollTop，才是同一坐标系。 */
function chatTopOf(el, chat) {
  return el.getBoundingClientRect().top - chat.getBoundingClientRect().top + chat.scrollTop;
}

function jumpQ(dir) {
  const chat = $("#chat");
  if (!chat) return;
  const qs = chatQuestions();
  if (!qs.length) { toast("本会话没有提问"); return; }
  const nodes = qs.map((q) => chat.querySelector('.msg[data-i="' + q.i + '"]'))
    .filter(Boolean);
  if (!nodes.length) return;

  const cur = chat.scrollTop;
  const TOPS = nodes.map((n) => chatTopOf(n, chat));
  // 留 8px 容差：滚到某条提问时它的 top 正好等于 scrollTop，
  // 不设容差再按 ↓ 会原地不动（永远认为自己在这个位置）。
  let target;
  if (dir > 0) {
    const k = TOPS.findIndex((t) => t > cur + 8);
    target = k === -1 ? nodes.length - 1 : k;
  } else {
    let k = -1;
    for (let i = 0; i < TOPS.length; i++) if (TOPS[i] < cur - 8) k = i;
    target = k === -1 ? 0 : k;
  }
  chat.scrollTo({ top: TOPS[target], behavior: "smooth" });

  // 面板开着时同步高亮当前项，否则用户不知道跳到了第几个
  const box = $("#outline");
  if (box && box.classList.contains("show")) {
    box.querySelectorAll(".oitem").forEach((x, i) =>
      x.classList.toggle("on", i === target));
  }
}

// 点正文 / 侧栏任何地方都收起大纲（它是浮层，不点按钮时不该一直挡着）
document.addEventListener("click", (e) => {
  const box = $("#outline");
  if (!box || !box.classList.contains("show")) return;
  if (e.target.closest("#outline") || e.target.closest("#navbtn")) return;
  box.classList.remove("show");
});

document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
  if (!state.active) return;
  e.preventDefault();
  jumpQ(e.key === "ArrowDown" ? 1 : -1);
});
