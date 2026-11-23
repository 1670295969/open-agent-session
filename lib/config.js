// 全局配置与常量
const os = require("os");

const HOME = os.homedir();
const PORT = Number(process.env.OPENSESSION_PORT) || 8347;

// codex 注入型 user 消息（非真人输入），实测前缀列表
const INJECT_PREFIXES = [
  "<skills_instructions", "<user_instructions", "<environment_context",
  "<turn_context", "# AGENTS.md instructions", "<ENVIRONMENT",
  "# GitHub MCP preference", "<permissions", "<app_context",
];

// dsh（DeepSeek Harness）的注入内容，是 `[...]` 包裹的中括号块，
// 与上面 codex 的尖括号前缀不是一套，用正则单独处理。
//
// 注意 OUT-OF-BAND 是**成对**标记（首尾各一个），不是单向前缀：
//   [OUT-OF-BAND USER MESSAGE — …说明文字]\n真正的用户输入\n[/OUT-OF-BAND USER MESSAGE]
// 只剥开头的 `^` 正则会在正文尾部留下 `[/OUT-OF-BAND USER MESSAGE]`，所以这里
// 用不加锚定的配对剥离（见 parsers/index.js 的 dshStrip），这四条只列名字供生成正则。
const DSH_INJECT_BLOCKS = [
  "OUT-OF-BAND USER MESSAGE",
  "CONTEXT COMPACTION",
  "PRIOR CONTEXT",
  "IMPORTANT: Background process",
];

// 单向前缀型注入（只出现在开头）
const DSH_INJECT_PATTERNS = [
  /^\[Workspace::v\d+:[^\]]*\]\s*/,   // 每条会话首条消息的 cwd 前缀
];

// 「整条丢弃」型注入：上下文压缩 / 历史交接摘要。
// 它们会以 assistant/message 的身份出现，长度 15–28KB，通篇是给模型看的指令
// （"不要在摘要里找问题"、"只回答摘要之后的用户消息"…），不是对用户的回答。
// 界面上显示出来就是一大坨英文说明，把真正的对话挤走，所以整条丢掉。
// 原文仍在会话文件里，需要时用编辑器/zstd -dc 看得到。
const DSH_DROP_PATTERNS = [
  /^\[CONTEXT COMPACTION/,
  /^\[PRIOR CONTEXT/,
  /^\[STILL IN PROGRESS/,
  /^Earlier turns were compacted into the summary below/,
];

// 单条消息最大字符数，超出截断（防界面卡死）
const MAX_MSG_CHARS = 20000;
// 单条思考内容最大字符数。思考普遍比正文长（实测单块最长 56290 字符、
// 单会话累计 774KB），但与本项目「正文不分页、全量渲染」的取向一致，
// 这里给到和正文同一档上限，只在极端长的单块上截断。
const MAX_THINK_CHARS = 20000;
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
  HOME, PORT, INJECT_PREFIXES, DSH_INJECT_PATTERNS, DSH_INJECT_BLOCKS, DSH_DROP_PATTERNS,
  MAX_MSG_CHARS, MAX_THINK_CHARS, MAX_TITLE_CHARS, EMPTY_TITLE,
  SESSION_CACHE_MS, MODEL_CACHE_MS, EMBED_TIMEOUT_MS,
};
