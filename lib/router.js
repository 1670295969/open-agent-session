// HTTP 路由表
const { getAllSessions, invalidateSessions } = require("./sessions");
const { parseSession } = require("./parsers");
const { exportMarkdown, exportFilename } = require("./exporter");
const { resumeSession, newSession } = require("./terminal");
const { embedRun } = require("./embed");
const { modelCatalog } = require("./models");
const { serveStatic } = require("./static");
const { moveToTrash, resolveDeletable, trashDir } = require("./trash");
const { platformName, IS_WIN, IS_MAC } = require("./platform");
const { search, invalidateSearch } = require("./search");

function json(res, code, obj, extraHeaders = {}) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(obj));
}

// 读取 POST body 并解析 JSON
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// 会话文件合法性：jsonl，hermes 的 json，dsh 的多帧 zstd
function validSessionFile(file, tool) {
  if (!file) return false;
  if (tool === "hermes") return file.endsWith(".json");
  if (tool === "dsh") return file.endsWith(".jsonl.zstd");
  return file.endsWith(".jsonl");
}

async function handleApi(req, res, u) {
  const p = u.pathname;

  if (p === "/api/sessions") {
    const s = await getAllSessions(u.searchParams.get("force") === "1");
    return json(res, 200, s);
  }

  if (p === "/api/session") {
    const file = u.searchParams.get("file");
    const tool = u.searchParams.get("tool") || "";
    if (!validSessionFile(file, tool)) return json(res, 400, { error: "bad file" });
    try { return json(res, 200, await parseSession(file, tool)); }
    catch (e) { return json(res, 500, { error: String(e) }); }
  }

  if (p === "/api/export") {
    const file = u.searchParams.get("file");
    const tool = u.searchParams.get("tool") || "";
    const title = u.searchParams.get("title") || "session";
    const id = u.searchParams.get("id") || "";
    const cwd = u.searchParams.get("cwd") || "";
    if (!validSessionFile(file, tool)) return json(res, 400, { error: "bad file" });
    try {
      const md = await exportMarkdown({ file, tool, title, id, cwd });
      const body = Buffer.from(md, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(title, tool)}"`,
        "Content-Length": body.length,
      });
      return res.end(body);
    } catch (e) { return json(res, 500, { error: String(e) }); }
  }

  if (p === "/api/models") {
    return json(res, 200, modelCatalog());
  }

  // 全文搜索：跨会话搜消息正文 + 思考内容。
  // since 是毫秒时间戳，前端「最近 7 天」这类筛选直接传值，后端在扫描结果上先过滤。
  if (p === "/api/search") {
    const q = u.searchParams.get("q") || "";
    const tool = u.searchParams.get("tool") || "all";
    const since = Number(u.searchParams.get("since")) || 0;
    if (!q.trim()) return json(res, 200, { q: "", took: 0, total: 0, truncated: false, results: [] });
    try { return json(res, 200, await search(q, { tool, since })); }
    catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  // 删除会话：移入回收站（不是物理删除），可还原
  if (p === "/api/delete" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); }
    catch { return json(res, 400, { error: "bad json" }); }

    const chk = resolveDeletable(body.file);
    if (!chk.ok) return json(res, 403, { error: chk.error });

    try {
      // dsh 的会话要连目录一起进回收站（trashTarget），否则留下空目录和锁文件
      const r = moveToTrash(chk.trashTarget || chk.real);
      invalidateSessions();
      invalidateSearch();
      return json(res, 200, { ok: true, trashed: r.name, size: r.size });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }

  // 批量删除：逐条校验，任何一条不合法就跳过（不整批失败）
  if (p === "/api/delete-batch" && req.method === "POST") {
    let body;
    try { body = await readJsonBody(req); }
    catch { return json(res, 400, { error: "bad json" }); }

    const files = Array.isArray(body.files) ? body.files : [];
    if (!files.length) return json(res, 400, { error: "files 为空" });

    const done = [], failed = [];
    for (const f of files) {
      const chk = resolveDeletable(f);
      if (!chk.ok) { failed.push({ file: f, error: chk.error }); continue; }
      try { const r = moveToTrash(chk.trashTarget || chk.real); done.push(r.name); }
      catch (e) { failed.push({ file: f, error: String(e.message || e) }); }
    }
    if (done.length) { invalidateSessions(); invalidateSearch(); }
    return json(res, 200, { ok: failed.length === 0, deleted: done.length, failed });
  }

  // 回收站位置 + 运行平台（前端提示文案按平台切换措辞）
  if (p === "/api/trash") {
    return json(res, 200, {
      dir: trashDir, platform: platformName(),
      isWin: IS_WIN, isMac: IS_MAC,
    });
  }

  if (p === "/api/new" && req.method === "POST") {
    try { return json(res, 200, newSession(await readJsonBody(req))); }
    // 取 e.message：校验类错误（目录不存在等）要原样给用户看，
    // String(e) 会带上 "Error: " 前缀，显示成「失败: Error: 工作目录…」
    catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  if (p === "/api/resume" && req.method === "POST") {
    try { return json(res, 200, resumeSession(await readJsonBody(req))); }
    catch (e) { return json(res, 500, { error: String(e.message || e) }); }
  }

  if (p === "/api/embed" && req.method === "POST") {
    try { return embedRun(await readJsonBody(req), res); }
    catch (e) { return json(res, 500, { error: String(e) }); }
  }

  return json(res, 404, { error: "not found" });
}

async function handle(req, res) {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname.startsWith("/api/")) return await handleApi(req, res, u);
    if (serveStatic(u.pathname, res)) return;
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    try { json(res, 500, { error: String(e) }); } catch {}
  }
}

module.exports = { handle };
