#!/usr/bin/env node
// Session Viewer — 聚合查看/恢复 Codex CLI、Claude Code、Pi、Hermes 的历史会话
// 用法: node agenthist-server.js  然后浏览器打开 http://localhost:8347
//
// 代码结构：
//   lib/config.js           常量与路径
//   lib/utils.js            通用工具函数
//   lib/scanners/*.js       四家会话目录扫描
//   lib/parsers/index.js    会话正文解析（统一消息结构）
//   lib/sessions.js         聚合 + 缓存
//   lib/terminal.js         终端启动（恢复 / 新建，含 sandbox DBus 修复）
//   lib/embed/              页面内恢复（SSE + 各工具适配器）
//   lib/models.js           模型 / 思考强度目录
//   lib/exporter.js         Markdown 导出
//   lib/router.js           HTTP 路由
//   lib/static.js           静态资源服务
//   public/                 前端（index.html / app.css / js/*）
const http = require("http");
const { PORT } = require("./lib/config");
const { handle } = require("./lib/router");
const { openUrl } = require("./lib/platform");

const server = http.createServer(handle);

// 尝试自动打开浏览器（平台差异收在 platform.openUrl 里）
// AGENTHIST_NO_BROWSER=1 时不弹窗——被 systemd / 启动项常驻拉起时用，用户自己点图标打开
function openBrowser() {
  if (process.env.AGENTHIST_NO_BROWSER === "1") return;
  openUrl(`http://localhost:${PORT}`);
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Session Viewer: http://localhost:${PORT}`);
  openBrowser();
});
