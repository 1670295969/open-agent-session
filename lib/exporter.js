// 会话导出为 Markdown
const { parseSession } = require("./parsers");

async function exportMarkdown(s) {
  const msgs = await parseSession(s.file, s.tool);
  const lines = [
    `# ${s.title}`, "",
    `- agent: **${s.tool}**  id: \`${s.id || ""}\``,
    `- cwd: \`${s.cwd || ""}\`  来源: \`${s.file}\``, "",
  ];
  for (const m of msgs) {
    const who = m.role === "user" ? "🧑 用户" : "🤖 助手";
    lines.push(`## ${who}  (${String(m.time).slice(0, 19).replace("T", " ")})`);
    // 思考过程放进折叠块：导出文件里默认收起，点开才看，和页面行为一致
    if (m.think) {
      lines.push("<details><summary>💭 思考过程</summary>", "", m.think, "", "</details>", "");
    }
    if (m.text) lines.push(m.text);
    // 工具调用：摘要一行 + 完整命令折叠块（与页面一致，点开才看）
    if (m.tool) lines.push(`> 工具: \`${m.tool}\``);
    if (Array.isArray(m.toolFull) && m.toolFull.length) {
      for (const f of m.toolFull) {
        lines.push("", "<details><summary>⚙ " + f.name + " 完整命令</summary>", "",
          "```bash", f.body, "```", "", "</details>");
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// 文件名清洗：保留 ASCII 可读字符，压掉多余下划线
function exportFilename(title, tool) {
  const cleaned = String(title || "").replace(/[^\w.-]/g, "_").slice(0, 40)
    .replace(/_+/g, "_").replace(/[^\x20-\x7E]/g, "");
  return `${tool}-${cleaned || tool}.md`;
}

module.exports = { exportMarkdown, exportFilename };
