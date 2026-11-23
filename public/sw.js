// Service Worker —— 只为让 Chrome 把本页认成可安装的 Web App
//
// 为什么必须有它：Chrome 判定「可安装」要求 manifest + 一个带 fetch 的
// service worker（旧版要求，现在放宽了，但有 SW 更稳）。没有 SW 时
// 「固定到任务栏」只会得到一个 chrome.exe 的网站快捷方式，图标是 Chrome 的。
//
// 刻意**不缓存任何东西**：本工具展示的是实时会话数据，缓存会导致看到过期列表。
// 纯粹透传网络请求。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // 什么都不做，让浏览器走默认网络请求
});
