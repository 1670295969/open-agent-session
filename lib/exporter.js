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
    if (m.text) lines.push(m.text);
    if (m.tool) lines.push(`> 工具: \`${m.tool}\``);
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
