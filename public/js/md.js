/* 轻量 Markdown 渲染器（零依赖，先转义再解析，杜绝注入）
 * 支持：标题 / 粗体 / 斜体 / 删除线 / 行内代码 / 围栏代码块（带复制按钮）
 *       有序、无序列表（可嵌套）/ 引用 / 表格 / 分隔线 / 链接 / 段落内换行
 */
"use strict";

// 转义。注意：不做引号转义（引号由插入 href 时单独处理）
function mdEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// URL 进 href 前把引号/空格编码掉，避免截断属性
function mdUrl(u) {
  return String(u).replace(/"/g, "%22").replace(/'/g, "%27").replace(/ /g, "%20");
}

// 属性值转义：mdEsc 只处理 & < >，引号会提前闭合 title="..." / data-file="..."
function mdAttr(s) {
  return mdEsc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// mdEsc 的逆：裸路径是在**已转义**的字符串上匹配出来的，
// 再交给 fileAnchorHtml 转义一次就会变成 `&amp;amp;`。
// mdEsc 只产出这三种实体，反解是安全的。
function mdUnesc(s) {
  return String(s == null ? "" : s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

const MD_TOK = "\u0001";

/* ---------------- 正文里的「可点目标」 ----------------
   两类：网络链接（http/https，新标签页打开）和本地路径（点击弹窗预览）。
   为什么必须在渲染层做：一条路径在正文里就是一串普通字符，后端解析消息时
   无从判断它是不是「用户想点开的」，只有渲染时才看得见上下文。

   为什么本地路径要分绝对 / 相对两套规则：
     · 绝对路径（`/home/x/a.kt:44`、`~/b.log#L96`）不会和普通文字撞车，只要
       有两段就认 —— 实测全库 1028 处，绝大多数是这种。
     · 相对路径（`out/analysis.md`）风险高得多：`24/7`、`TCP/IP`、`和/或`
       都是常见写法，一律加链接会让正文变成蓝色乱麻。所以相对路径**必须**
       带已知文件扩展名（`.md` / `.kt` / `.log` …）才认，纯目录相对路径不认。
*/
const LINK_EXT = "kt|kts|java|py|js|mjs|cjs|ts|tsx|jsx|json|jsonl|md|markdown|" +
  "txt|log|xml|yml|yaml|toml|ini|conf|cfg|properties|sh|bash|zsh|ps1|bat|cmd|" +
  "c|h|cc|cpp|hpp|go|rs|rb|php|sql|gradle|pro|mk|diff|patch|csv|tsv|html|htm|css|" +
  "scss|svelte|vue|png|jpg|jpeg|gif|webp|bmp|svg|ico|avif|zip|apk|jar|pdf|so|zst";

// 路径的一段：不含空白、引号、括号、竖线、中英文标点与冒号
// （冒号单独作为「行号」后缀处理，段内出现冒号一律视为路径结束）
// 🔴 排除 `*` `?` `{` `}`：那是 glob（`decoded/*.log`、`/data/anr/trace_*`），
// 点了必然「文件不存在」，不如不给链接。
const SEG = "[^\\s\"'`()\\[\\]<>|:,，。；、！？（）【】《》「」『』*?{}]+";
// 行号后缀：`:44` / `:44:12` / `#L96` / `#L96-L120`
const TAIL = "(?::\\d+(?::\\d+)?|#L\\d+(?:-L?\\d+)?)?";
// 绝对路径的「前导」比相对路径宽：允许紧跟中文字符。
// 🔴 实测反例：`升级/media/liu/.../Update12.zip` —— 中文贴着路径写时，
// 若前导只认空格/标点，绝对路径规则匹配不上，相对路径规则就会把
// 「升级」当成目录名吸进去，解析出一个根本不存在的路径。
// 放宽是安全的：绝对路径规则要求至少两段（`/a/b`），`和/或` 这类撞不上。
const PRE_ABS = "(^|[\\s(（\\[【\"'`>，。；：？！、\\u4e00-\\u9fa5])";
// 相对路径的前导必须严格（只认真正的分隔符），否则中文会被吸进目录名
const PRE = "(^|[\\s(（\\[【\"'`>，。；：？！、])";

const RE_ABS = new RegExp(PRE_ABS + "((?:~?/)" + SEG + "(?:/" + SEG + ")+" + TAIL + ")", "g");
const RE_REL = new RegExp(PRE + "((?:[\\w.@+%~\\u4e00-\\u9fa5-]+/)+[\\w.@+%~\\u4e00-\\u9fa5-]+\\." +
  "(?:" + LINK_EXT + ")" + TAIL + ")", "gi");

// 把 `path:44` 拆成 data-file + data-line（行号交给弹窗定位）
// innerHtml 有值时直接用它当链接文字（行内代码要保留 <code> 的等宽外观）
function fileAnchorHtml(target, text, innerHtml) {
  let p = target, line = "";
  const a = p.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/i);
  if (a) { p = a[1]; line = a[2]; }
  const c = p.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (c && !/^[A-Za-z]:$/.test(c[1])) { p = c[1]; line = line || c[2]; }
  const label = innerHtml || mdEsc(text || target);
  return '<a class="filelink" href="#" data-file="' + mdAttr(p) + '"' +
    (line ? ' data-line="' + line + '"' : "") +
    ' title="点击预览：' + mdAttr(p + (line ? ":" + line : "")) + '">' +
    label + "</a>";
}

/* 匹配结束位置紧跟通配符 → 这是 glob 模式（`decoded/*.log`、`/data/anr/trace_*`），
   不是某个具体文件。点开必然「文件不存在」，所以不生成链接。 */
function isGlobAt(all, end) {
  const c = all[end];
  return c === "*" || c === "?" || c === "{" || c === "[" || c === "<";
}

/* 绝对路径的可信度校验。
   🔴 为什么必须有：中文行文里 `A/B` 这种并列写法极多（「和/或」「版本/写入方」
   「判定/理由/错在哪」），一旦把它们当路径，正文会满屏假链接 —— 实测放宽
   前导后一下冒出 11 处这种误判，比漏掉几个真路径糟糕得多。

   两条判据，满足其一才算真路径：
   1. 顶层目录是常见系统根（/home /data /tmp /media …）——
      「/v1/chat/completions」这种 API 路径就靠这条挡掉；
   2. 末段带文件扩展名 —— 兜住 `/weird/dir/file.log` 这类非常规根。
   两者都要「至少有一段含 ASCII 字母数字」，用来挡全中文的并列结构。 */
const WSL_ROOT = new Set([
  "home", "root", "data", "tmp", "temp", "media", "mnt", "opt", "usr", "var",
  "etc", "dev", "proc", "sys", "run", "srv", "boot", "lib", "bin", "sbin",
  "sdcard", "storage", "system", "vendor", "product", "ota", "cache", "Users",
  "private", "Applications", "Volumes", "Library",
]);

function isRealAbsPath(p) {
  const body = p.replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  if (body.length < 6) return false;
  const segs = body.split("/").filter(Boolean);
  if (segs.length < 2) return false;
  if (!segs.some((s) => /[A-Za-z0-9]/.test(s))) return false;
  // `~/x` 是家目录，一定是本地路径
  if (p.startsWith("~/")) return true;
  const root = segs[0];
  if (WSL_ROOT.has(root)) return true;
  // 兜底：末段有扩展名
  return new RegExp("\\." + "(?:" + LINK_EXT + ")$", "i").test(segs[segs.length - 1]);
}

/* 一段文本（反引号里被单独拎出来的内容）看起来像不像本地路径。
   这里规则可以比裸文本宽 —— 已经被反引号标出来了，误判代价小。
   但可信度判断必须和裸路径共用：实测 `/v1/chat/completions`（API 路径）
   和 `decoded/*.log`（glob）都会被反引号包着出现，按「以 / 开头就算路径」
   的粗规则会造出两个必然打不开的链接。 */
function isPathLike(t) {
  if (!t || /\s/.test(t)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false;   // 协议头由调用方单独判断
  if (/[*?{}[\]]/.test(t)) return false;                   // glob，不是具体文件
  if (/^(~\/|\.{1,2}\/)/.test(t)) return true;
  if (t.startsWith("/")) return isRealAbsPath(t);
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  return new RegExp("\\." + "(?:" + LINK_EXT + ")(?::\\d+(?::\\d+)?|#L\\d+)?$", "i").test(t);
}


// 行内格式化
// 关键：行内代码与链接先生成 HTML 并换成占位符，避免它们的下划线被斜体、
// 星号被粗体规则误吃（典型 bug：target="_blank" 变成 target="<em>blank"）
function mdInline(src) {
  let s = mdEsc(src);
  const keep = [];
  const hold = (html) => MD_TOK + (keep.push(html) - 1) + MD_TOK;

  // 1) 行内代码
  //   🔴 这里必须先判断「代码内容是不是一个路径 / URL」：agent 写路径的
  //   主流形式就是 `` `/home/x/a.kt:44` ``，如果一律当纯代码处理，
  //   等于最该点的那些一个都点不了（实测正文里 938 处绝对路径，
  //   大部分裹在反引号里）。命中就渲染成「带等宽样式的链接」。
  s = s.replace(/`([^`\n]+)`/g, (m, c) => {
    const t = c.trim();
    if (/^https?:\/\/\S+$/i.test(t)) {
      return hold('<a class="codelink" href="' + mdUrl(t) +
        '" target="_blank" rel="noopener noreferrer"><code class="ic">' + c + "</code></a>");
    }
    if (isPathLike(t)) {
      return hold(fileAnchorHtml(t, null, '<code class="ic">' + c + "</code>"));
    }
    return hold('<code class="ic">' + c + "</code>");
  });

  // 2) 链接：markdown 语法。target 允许 http(s) / mailto / 本地路径 / file://
  //    本地路径走与裸路径同一套弹窗；只放行这几种协议，杜绝 javascript:
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]{1,400})\)/g, (m, t, u) => {
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) {
      return hold('<a href="' + mdUrl(u) + '" target="_blank" rel="noopener noreferrer">' +
        t + "</a>");
    }
    if (/^file:\/\//i.test(u) || /^~?\.{0,2}\//.test(u) || /^[A-Za-z]:[\\/]/.test(u)) {
      return hold(fileAnchorHtml(u.replace(/^file:\/\//i, ""), t));
    }
    // 站内锚点 / 其他协议：保留可读文本，不加链接
    return hold(t || mdEsc(u));
  });
  // 3) 裸网络链接
  s = s.replace(/(^|[\s(（])((?:https?:\/\/)[^\s<>"')\]]+)/g,
    (m, pre, u) => pre + hold('<a href="' + mdUrl(u) +
      '" target="_blank" rel="noopener noreferrer">' + u + "</a>"));
  // 3.5) 裸本地路径：绝对路径先于相对路径（相对规则更宽，先跑会抢走绝对路径的一段）
  //   🔴 这里 s 已经过 mdEsc，匹配出来的 p 里 `&` 已变成 `&amp;`；
  //   不反解就会二次转义（路径里带 & 的文件名直接打不开）。
  //   glob 后置判断：`/data/anr/trace_*` 里 SEG 到 `*` 前就断了，
  //   会留下半截 `/data/anr/trace_` —— 那是个不存在的路径，别给链接。
  s = s.replace(RE_ABS, (m, pre, p, off, all) => {
    if (isGlobAt(all, off + pre.length + p.length)) return m;
    if (!isRealAbsPath(p)) return m;
    return pre + hold(fileAnchorHtml(mdUnesc(p)));
  });
  s = s.replace(RE_REL, (m, pre, p, off, all) =>
    isGlobAt(all, off + pre.length + p.length) ? m : pre + hold(fileAnchorHtml(mdUnesc(p))));

  // 4) 强调
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, "$1<em>$2</em>");

  // 5) 还原占位符
  s = s.replace(new RegExp(MD_TOK + "(\\d+)" + MD_TOK, "g"), (m, i) => keep[+i]);
  return s;
}

// 表格单元格切分
function mdCells(line) {
  let l = String(line).trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}

function mdIsTableSep(line) {
  const l = String(line).trim();
  if (!l.includes("-") || !l.includes("|")) return false;
  return /^\|?[\s:|-]+\|?$/.test(l);
}

// 主渲染：markdown 文本 → HTML
function mdToHtml(src) {
  const lines = String(src == null ? "" : src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let i = 0;

  const flush = () => {
    if (!para.length) return;
    out.push("<p>" + para.map(mdInline).join("<br>") + "</p>");
    para = [];
  };

  while (i < lines.length) {
    const line = lines[i];

    // ---- 围栏代码块 ``` / ~~~
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+.#-]*)\s*$/);
    if (fence) {
      flush();
      const mark = fence[1][0].repeat(3);
      const lang = fence[2] || "";
      const buf = [];
      i++;
      const closeRe = new RegExp("^\\s*" + mark + "\\s*$");
      while (i < lines.length && !closeRe.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // 吃掉结束围栏
      out.push(
        '<div class="codeblk"><div class="codehead">' +
          '<span class="codelang">' + mdEsc(lang) + "</span>" +
          '<button class="copybtn" onclick="copyCode(this)">复制</button>' +
        "</div><pre><code>" + mdEsc(buf.join("\n")) + "</code></pre></div>"
      );
      continue;
    }

    // ---- 空行
    if (!line.trim()) { flush(); i++; continue; }

    // ---- 分隔线
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      flush(); out.push("<hr>"); i++; continue;
    }

    // ---- 标题
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const lv = h[1].length;
      const txt = h[2].replace(/\s+#+\s*$/, "");
      out.push("<h" + lv + ">" + mdInline(txt) + "</h" + lv + ">");
      i++;
      continue;
    }

    // ---- 引用（内部递归解析）
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      out.push("<blockquote>" + mdToHtml(buf.join("\n")) + "</blockquote>");
      continue;
    }

    // ---- 表格
    if (line.includes("|") && i + 1 < lines.length && mdIsTableSep(lines[i + 1])) {
      flush();
      const head = mdCells(line);
      const aligns = mdCells(lines[i + 1]).map((c) => {
        const l = c.startsWith(":"), r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(mdCells(lines[i])); i++;
      }
      let t = '<div class="tablewrap"><table><thead><tr>';
      head.forEach((c, k) => {
        t += "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" +
          mdInline(c) + "</th>";
      });
      t += "</tr></thead><tbody>";
      for (const r of rows) {
        t += "<tr>";
        for (let k = 0; k < head.length; k++) {
          t += "<td" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" +
            mdInline(r[k] || "") + "</td>";
        }
        t += "</tr>";
      }
      t += "</tbody></table></div>";
      out.push(t);
      continue;
    }

    // ---- 列表（按缩进嵌套，子列表必须落在父 <li> 内部）
    const li0 = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li0) {
      flush();
      let html = "";
      const stack = []; // { indent, tag }
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        const indent = m[1].replace(/\t/g, "    ").length;
        const tag = /\d/.test(m[2]) ? "ol" : "ul";
        if (!stack.length) {
          stack.push({ indent, tag });
          html += "<" + tag + ">";
        } else {
          const top = stack[stack.length - 1];
          if (indent > top.indent) {
            // 更深：把新列表插进上一个 li 里
            if (html.endsWith("</li>")) html = html.slice(0, -5);
            stack.push({ indent, tag });
            html += "<" + tag + ">";
          } else if (indent < top.indent) {
            while (stack.length > 1 && stack[stack.length - 1].indent > indent) {
              html += "</" + stack.pop().tag + "></li>";
            }
            const cur = stack[stack.length - 1];
            if (cur.tag !== tag) {
              html += "</" + stack.pop().tag + "><" + tag + ">";
              stack.push({ indent, tag });
            }
          } else if (top.tag !== tag) {
            html += "</" + stack.pop().tag + "><" + tag + ">";
            stack.push({ indent, tag });
          }
        }
        html += "<li>" + mdInline(m[3]) + "</li>";
        i++;
        // 紧跟的缩进续行并进当前项
        while (i < lines.length && lines[i].trim() &&
               !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
          html = html.replace(/<\/li>$/, "<br>" + mdInline(lines[i].trim()) + "</li>");
          i++;
        }
      }
      while (stack.length > 1) html += "</" + stack.pop().tag + "></li>";
      if (stack.length) html += "</" + stack.pop().tag + ">";
      out.push('<div class="mdlist">' + html + "</div>");
      continue;
    }

    // ---- 普通段落
    para.push(line);
    i++;
  }
  flush();
  return out.join("");
}

// 代码块复制
function copyCode(btn) {
  const box = btn.closest(".codeblk");
  const pre = box && box.querySelector("pre");
  const text = pre ? pre.textContent : "";
  const done = () => {
    btn.textContent = "已复制";
    setTimeout(() => { btn.textContent = "复制"; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      // 退路：临时 textarea
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch { toast("复制失败"); }
      ta.remove();
    });
  }
}
