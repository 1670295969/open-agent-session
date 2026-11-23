/* 会话删除：单条（悬停 × ）+ 多选批量，一律移入回收站 */
"use strict";

// 删除确认弹窗状态
let delTarget = null;          // { files: [...], titles: [...] }

function trashIcon() {
  return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/></svg>';
}

// ---- 单项删除 ----
// 列表里内联 onclick 传进来的是 file 字符串，这里按 file 找回会话对象
function askDelete(file) {
  if (!file) return;
  if (state.selectMode) return;              // 多选模式下不走单项
  const s = state.sessions.find((x) => x.file === file);
  openDeleteModal([file], [s ? (s.title || file) : file]);
}

// 回收站说明按平台切换：Linux 是 freedesktop 目录，Windows 是系统回收站，
// macOS 是用户家目录下的废纸篓（Finder 里那个）。
// 写死 Linux 路径会让 Windows / macOS 用户去找一个不存在的 ~/.local/share/Trash
function trashHint() {
  const p = state.platform || {};
  if (p.isWin) {
    return '文件会移入<b>系统回收站</b>，可从回收站还原；不会立刻物理删除。';
  }
  if (p.isMac) {
    return '文件会移入<b>废纸篓</b>（Finder 侧栏的「废纸篓」），' +
      '可拖出还原；不会立刻物理删除。';
  }
  return '文件会移入<b>回收站</b>（~/.local/share/Trash），可从文件管理器还原；' +
    '不会立刻物理删除。';
}

function openDeleteModal(files, titles) {
  delTarget = { files, titles };
  const many = files.length > 1;
  const preview = many
    ? '<div class="dellist">' + titles.slice(0, 6).map((t) =>
        '<div>· ' + esc(t) + '</div>').join("") +
        (titles.length > 6 ? '<div class="more">… 以及另外 ' + (titles.length - 6) + ' 个</div>' : "") +
      '</div>'
    : '<div class="dellist"><div class="mono">' + esc(files[0]) + '</div></div>';

  const box = $("#delmodal");
  box.innerHTML =
    '<div class="box">' +
      '<h3>' + (many ? "删除 " + files.length + " 个会话？" : "删除这个会话？") + '</h3>' +
      preview +
      '<p class="warn">' + trashHint() + '</p>' +
      '<div class="row">' +
        '<button onclick="closeDeleteModal()">取消</button>' +
        '<button class="danger" onclick="confirmDelete(this)">移入回收站</button>' +
      '</div>' +
    '</div>';
  box.classList.add("show");
}

function closeDeleteModal() {
  const box = $("#delmodal");
  if (box) box.classList.remove("show");
  delTarget = null;
}

async function confirmDelete(btn) {
  if (!delTarget) return;
  const files = delTarget.files.slice();
  const single = files.length === 1;
  btn.disabled = true;
  btn.textContent = "删除中…";

  let j;
  try {
    const url = single ? "/api/delete" : "/api/delete-batch";
    const payload = single ? { file: files[0] } : { files };
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    j = await r.json();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "移入回收站";
    toast("请求失败: " + e);
    return;
  }

  closeDeleteModal();

  const okCount = single ? (j.ok ? 1 : 0) : (j.deleted || 0);
  const failed = single ? (j.ok ? [] : [{ error: j.error }]) : (j.failed || []);

  if (okCount) {
    // 当前打开的被删掉 → 回空白页
    const cur = state.active && state.active.file;
    if (cur && files.includes(cur)) {
      state.active = null;
      state.msgs = null;
      $("#main").innerHTML = '<div id="empty"><div class="empty-emoji">🗂️</div>' +
        '该会话已删除，左侧选择其他会话</div>';
    }
    // 本地先摘掉，避免等扫描
    state.sessions = state.sessions.filter((s) => !files.includes(s.file));
    exitSelectMode();
    renderList();
    updateStats();
    // 后台校验一次真实扫描结果
    loadSessions().catch(() => {});
  }

  if (failed.length) {
    toast("有 " + failed.length + " 个未删除：" + (failed[0].error || "未知错误"));
  } else {
    toast(okCount > 1 ? "已删除 " + okCount + " 个，可在回收站还原" : "已移入回收站，可还原");
  }
}

// ---- 多选批量 ----
function toggleSelectMode() {
  if (state.selectMode) exitSelectMode();
  else enterSelectMode();
}

function enterSelectMode() {
  state.selectMode = true;
  state.selected = state.selected || new Set();
  const btn = $("#selbtn");
  if (btn) { btn.textContent = "✕ 退出多选"; btn.classList.add("on"); }
  renderSelBar();
  renderList();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selected = new Set();
  const btn = $("#selbtn");
  if (btn) { btn.textContent = "☑ 多选"; btn.classList.remove("on"); }
  renderSelBar();
  renderList();
}

function toggleSelect(file, ev) {
  if (ev) ev.stopPropagation();
  if (!state.selected) state.selected = new Set();
  if (state.selected.has(file)) state.selected.delete(file);
  else state.selected.add(file);
  renderSelBar();
  renderList();
}

// 当前页全选 / 反选
function selectPageAll() {
  const set = filteredSessions();
  const page = set.slice(state.listPage * LIST_PAGE_SIZE, (state.listPage + 1) * LIST_PAGE_SIZE);
  if (!state.selected) state.selected = new Set();
  const allIn = page.length && page.every((s) => state.selected.has(s.file));
  for (const s of page) {
    if (allIn) state.selected.delete(s.file);
    else state.selected.add(s.file);
  }
  renderSelBar();
  renderList();
}

function renderSelBar() {
  const bar = $("#selbar");
  if (!bar) return;
  if (!state.selectMode) { bar.classList.remove("show"); bar.innerHTML = ""; return; }
  const n = state.selected ? state.selected.size : 0;
  bar.classList.add("show");
  bar.innerHTML =
    '<span>已选 <b>' + n + '</b> 个</span>' +
    '<button onclick="selectPageAll()">全选本页</button>' +
    '<button class="danger" onclick="askDeleteSelected()"' + (n ? "" : " disabled") +
      '>删除选中</button>';
}

function askDeleteSelected() {
  const sel = state.selected;
  if (!sel || !sel.size) return;
  const picked = state.sessions.filter((s) => sel.has(s.file));
  openDeleteModal(picked.map((s) => s.file), picked.map((s) => s.title || s.file));
}

// 点击列表项时：多选模式走选中，否则正常打开
function onItemTap(s, ev) {
  if (state.selectMode) { toggleSelect(s.file, ev); return; }
  openSession(s);
}
