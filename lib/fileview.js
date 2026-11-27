// 本地文件预览
//
// 为什么需要：会话正文里出现的路径（`/home/x/a.kt:44`、`~/b.log#L96`、
// 相对路径 `out/analysis.md`）原来只是一串死字符串，想看得自己去终端 cat。
// 这里把「路径 → 文本片段 + 行号」变成一次 HTTP 请求，前端点一下就弹窗看，
// 再一键送到编辑器里定位到那一行。
//
// 三个设计取舍：
//   1. **按行流式读**。日志类文件动辄几十 MB（实测 logcat.txt 50MB / 90 万行），
//      整读进内存再 split 会把服务撑爆。用 readline 流式过一遍，只留目标行附近
//      一个窗口（默认 400 行），总行数顺路数出来。
//   2. **二进制/图片不按文本读**。null 字节嗅探 + 扩展名双向判断，图片走
//      raw=1 直接回字节给 <img>，其余二进制提示用系统程序打开。
//   3. **路径解析规则和「新建会话」的 cwd 归一保持一致**（`~` 展开、反斜杠
//      归一、相对路径按会话 cwd 落），否则同一个路径在两处指向不同文件。
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { HOME } = require("./config");
const { resolveCommand, spawnTool, openUrl } = require("./platform");

// 按文本预览的扩展名。不在表里的一律先嗅探 null 字节再决定 ——
// 无扩展名的脚本（bin/opensession-open）也得能看。
const TEXT_EXT = new Set([
  ".txt", ".log", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".ini", ".conf", ".cfg", ".properties", ".xml", ".html", ".htm", ".css", ".scss",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".kt", ".kts", ".java", ".py",
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd", ".c", ".h", ".cc",
  ".cpp", ".hpp", ".go", ".rs", ".rb", ".php", ".sql", ".gradle", ".pro", ".mk",
  ".diff", ".patch", ".csv", ".tsv", ".env", ".gitignore", ".dockerfile", ".bp",
  ".te", ".rc", ".s", ".map",
]);

const IMG_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
};

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8", ".xml": "text/xml; charset=utf-8",
  ".svg": "image/svg+xml",
};

// 预览窗口：目标行前留 120 行上下文，总宽 400 行。
// 为什么不是「整篇」：50MB 文本一次塞给浏览器必卡死；而读代码时
// 需要的通常是「那一行」加前后一小段。
const CTX_BEFORE = 120;
const WIN_LINES = 400;
// 超过这个大小直接拒绝：再大就不是「预览」了，让用户去编辑器里看
const MAX_BYTES = 64 * 1024 * 1024;

function isTextExt(ext) { return TEXT_EXT.has(String(ext || "").toLowerCase()); }
function isImgExt(ext) { return !!IMG_MIME[String(ext || "").toLowerCase()]; }

/* 把消息里那段字符串解析成绝对路径 + 行号。
   要吃掉的形式（都是实测在正文里出现过的）：
     /abs/a.kt:44            行号冒号
     /abs/a.log#L96          GitHub 风格锚点
     ~/work/a.kt:450         ~ 展开
     file:///home/a.png      file 协议
     </home/a.kt:132>        markdown 尖括号形式
     `/home/a.kt`            带反引号
   返回 { ok, abs, line, error }；abs 不保证存在。 */
function resolveTarget(input, cwd) {
  let s = String(input == null ? "" : input).trim();
  if (!s) return { ok: false, error: "路径为空" };
  if (/^[a-z]+:\/\//i.test(s) && !/^file:\/\//i.test(s)) {
    return { ok: false, error: "这是网络链接，不是本地文件" };
  }
  s = s.replace(/^file:\/\//i, "");
  // file:// 里的 %20 这类转义要还原，否则文件名带空格就找不到
  try { s = decodeURIComponent(s); } catch { /* 保留原样 */ }
  s = s.replace(/^[<"'`]+/, "").replace(/[>"'`]+$/, "").trim();
  // 路径末尾常跟着中文标点（"看 /a/b.kt，"），不剥掉就 stat 失败
  s = s.replace(/[，。；、！？：）】》」』]+$/, "");
  if (!s) return { ok: false, error: "路径为空" };

  let line = 0;
  const anchor = s.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/i);
  if (anchor) { s = anchor[1]; line = Number(anchor[2]); }
  // `:44` / `:44:12`（列号直接丢掉，只定位行）
  const colon = s.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (colon) {
    // 排除 Windows 盘符（`C:`）被误当行号的情况
    if (!/^[A-Za-z]:$/.test(colon[1])) { s = colon[1]; line = line || Number(colon[2]); }
  }

  // 与 lib/cwd.js 同一套规则：Windows 路径原样，其余把反斜杠转正
  const isWinPath = /^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s);
  if (!isWinPath) s = s.replace(/\\/g, "/");
  if (s === "~") s = HOME;
  else if (s.startsWith("~/")) s = path.join(HOME, s.slice(2));
  // 相对路径按会话 cwd 落；没给 cwd 就按 HOME（与新建会话一致）
  if (!path.isAbsolute(s) && !isWinPath) s = path.join(cwd || HOME, s);

  const abs = path.normalize(s);
  return { ok: true, abs, line: line > 0 ? line : 0 };
}

// 二进制嗅探：文件头 8KB 里出现 NUL 基本可判为二进制
function sniffBinary(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch { return false; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

/* 流式读一个窗口。返回 { from, to, lines, totalLines, truncated }。
   行号从 1 开始；targetLine=0 表示从第一行开始看。
   fromLine 显式指定窗口起点（「上一段 / 下一段」按钮用），优先于 targetLine。 */
function readWindow(file, targetLine, fromLine) {
  return new Promise((resolve, reject) => {
    const from = fromLine > 0 ? fromLine
      : targetLine > 0 ? Math.max(1, targetLine - CTX_BEFORE) : 1;
    const to = from + WIN_LINES - 1;
    const lines = [];
    // 尾部缓冲：起读位置超出文件末尾时（行号是旧文件里的，比如日志被轮转截短了）
    // 窗口会一行都取不到，这时退回「最后 400 行」，总比一片空白好。
    const tail = [];
    let n = 0;
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (l) => {
      n++;
      if (n >= from && n <= to) lines.push(l);
      // 只在「窗口起点在文件中间」时才维护尾部缓冲：起点超出末尾时靠它退回最后一段
      if (from > 1) { tail.push(l); if (tail.length > WIN_LINES) tail.shift(); }
      // 窗口已满且确定后面还有内容：不再等读完，直接给结果。
      // 但 totalLines 只有读完才准 —— 宁可控一下 rl 继续数行不存内容，
      // 这样「共 N 行」这个信息才靠得住（日志类文件全靠它定位）。
    });
    rl.on("close", () => {
      if (!lines.length && tail.length) {
        const f2 = Math.max(1, n - tail.length + 1);
        resolve({ from: f2, to: n, lines: tail.slice(), totalLines: n, truncated: f2 > 1, clamped: true });
        return;
      }
      resolve({ from, to: Math.min(to, n), lines, totalLines: n, truncated: n > to });
    });
    rl.on("error", reject);
  });
}

// 主入口：给一个字符串路径，返回前端能直接渲染的对象
//   opts.line 显式指定行号，优先于路径里自带的 `:44` ——
//   前端把 data-file 和 data-line 拆成两个字段传，路径本身是不带行号的。
async function peek(input, cwd, opts = {}) {
  const r = resolveTarget(input, cwd);
  if (!r.ok) return { ok: false, ...r };
  if (opts.line > 0) r.line = Number(opts.line) || r.line;
  const abs = r.abs;

  let st;
  try { st = fs.statSync(abs); }
  catch {
    // 找不到时把「解析成什么」回显出来：用户写的是相对路径时，
    // 只说「不存在」他完全猜不到我们是按哪个 cwd 解析的。
    return { ok: false, error: "文件不存在：" + abs, path: abs, line: r.line };
  }
  if (st.isDirectory()) {
    let names = [];
    try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch {}
    return {
      ok: true, kind: "dir", path: abs, line: 0, size: 0,
      entries: names.slice(0, 500).map((e) => ({ name: e.name, dir: e.isDirectory() })),
      more: Math.max(0, names.length - 500), total: names.length,
    };
  }

  const ext = path.extname(abs);
  const base = {
    path: abs, line: r.line, size: st.size, ext: ext.toLowerCase(),
    mtime: st.mtimeMs,
  };

  if (isImgExt(ext)) return { ok: true, kind: "image", ...base };
  if (!isTextExt(ext) && sniffBinary(abs)) return { ok: true, kind: "binary", ...base };
  if (st.size > MAX_BYTES) {
    return { ok: false, error: "文件过大（" + Math.round(st.size / 1048576) + "MB），请用编辑器打开", ...base };
  }

  const w = await readWindow(abs, r.line, Number(opts.from) || 0);
  return { ok: true, kind: "text", ...base, ...w };
}

// 原样回字节（图片预览 / 下载）
function serveRaw(input, cwd, res) {
  const r = resolveTarget(input, cwd);
  if (!r.ok) { res.writeHead(400); return res.end("bad path"); }
  let st;
  try { st = fs.statSync(r.abs); } catch { res.writeHead(404); return res.end("not found"); }
  if (!st.isFile()) { res.writeHead(400); return res.end("not a file"); }
  const ext = path.extname(r.abs).toLowerCase();
  const body = fs.readFileSync(r.abs);
  res.writeHead(200, {
    "Content-Type": IMG_MIME[ext] || MIME[ext] || "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Content-Disposition": 'inline; filename="' + path.basename(r.abs).replace(/"/g, "") + '"',
  });
  res.end(body);
}

// 在编辑器里打开并定位到行。
// 顺序按「本机最可能装了的」排：VS Code 系支持 `-g path:line`，
// idea 用 `--line N file`，subl 直接 `file:line`。
const EDITORS = [
  { bin: "code", args: (p, l) => (l ? ["-g", p + ":" + l] : [p]) },
  { bin: "codium", args: (p, l) => (l ? ["-g", p + ":" + l] : [p]) },
  { bin: "cursor", args: (p, l) => (l ? ["-g", p + ":" + l] : [p]) },
  { bin: "code-insiders", args: (p, l) => (l ? ["-g", p + ":" + l] : [p]) },
  { bin: "subl", args: (p, l) => (l ? [p + ":" + l] : [p]) },
  { bin: "idea", args: (p, l) => (l ? ["--line", String(l), p] : [p]) },
  { bin: "gedit", args: (p, l) => (l ? ["+" + l, p] : [p]) },
];

function openInEditor(abs, line) {
  if (!abs || !fs.existsSync(abs)) return { ok: false, error: "文件不存在：" + abs };
  for (const ed of EDITORS) {
    if (!resolveCommand(ed.bin)) continue;
    try {
      const c = spawnTool(ed.bin, ed.args(abs, line), { detached: true, stdio: "ignore" });
      c.on("error", () => {});
      c.unref();
      return { ok: true, via: ed.bin };
    } catch { /* 试下一个 */ }
  }
  // 退路：交给系统默认程序（只能打开，定位不到行）
  if (openUrl("file://" + abs)) return { ok: true, via: "系统默认程序", noLine: true };
  return { ok: false, error: "没找到可用编辑器（code / codium / cursor / subl / idea 都没有）" };
}

module.exports = { peek, serveRaw, openInEditor, resolveTarget };
