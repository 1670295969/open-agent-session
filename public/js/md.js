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

const MD_TOK = "\u0001";

// 行内格式化
// 关键：行内代码与链接先生成 HTML 并换成占位符，避免它们的下划线被斜体、
// 星号被粗体规则误吃（典型 bug：target="_blank" 变成 target="<em>blank"）
function mdInline(src) {
  let s = mdEsc(src);
  const keep = [];
  const hold = (html) => MD_TOK + (keep.push(html) - 1) + MD_TOK;

  // 1) 行内代码
  s = s.replace(/`([^`\n]+)`/g, (m, c) => hold('<code class="ic">' + c + "</code>"));

  // 2) 链接：只放行 http(s) / mailto，杜绝 javascript:
  s = s.replace(/\[([^\]\n]*)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (m, t, u) => hold('<a href="' + mdUrl(u) + '" target="_blank" rel="noopener noreferrer">' +
      t + "</a>"));
  // 3) 裸链接
  s = s.replace(/(^|[\s(（])((?:https?:\/\/)[^\s<>"')\]]+)/g,
    (m, pre, u) => pre + hold('<a href="' + mdUrl(u) +
      '" target="_blank" rel="noopener noreferrer">' + u + "</a>"));

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
