// 全局配置与常量
const os = require("os");

const HOME = os.homedir();
const PORT = Number(process.env.AGENTHIST_PORT) || 8347;

// codex 注入型 user 消息（非真人输入），实测前缀列表
const INJECT_PREFIXES = [
  "<skills_instructions", "<user_instructions", "<environment_context",
  "<turn_context", "# AGENTS.md instructions", "<ENVIRONMENT",
  "# GitHub MCP preference", "<permissions", "<app_context",
];

// 单条消息最大字符数，超出截断（防界面卡死）
const MAX_MSG_CHARS = 20000;
// 会话标题最大长度
const MAX_TITLE_CHARS = 120;
// 无对话正文的空壳会话的显示标题
const EMPTY_TITLE = "(空会话 · 无对话内容)";
// 会话列表缓存时长
const SESSION_CACHE_MS = 5000;
// 模型目录缓存时长
const MODEL_CACHE_MS = 10 * 60 * 1000;
// 页面内恢复单次运行超时
const EMBED_TIMEOUT_MS = 10 * 60 * 1000;

module.exports = {
  HOME, PORT, INJECT_PREFIXES,
  MAX_MSG_CHARS, MAX_TITLE_CHARS, EMPTY_TITLE,
  SESSION_CACHE_MS, MODEL_CACHE_MS, EMBED_TIMEOUT_MS,
};
