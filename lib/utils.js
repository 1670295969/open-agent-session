// 通用工具函数（无业务语义）
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { INJECT_PREFIXES, MAX_TITLE_CHARS } = require("./config");

// 递归收集目录下的 .jsonl 文件（限深 6 层）
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// 逐行读取文本文件，最多 maxLines 行
function readLines(file, maxLines = Infinity) {
  return new Promise((resolve) => {
    const lines = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    rl.on("line", (l) => {
      lines.push(l);
      if (lines.length >= maxLines) { rl.close(); rl.removeAllListeners("line"); }
    });
    rl.on("close", () => resolve(lines));
    rl.on("error", () => resolve(lines));
  });
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

// 压缩空白并截断到 n 字符
function firstText(s, n = 90) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  return s.slice(0, n) + (s.length > n ? "…" : "");
}

// 从 content（字符串或 OpenAI 风格块数组）提取纯文本
function textFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && ["text", "input_text", "output_text"].includes(b.type) && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
  return "";
}

// 是否为 codex/CLI 注入的非真人消息
function isInject(t) {
  return INJECT_PREFIXES.some((p) => t.startsWith(p));
}

// pi 时间戳可能是毫秒数或 ISO 字符串，统一转 ISO
function isoTs(ts) {
  if (ts == null) return "";
  if (typeof ts === "string") return ts;
  const n = Number(ts);
  if (!isFinite(n)) return "";
  return new Date(n).toISOString();
}

// 标题清洗：去空白、截断
function cleanTitle(s, fallback = "") {
  const t = String(s || fallback).replace(/\s+/g, " ").trim();
  return t.slice(0, MAX_TITLE_CHARS);
}

module.exports = {
  walk, readLines, tryJson, readJsonFile, firstText,
  textFromContent, isInject, isoTs, cleanTitle,
};
