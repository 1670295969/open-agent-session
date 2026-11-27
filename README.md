# OpenSession

**Open** + **Session**：把散落各处的 agent 会话**打开**看，再把旧会话**打开**接着聊。

聚合查看 / 恢复 **Codex CLI**、**Claude Code**、**Pi**、**DeepSeek Harness（dsh）**、**Hermes** 的历史会话。

**当前形态：纯网页版**（浏览器大窗口，窗口自由缩放）。**Linux / macOS / Windows 三平台支持。**

仓库地址：<https://github.com/1670295969/open-agent-session>

> 📖 **只是想用它？读 [使用文档](docs/USAGE.md)** —— 安装、界面、恢复、新建、删除、排错，按操作场景组织。
> 本 README 记录的是实现细节、跨平台差异和踩坑，面向要改代码的人。

```bash
node opensession-server.js          # 默认 8347
OPENSESSION_PORT=9000 node opensession-server.js
OPENSESSION_NO_BROWSER=1 node opensession-server.js   # 不自动开浏览器（被常驻服务拉起时用）
```

零依赖，不装 npm 包，只用 Node 内置模块。

## 平台支持

同一套代码在 Linux / macOS / Windows 上跑，差异集中在 `lib/platform.js` 与三组 `*-linux.js` / `*-mac.js` / `*-win.js` 文件里，业务代码（扫描 / 解析 / 路由 / 前端）完全共用。

| 能力 | Linux | macOS | Windows |
|---|---|---|---|
| 会话扫描 / 正文解析 / 导出 | ✅ | ✅ | ✅ |
| Markdown 渲染 / 自适应宽度 / 刷新 | ✅ | ✅ | ✅ |
| 删除会话（进回收站，可还原） | ✅ freedesktop `~/.local/share/Trash` | ✅ `~/.Trash`（废纸篓） | ✅ 系统回收站（Shell API） |
| 页面内恢复（SSE 流式） | ✅ | ✅ | ✅ |
| 页面内新建会话（不弹终端） | ✅ codex / claude / pi | ✅ | ✅ |
| 终端恢复 / 新建会话 | ✅ gnome-terminal 等 | ✅ `.command` + 默认终端 | ✅ cmd.exe（Win11 可落到 Windows Terminal） |
| 开机自启 | ✅ systemd user unit + linger | ✅ launchd LaunchAgent | ✅ 启动文件夹快捷方式 |
| 桌面快捷方式 | ✅ `.desktop`（GNOME 需标记 trusted） | ✅ `.app` 包（内嵌 `.icns`） | ✅ `.lnk`（内嵌 `.ico` 图标） |
| 固定到左侧导航栏 / Dock | ✅ `gsettings favorite-apps` | ❌ 只能手动拖进 Dock | ❌ 无对应机制 |

**安装**

```bash
# Linux
./install.sh              # 服务 + 自启 + 桌面图标 + 左侧栏固定
./install.sh --status
./install.sh --uninstall

# macOS
./install-mac.sh          # LaunchAgent + 桌面 .app + 图标
./install-mac.sh --status
./install-mac.sh --uninstall

# Windows（PowerShell）
powershell -ExecutionPolicy Bypass -File .\install.ps1   # 桌面快捷 + 开机自启 + 立即启动
.\install.ps1 -Status
.\install.ps1 -Uninstall
.\install.ps1 -NoAutoStart     # 不设自启
.\install.ps1 -NoDesktop       # 不建桌面快捷
```

Windows 侧刻意不写系统目录、不改 HKLM、不注册系统服务：常驻靠当前用户的启动文件夹，卸载就是删两个 `.lnk` 加一个 `%USERPROFILE%\.opensession` 目录，用户也能在「任务管理器 → 启动」里自己关掉自启。

macOS 侧同样不写系统级目录：常驻是当前用户的 `~/Library/LaunchAgents`，卸载就是 `bootout` + 删两个 `.app` 和一个 plist，不留系统残留。

## 怎么打开

| 方式 | 命令 / 入口 |
|---|---|
| **左侧导航栏** | 点 dock 上的图标（已固定，与桌面图标同一入口）← 最快 |
| **桌面图标** | 双击桌面「OpenSession」 |
| 应用菜单 | 搜索 OpenSession |
| 命令行（独立窗口） | `opensession-open --app` |
| 命令行（普通标签页） | `opensession-open --tab` |
| 带筛选 | `opensession-open --app --tool=claude` / `--q=关键词` |
| 直接开浏览器 | `http://localhost:8347` |

`opensession-open` 会自动探活，服务没起就先拉起来（优先 `systemctl --user start`，失败则直接起进程）。

### 窗口尺寸

默认 **1900×1150** 的独立 window（无地址栏，类原生应用）。要改：

```bash
OPENSESSION_WIN_W=1600 OPENSESSION_WIN_H=900 opensession-open --app
```

## 服务常驻（Linux）

**一键安装 / 修复**（幂等，可重复跑；WorkBuddy 升级后 node 路径会变，重跑即可自动修好）：

```bash
./install.sh              # 装服务 + 自启 + 桌面图标 + 左侧栏固定
./install.sh --status     # 只看状态，不改动
./install.sh --uninstall  # 撤销（保留数据与脚本）
```

装完是三层保障：

| 层 | 机制 | 作用 |
|---|---|---|
| 开机自启 | `~/.config/systemd/user/opensession.service`（enabled 软链） | 登录即起 |
| 免登录自启 | `loginctl enable-linger $USER` | 无人登录也常驻 |
| 崩溃自愈 | `Restart=on-failure` + `RestartSec=3` | 挂掉 3 秒后自动换 PID |

日常运维：

```bash
systemctl --user status opensession     # 看状态
systemctl --user restart opensession    # 重启（改过代码后）
systemctl --user stop opensession       # 停
journalctl --user -u opensession -f     # 跟日志
```

**服务入口是 `bin/opensession-service` 而不是直接写 node**，原因有两个：

1. node 路径含版本号（`.../versions/22.22.2/bin/node`），WorkBuddy 升级后旧路径消失，
   unit 会 ExecStart 失败。wrapper 里按「显式指定 → 任意 managed 版本 → PATH」顺序探测。
2. `DISPLAY` / `XAUTHORITY` 在 X11 / Wayland / 换 DM 下都不一样，写死进 unit 换环境即挂。

两个 wrapper 都会被复制到 `~/.local/bin` 供全局调用，所以**不能写死项目路径**：安装时把项目
目录记进 `~/.config/opensession/appdir`，脚本按「`OPENSESSION_HOME` → 自身相对位置 → 该记录」
三级回找。移动项目目录后重跑 `install.sh` 即可，或临时用 `OPENSESSION_HOME=/新路径` 覆盖。

## 桌面快捷方式

### Linux（`install.sh`）

`install.sh` 会装四样东西：

| 文件 | 作用 |
|---|---|
| `~/桌面/opensession.desktop` | 桌面图标（已打 `metadata::trusted`，双击即开） |
| `~/.local/share/applications/opensession.desktop` | 应用菜单里可搜索「OpenSession」 |
| `~/.local/share/icons/hicolor/scalable/apps/opensession.svg` | 自绘图标（渐变底 + 白色气泡，不依赖系统图标主题） |
| `org.gnome.shell favorite-apps` | 固定到左侧导航栏（Ubuntu dock 的收藏列表），排在 WorkBuddy 后面 |

取消固定：`./install.sh --uninstall` 会自动从导航栏摘掉；也可在图标上右键「从收藏夹中移除」。

> 坑：sandbox 里直接 `gsettings set` 会返回 0 但值不变（dconf 写入被拦，且 uid=0 写的不是当前用户的库）。
> 脚本走 `as_user` + 会话 bus 才真正落盘。另注意 `dock-position` 在 `XDG_CURRENT_DESKTOP` 为空/`Unity`
> 时会误读成 `BOTTOM`，只有 `ubuntu:GNOME` 才读到真实的 `LEFT`——判断方位前先对齐这个变量。

### Windows（`install.ps1`）

| 文件 | 作用 |
|---|---|
| 桌面 `OpenSession.lnk` | 桌面快捷方式，内嵌 `assets/opensession.ico`（7 种尺寸，小图标到大图标都清晰） |
| `%APPDATA%\...\Start Menu\Programs\Startup\OpenSession.lnk` | 开机自启（登录即起） |
| `%USERPROFILE%\.opensession\launch.vbs` | 隐藏窗口启动器：探活 → 起 node（无黑窗）→ 等就绪 → 开浏览器 |
| `%USERPROFILE%\.opensession\stop.vbs` | 停止后端（按命令行匹配 `opensession-server.js`，不误杀其它 node） |

另外 `bin/opensession-open.ps1` 是 Linux 版 `opensession-open` 的对应物：

```powershell
.\bin\opensession-open.ps1                 # 独立窗口
.\bin\opensession-open.ps1 -Tab            # 普通标签页
.\bin\opensession-open.ps1 -Tool claude    # 预置筛选
.\bin\opensession-open.ps1 -Q 关键词        # 预置搜索
.\bin\opensession-open.ps1 -Status         # 看状态
.\bin\opensession-open.ps1 -Stop           # 停后端
```

为什么用 `wscript` + `.vbs` 而不是 `.lnk` 直接指 `node.exe`：直接指 node 会弹一个常驻黑色控制台，
关掉它就杀掉服务。`.vbs` 里 `WScript.Shell.Run(cmd, 0, False)` 以隐藏窗口起 node，用户全程看不到控制台。

浏览器优先用 Chrome / Edge 的 `--app` 模式（无地址栏独立窗口，与 Linux 版一致）；
都找不到就退回默认浏览器标签页。

> 图标不是手画的：`tools/make-icon.py` 按 Linux 版 SVG 的同一套几何（渐变圆角底 + 白色气泡 + 两条粗横条）
> 用 PIL 重画，4× 超采样后逐级缩小做抗锯齿，最后把 16/24/32/48/64/128/256 打进一个 `.ico`。
> 要改配色改脚本里的常量重跑即可。**几何参数只在 `public/favicon.svg` 与 `make-icon.py` 两处**，
> 前者是唯一设计源，后者按同一套坐标重画位图；`install.sh` 直接 `cp` 那个 SVG，不再内嵌一份。
>
> 同一个脚本顺带导出 `public/icons/icon-{32,48,128,192,256,512}.png` 供 PWA 用。
> ⚠️ 这六张**只能由脚本生成**：它们曾被另一份代码用旧版几何（4 条细线 + 绿对勾 + 显示器底座）
> 画过一次，与桌面图标完全不是一张图，装成 App 后看到的是旧图。要改设计就改脚本重跑。

> 为什么 `install.ps1` 不注册系统服务：注册服务要管理员权限、写 HKLM，卸载容易留残留。
> 启动文件夹 + 一个 `.lnk` 已经够实现「登录即起」，而且用户能在「任务管理器 → 启动」里
> 自己关掉，卸载就是删两个 `.lnk` 加一个 `.opensession` 目录。

### macOS（`install-mac.sh`）

| 文件 | 作用 |
|---|---|
| 桌面 `OpenSession.app` | 桌面图标，内嵌 `assets/opensession.icns`（含 1024，Retina 大图标清晰） |
| `~/Applications/OpenSession.app` | 应用目录里的同一份，可在启动台/聚焦搜到 |
| `~/Library/LaunchAgents/com.opensession.viewer.plist` | 登录自启（`RunAtLoad`），崩溃 10 秒后重启（`KeepAlive.SuccessfulExit=false`） |
| `~/Library/Logs/opensession/opensession.err.log` | 服务日志（`tail -f` 可看） |
| `bin/opensession-service-mac` | 服务 wrapper：安装时生成，负责补 PATH、找 node、exec server |

`.app` 是**本机生成**的包（`Info.plist` + `MacOS/launch` + `Resources/opensession.icns`），
没有 quarantine 扩展属性，不需要签名或公证。`LSUIElement = true` 让启动器自己不在 Dock 留图标——
它的职责只是「探活 → 拉起 → 开浏览器 → 退出」，真正的窗口是 Chrome 的 `--app`。

为什么不把它做成 `install.sh` 的 Darwin 分支：两边的机制（systemd vs launchd、`.desktop` vs `.app`、
`gsettings` vs 无）几乎没有一行可共用，混在一个文件里只会更难读。`install.sh` 检测到 Darwin 时会直接
提示改用 `./install-mac.sh`。

> 图标同样不是手画的：`tools/make-icon.py` 现在同时产出 `.ico` / `.icns` / `.png`。
> `.icns` 是按 Apple 的容器格式手写的（`icns` magic + 若干 `OSType/长度/PNG` 块），
> 所以 Linux 上也能生成和校验，不必依赖只在 macOS 存在的 `iconutil`。

## 从另一台设备访问（SSH 隧道，2026-11-27）

服务入口写死 `server.listen(PORT, "127.0.0.1")`（`opensession-server.js:32`），这是**安全边界不是疏漏**：
`lib/router.js` 全链路没有任何鉴权，谁连上谁就能读全部会话、删会话、通过 `/api/embed` 在本机执行 CLI。

所以「另一台设备访问」的做法是**把端口借出去**，而不是把监听地址放宽：

```bash
# 客户端侧（另一台设备）
ssh -N -L 8347:127.0.0.1:8347 me@<服务端主机>
# 或者用仓库里的 tools/tunnel-client.sh，带参数校验和 keepalive
```

前端所有请求都是相对路径（`/api/...`、`js/*.js`，实测 `public/js/` 里没有硬编码 host），
所以隧道一透，整个界面就完整可用，**前端零改动**。反而比改监听更省事也更安全：浏览器看到的
仍是 `127.0.0.1`，属安全上下文，`navigator.clipboard` 与 `EventSource` 都不会降级
（`chat.js` 里那个 `fallbackCopy` 就是给非安全上下文兜底的）。

### 受限密钥：只给转发权，不给 shell

服务端可以在 `~/.ssh/authorized_keys` 里挂一条受限项：

```
restrict,port-forwarding,permitopen="127.0.0.1:8347",permitopen="localhost:8347",command="/bin/false" ssh-ed25519 AAAA... opensession-tunnel
```

几个**实测**出来的细节：

| 项 | 行为 |
|---|---|
| `restrict` 单独用 | 连端口转发一起禁掉。必须补 `port-forwarding` 才恢复转发，只恢复转发 |
| `permitopen` 匹配 | **字面**匹配，`localhost:8347` 与 `127.0.0.1:8347` 是两条，客户端写哪个都要能对上 |
| 越权转发 | 客户端侧**不会**报错（`-L` 是惰性建连），服务端在真正有连接进来时才回 `administratively prohibited: open failed` |
| `command="/bin/false"` | 带命令的 ssh 退出码 1、无输出 |
| `[::1]:8347` | 写了也不通——服务只监听 IPv4 回环，与配置无关 |

> 测试这一条要**真发一次 HTTP 请求**才触发建连，光看 `ssh` 进程活着判断不出是否被 `permitopen` 拦了。

NAT 之后的机器没有公网入口时，这条隧道**建立不起来**——这是网络条件，不是代码问题。
需要公网可达入口（端口映射或公网跳板机），或者换一条自带穿透的通道。

## 启动浏览器的三个坑（2026-11-22 实测）

1. **uid 必须是 1000**：WorkBuddy sandbox 在 user namespace 里把 uid 映射成 0，Chrome 直接报
   `Running as root without --no-sandbox is not supported` 起不来。`opensession-open` 检测到 uid 0 时
   自动套一层 `unshare --user --map-user=1000 --map-group=1000`。
2. **必须独立 user-data-dir**：用默认 profile 启 `--app` 会被已运行的 Chrome 实例吞掉，
   退化成普通标签页（静默，无报错）。脚本固定用 `~/.cache/opensession-chrome`。
3. **必须 `--disable-gpu`**：容器/root 环境 GPU 初始化崩（`exit_code=8704`、`MESA: Failed to query drm device`），
   不加会导致进程活着但没有窗口。

> 另外：从 WorkBuddy 的 Bash 会话里启动的 GUI 进程会随命令返回被清理掉。
> 日常请点**左侧导航栏图标**或**桌面图标**，那是在你自己的桌面会话里跑，不受这个限制。

## 重写历史为什么删不干净（2026-11-27 实测）

`git filter-branch` 改完作者信息、force push 之后，从远端仍能 `git fetch <旧SHA>` 拿到旧提交。
根因不在分支，而在 **GitHub 给已合并 PR 永久保留的 `refs/pull/N/head`**。

实测结论：

| 尝试 | 结果 |
|---|---|
| `git push origin --delete refs/pull/1/head` | `deny updating a hidden ref` |
| REST `DELETE /repos/…/pulls/1` | 404（**GitHub 没有删除 PR 的端点**） |
| GraphQL | 只有 `closePullRequest`，没有 `deletePullRequest` |
| 等 GitHub 自动 GC | 无效，只要 PR 在，ref 就一直在 |

**只要有一个提交是某个已合并 PR 的祖先，整条旧链就被这个 ref 撑着，永远可被匿名下载**——
包括 `GET /commit/<sha>.patch`，它会把 `From: 真实姓名 <公司邮箱>` 原样吐出来，不需要登录。

唯一的彻底解法是**删库重建**（`tools/rebuild-remote-repo.sh`）：

1. 网页 Settings → Danger Zone → Delete this repository
2. 新建同名空库（**不要**勾 README / .gitignore / license，否则多一个初始提交）
3. `bash tools/rebuild-remote-repo.sh <owner/repo>`

代价：star 数、创建时间、PR/issue 记录清零。所以**发布前先想清楚**——
一旦推了带真实邮箱的提交并开了 PR，再改就只剩删库这条路。

> 顺带两个坑：① 细粒度 PAT 不能建个人仓库、也改不了仓库设置（403），
> 删库建库这类操作必须用经典 token（勾 `repo` + `delete_repo`）或网页手动做；
> ② 删库前务必确认能建回来——`POST /user/repos` 先用一次性库试，别删完才发现没权限。

## 目录结构

```
opensession/
├── opensession-server.js   入口：起 HTTP 服务 + 自动开浏览器
├── opensession-cli.py      早期 Python 原型（已废弃，不被任何代码引用，仅作历史留存）
├── opensession-web.py      同上：Python 原型时代的 Web 版
├── install.sh              Linux 安装（systemd + .desktop + 左侧栏固定）
├── install-mac.sh          macOS 安装（launchd LaunchAgent + .app + .icns）
├── install.ps1             Windows 安装（启动文件夹 + .lnk + 隐藏窗口启动器）
├── push-to-github.sh       一键推送（自动选 SSH(443)/HTTPS，见文件头注释）
├── LICENSE                 MIT
├── assets/
│   ├── opensession.ico         Windows 图标（16→256 七种尺寸）
│   ├── opensession.icns        macOS 图标（icp4…ic10，含 1024）
│   └── opensession-256.png     文档用大图
├── tools/
│   ├── make-icon.py            从零生成 ico / icns / png（PIL，4× 超采样抗锯齿）
│   ├── tunnel-client.sh        客户端侧 SSH 隧道脚本（另一台设备访问本机用，见下节）
│   └── rebuild-remote-repo.sh  删库重建后重推干净历史（发布前体检 + 远端复查）
├── bin/
│   ├── opensession-service     服务 wrapper：探测 node、补 PATH 与运行时环境、exec server
│   ├── opensession-open        开窗口：探活 → 拉起 → Chrome 独立大窗口（Linux）
│   └── opensession-open.ps1    同上，Windows 版（Chrome/Edge --app）
├── lib/
│   ├── config.js               常量（端口、缓存时长、超时、注入前缀）
│   ├── platform.js             平台差异层：命令定位（PATHEXT）、.cmd 转发、开 URL
│   ├── utils.js                通用工具（walk / readLines / 文本提取 / 标题清洗）
│   ├── cwd.js                  工作目录归一化（`~` / 相对路径 / 尾斜杠）+ 存在性校验
│   ├── static.js               静态资源服务（public/ 下的 html、css、js）
│   ├── router.js               HTTP 路由表（/api/*）
│   ├── sessions.js             会话聚合 + 5 秒缓存
│   ├── search.js               全文搜索：跨会话搜正文 + 思考，按 mtime+size 缓存解析结果
│   ├── trash.js                删除：路径白名单校验（跨平台共用）+ 平台分派
│   ├── trash-linux.js          freedesktop 回收站实现
│   ├── trash-mac.js            macOS 废纸篓（~/.Trash）实现
│   ├── trash-win.js            Windows 系统回收站实现（Shell API）
│   ├── models.js               模型 / 思考强度目录（10 分钟缓存）
│   ├── exporter.js             Markdown 导出
│   ├── fileview.js             本地文件预览：路径解析（含 :行号）、按行取窗口、编辑器定位
│   ├── terminal.js             终端启动统一入口（命令模板 + 平台选择）
│   ├── terminal-linux.js       Linux：终端候选 + sandbox DBus 修复 + /proc 探环境
│   ├── terminal-mac.js         macOS：写 .command + open（跟随默认终端）
│   ├── terminal-win.js         Windows：start + 临时 .cmd（绕开引号转义）
│   ├── scanners/                五处会话目录扫描
│   │   ├── claude.js               ~/.claude/projects/**/*.jsonl
│   │   ├── codex.js                ~/.codex/sessions/**/*.jsonl
│   │   ├── pi.js                   ~/.pi/agent/sessions/**/*.jsonl
│   │   ├── dsh.js                  ~/.dsh/sessions/**/session.v4.jsonl.zstd（多帧 zstd）
│   │   └── hermes.js               ~/.hermes/webui/sessions + ~/.hermes/sessions
│   ├── zstd.js                  多帧 zstd 解压（Node 内置只解第一帧，见下文）
│   ├── parsers/
│   │   └── index.js                正文解析 → 统一消息结构 {role,time,text,tool,think,toolFull?}
│   └── embed/                   页面内会话（恢复 / 新建，SSE 流式）
│       ├── index.js                SSE 骨架 + 子进程生命周期
│       └── adapters/            各工具的参数拼装与输出解析
│           ├── claude.js               stream-json 逐行解析 text 块
│           ├── codex.js                prompt 走 stdin（`-`），stdout 直接转发
│           ├── pi.js                   按行流式（防 UTF-8 截断）
│           └── dsh.js                  NDJSON：session / text / status / final，消息走 stdin（`-`）
└── public/                      前端
    ├── index.html               骨架
    ├── app.css                  样式
    ├── favicon.svg              图标的唯一设计源（桌面/ICO/ICNS/PWA 全从这里派生）
    ├── manifest.webmanifest     PWA 清单：装成独立 App 时用
    ├── sw.js                    service worker，不缓存任何内容（只为满足可安装条件）
    ├── icons/                   icon-{32,48,128,192,256,512}.png，由 tools/make-icon.py 生成
    └── js/
        ├── state.js             全局状态 + 格式化工具（含平台相关文案）
        ├── md.js                轻量 Markdown 渲染（零依赖，先转义再解析）
        ├── list.js              左侧列表：筛选、统一分页、分组渲染、全局刷新
        ├── search.js            全文搜索：模式切换、防抖、结果片段、命中定位
        ├── del.js               删除：确认弹窗、多选批量、回收站交互
        ├── chat.js              右侧正文：Markdown 消息渲染（全文不分页）、顶部操作
        ├── peek.js              文件预览弹窗：文本 / 图片 / 目录、行号定位、编辑器打开
        ├── embed.js             页面内会话：输入栏、自绘下拉、SSE 收发、页面内新建
        ├── outline.js           提问导航（大纲）：只列用户提问，点击/Alt+↑↓ 跳转
        ├── newmodal.js          新建会话弹窗（终端 / 页面内两条路径）
        └── main.js              入口装配（含 ?tool=&q=&full= 预置筛选、平台信息拉取）
```

## 响应式：手机 / 平板（2026-11-27）

原先侧栏写死 `width: 400px; min-width: 280px`，CSS 里**一个尺寸断点都没有**。
实测 390px 手机上 `#side` 直接吃满整屏，`#main` 被挤到 `width: 0`，
且 `scrollWidth 417 > clientWidth 390` 出现横向滚动条 —— 正文完全不可见。

三档设计（`public/app.css` 末尾）：

| 断点 | 做法 |
|---|---|
| `≥901px` | 原样不动（桌面零回归是硬要求） |
| `641–900px` | 侧栏 `400→280`，`#stats` 降两列，顶栏 `info` 独占一行 |
| `≤640px` | 抽屉式：列表全屏，`#main` `position:fixed` + `translateX(100%)`，选中会话时 `html.m-view` 让它滑入 |

几个必须知道的点：

- **`html.m-view` 挂在根节点**，理由和 `.side-collapsed` 一样：`#main` 内容反复整体重绘，
  状态类放在比它高的节点才不会被冲掉。
- **手机档复用已有的折叠机制**：`html.side-collapsed` 在 `≤640px` 下被强制复位
  （`margin-left: 0`），否则桌面留下的折叠偏好会让列表也不可见。
- **跨档缩放两个方向都要处理**，只做一边会留 bug：
  手机→桌面若不 `applyMobileView(false)`，`translateX(0)` 残留但 CSS 已不 `fixed`，正文盖住列表；
  桌面→手机若不回落到列表态，`#main` 立刻被推出屏外，用户看到「点了会话正文不见了」（实测 `mainLeft=390`）。
- **`code.ic` 加 `overflow-wrap:anywhere`**：`white-space:break-spaces` 只管空格，
  长命令 `adb logcat -v threadtime -s WakeFirstFrame...` 实测撑到 447px 被裁。
- **🔴 表格千万别加 `display:block`**：那会打回块级布局，单元格失去宽度约束，
  配上 `anywhere` 后 `first_window_frame_after_display_on` 被折成每行 5 个字符。
  正确做法是 `.tablewrap` 已有的 `overflow-x:auto` + 单元格 `nowrap`。
- **`#backbtn` 只在 `≤640px` 且 `m-view` 时 `display:inline-block`**，
  桌面/平板的 DOM 里有这个节点但 `display:none`，不影响顶栏按钮换行节奏。
- `body { height: 100dvh }` 兜 iOS 地址栏吃高度；`-webkit-overflow-scrolling:touch` 给抽屉滑动加惯性。

验证覆盖 360 / 390 / 414 / 768 / 834 / 1024 / 1280 / 1440 / 1920 九档：
全部 `scrollWidth === clientWidth`（无横滚）、0 控制台错误、返回键显隐符合预期。

## 正文渲染与刷新

**Markdown**：正文默认走 `public/js/md.js` 渲染（零依赖，不引 CDN，断网可用）。支持标题、粗体 / 斜体 / 删除线、行内代码、围栏代码块（右上角带复制按钮）、有序 / 无序列表（可嵌套）、引用、表格（含列对齐）、分隔线、链接。

安全做法是**先整体转义 HTML，再解析 Markdown 语法**，且链接只放行 `http(s)` / `mailto`，所以会话正文里的 `<script>`、`onerror=`、`javascript:` 都只会当文本显示。代码块与链接的 HTML 用占位符暂存，避免 `target="_blank"` 里的下划线被斜体规则误伤。

顶栏的 `M↓ Markdown` 按钮可一键切回纯文本（保留原始换行缩进），方便看被误解析的原始内容。

顶栏的 `⚙ 命令` 按钮控制正文里是否铺出工具调用（默认关闭，按钮上的数字是调用次数）。工具调用默认不渲染是 2026-11-25 的改动，原因与实现见下面「工具调用折叠」。

**刷新**：两处。

| 位置 | 作用 |
|---|---|
| 左上标题栏 `↻` | 重取会话列表，同时重读当前打开的会话；会话若已被外部删除会提示并回到空白页 |
| 正文顶栏 `↻ 刷新` | 只重读当前会话文件，保留所在页码 |

## 新建会话：两条路径

弹窗（`＋ 新建会话`）里有三个字段：工具、工作目录、第一条消息。底部两个按钮对应两种创建方式：

| 按钮 | 行为 | 适用 |
|---|---|---|
| **⚡ 页面内创建** | 不弹终端，本页里直接跑第一条消息；跑完自动把这个新会话接进列表并打开，可以接着在输入栏里继续聊 | codex / claude / pi / dsh |
| **启动终端** | 打开系统终端跑交互式 CLI，之后的对话在终端里进行 | 五家都行（含 hermes） |

页面内创建时「第一条消息」必填——CLI 的 `-p` / `exec` 是一次性调用，没有 prompt 起不来。终端方式会忽略该字段。

hermes 会话是只读存储，没有页面内适配器，选中它时「页面内创建」自动禁用并给出原因。

### 三家 CLI 各自的「新建」方式

都是实测确认的，差异不小：

| 工具 | 命令 | 怎么拿到新会话 id |
|---|---|---|
| claude | `claude -p --output-format stream-json --verbose --session-id <uuid>` | uuid 由服务端生成后显式传入；`system/init` 事件也会回带，用作兜底 |
| codex | `codex exec --json --skip-git-repo-check -` | 必须加 `--json`：纯文本模式没有 id；JSONL 首行 `thread.started.thread_id` 就是 |
| pi | `pi --session <指定文件路径> -p` | 文件路径自己指定，id 从文件名尾部 uuid 取 |

落盘后按 id 反查文件：claude 在 `~/.claude/projects/**/` 找 `<uuid>.jsonl`；codex 在 `~/.codex/sessions/**/` 找文件名含 thread_id 的 `rollout-*.jsonl`；pi 路径本来就是自己给的。CLI 退出与文件写完之间有延迟，所以轮询约 10 秒（间隔递增退避，不是固定 100ms —— codex/claude 的 `locate()` 是 walk 整个 sessions 目录，定频扫纯属浪费）。等不到也照常把 id 返回，前端会再补偿重试一轮，最后给出「已创建但列表待同步」的可操作收尾。

### 工作目录校验（两种创建方式一致）

- **新建**：目录必须真实存在且是目录，否则直接报「工作目录不存在或不是目录：xxx」，**不会**退回 `$HOME` 静默建会话。目录打错却毫无提示、把会话建到用户没指定的地方，比报错更糟。
- **恢复**：目录可能已被外部删除，此时退回 `$HOME`，让 CLI 至少能起来。

路径统一先过 `lib/cwd.js` 的 `normalizeCwd()` 再校验。**`~` 是最容易踩的坑**：Node 的 `fs.statSync("~")` 不做 shell 展开，`~` 只是一个普通文件名，于是「填 `~` → 报目录不存在」看起来就像新建失败了。所以这里显式处理：

| 输入 | 解析成 |
|---|---|
| `~` / `~/` / `  ~  ` | `$HOME` |
| `~/work` | `$HOME/work` |
| `opensession` / `./docs`（相对路径） | `$HOME/opensession`（按**主目录**解析，不按进程 cwd —— 后者用户看不见） |
| `/a/b/` / `/a//b` | `/a/b`（尾斜杠与重复分隔符收敛；dsh 的会话目录名是 cwd 转义来的，`/a/b/` 与 `/a/b` 会得到两个不同目录） |
| `"/a/b"`（带引号） | `/a/b`（从终端复制路径常带引号） |
| `C:\Users\x` / `\\wsl\x` | 原样保留（非 POSIX 路径，交给存在性校验报错） |

解析后仍不存在时，错误提示会把「原写法 → 实际解析路径」一起回显，否则用户看到 `/home/you/opensession` 完全猜不到是我们按主目录展开了相对路径。

### 页面内创建的失败与并发行为

- 创建失败（CLI 报错 / 没回 id）时：徽标变红显示「未创建」，聊天区给出失败原因和下一步建议，不会留在「新建会话中」的假状态。
- 一次只允许一个创建流；重复点击提示「上一个会话还在创建中」。
- 创建期间如果用户点开了别的会话，跑完**不会**把他强行拽到新会话，只 toast 提示「已创建，可在左侧列表点开」。
- 页面内恢复同理：流没跑完就切走，回复仍写入原会话文件，但不会覆盖当前正在看的会话。

**pi 的会话目录名**不要按「非字母数字全换 `-`」去猜。实测规则是去掉首尾分隔符、把中间分隔符换成 `-` 再包一对 `--`：

```
/home/you/proj/x                                  → --home-you-proj-x--
/home/you/a/b.c/.tmp/pi-test                      → --home-you-a-b.c-.tmp-pi-test--
```

注意 `.` 原样保留（上面第二例的 `b.c` 没被换成 `b-c`）。按「非字母数字全换 `-`」算会
得到 `---home-you--a--...--` 这种多出前缀横线的目录，pi 自己以后扫不到。

### 为什么 codex 新建用 `--json`

`--json` 输出是事件流，粒度是「整条消息」而不是逐字增量：

```jsonl
{"type":"thread.started","thread_id":"01a20658-..."}
{"type":"item.completed","item":{"type":"error","message":"Codex is ignoring 1 unrecognized configuration setting..."}}
{"type":"item.completed","item":{"type":"agent_message","text":"你好"}}
{"type":"turn.completed","usage":{...}}
```

比恢复模式粗（恢复模式是纯文本逐字流），但能拿到 id，且边跑边显示。`item.type==="error"` 里有一类是配置告警（`Codex is ignoring ...`，本机 `~/.codex/config.toml` 里 `disable_response_storage` 已废弃就会连报两条），不影响本次回答，会以 `⚠` 抖在正文前面误导人，所以按前缀过滤掉了。

## DeepSeek Harness（dsh）

### 会话存储

```
~/.dsh/sessions/--<cwd 转义>--/session-<uuid>/session.v4.jsonl.zstd
                                              session.lock
```

一个会话是**一个目录**、里面两个文件：`session.v4.jsonl.zstd`（正文）和 `session.lock`。
目录级回收站就是为它加的（见「删除会话」）。

### 多帧 zstd：Node 内置只解第一帧

这是接 dsh 时最大的坑。dsh 每追加一批事件就往文件尾**压一个新帧**拼上去，所以一个
143KB 的文件里可能有 6 个独立帧。而 Node 的 `zlib.zstdDecompressSync` **只输出第一帧**：

```js
zlib.zstdDecompressSync(fs.readFileSync(f))   // 143768 B → 169 B（丢 99.9%）
zstd -dc f                                     // 143768 B → 718562 B（正确）
```

`decompressStream` 也一样，只吐第一帧就 end。所以 `lib/zstd.js` 自己按 RFC 8878 解析帧边界，
逐帧解压再 `Buffer.concat`。

帧头解析要点（按顺序读）：

| 字段 | 长度 | 说明 |
|---|---|---|
| Magic | 4 | `28 B5 2F FD`；`50 2A 4D 18`–`5F 2A 4D 18` 是可跳过帧（skippable frame） |
| Frame_Header_Descriptor | 1 | bit7-6 FCS 长度标志、bit5 singleSegment、bit2 是否带 checksum、bit1-0 字典 ID 长度 |
| Window_Descriptor | 0/1 | singleSegment=1 时不存在 |
| Dictionary_ID | 0/1/2/4 | 由 FHD bit1-0 决定，本场景恒为 0 |
| Frame_Content_Size | 0/1/2/4/8 | 由 FHD bit7-6 与 singleSegment 组合决定 |
| Block 循环 | — | 每块 3 字节小端头：bit0 last、bit1-2 type、bit3-23 size |

**Block 的 RLE 例外**：`type=1` 时 `Block_Size` 是**解压后**长度，但块内实际只有 **1 字节**数据。
指针按 `size` 前进会立刻跑到帧外，表现为「第二帧 magic 对不上」。正确前进量是 `type===1 ? 1 : size`。
这个 bug 一开始让我以为多帧解析失败，实际是 RLE 块算错。

**尾巴容错**：会话是追加写的，末尾常留半个帧。解析失败就停在最后一个成功位置，
已解出的内容照常返回——不能因为尾巴不完整就让整条会话读不出来。

验证方式：把 `decompressAll` 的结果与 `zstd -dc` 的输出做 `Buffer.equals` 比对，29/29 逐字节一致。

### 思考过程（thinking / reasoning）

统一消息结构里的 `think` 字段。各家存法不同，提取位置也不同：

| 工具 | 位置 | 备注 |
|---|---|---|
| claude | `message.content[].type === "thinking"` → `.thinking` | 最完整 |
| pi | 同上 | 历史会话完整；**实时流拿不到**（见下节） |
| hermes | `message.reasoning_content` | 推理模型才有 |
| codex | `payload.reasoning.summary[].text` | `content` 是加密的（`encrypted_content`），实测 2160 条 reasoning 里 0 条可读 content；`summary` 只有要点，中位数 35 字 |
| dsh | `message.content[].type === "reasoning"` → `.text` | 明文完整。**2026-11-23 更正**：早前记为「dsh 没有」是错的，那次只抽查了没开思考强度的会话 |
| claude（旧版） | 正文里的 `<think>…</think>` 标签 | 早期 CLI 把思考直接写进 text 块，新版本不再这样写，但老会话不会重写。见下方第 0 条 |

四个实现点：

0. **内联 `<think>` 标签要先剥**（`stripInlineThink`）。不剥的话页面上会直接显示
   `<think>` 字样，那一大段英文推理被当成正文，把真正的回答挤到下面。
   🔴 **标签会跨消息**：实测 58 条含标签的消息里只有 8 条成对闭合，其余是
   「这条结尾开、下一条才关」，所以状态必须跨消息携带（`state.inThink`），
   不能逐条独立判定。也有孤立 `</think>` 自成一条消息的情况，直接丢弃整条。
   标签名有 `<think>` / `<thinking>` 两种写法。
1. **纯思考消息要合并**。claude / pi 常把「只想不答」的 assistant 写成独立一行
   （实测 claude 1436 条含 thinking 的消息里有 871 条没有 text 也没有 tool）。
   直接铺开就是一堆空壳卡片，所以 `mergeThink()` 把它们攒起来并到**后面第一条**
   有正文或工具的 assistant 上（时序上思考在前、回答在后）。后面紧跟用户提问因而
   并不过去的，才留作独立的折叠卡片，内容不丢。
2. **前端用原生 `<details>`**，默认没有 `open` 属性 = 默认折叠。不用自绘，
   键盘和读屏天然可用，展开状态也不用自己维护。
3. **思考单独限长**（`MAX_THINK_CHARS = 20000`，与正文同档）。实测单块最长
   56290 字符、单会话累计 774KB；不做上限会让 `/api/session` 响应过大。

⚠️ 折叠时内容仍在 DOM 里，但浏览器内查找（`window.find`）**搜不到**，
必须展开后才能命中——注释里别写成「Ctrl+F 能搜到」，这是实测否掉的。

### 页面内实时思考（2026-11-23）

历史会话的思考是折叠的；**页面内实时对话时反过来 —— 思考块边收边写、默认展开，
流结束后自动收起成一行摘要**。这个差异是有意的：等待期间用户需要看见"它在想什么"。

后端多一条 SSE 通道 `{t:"think", s}`，与正文的 `{t:"delta", s}` 严格分开。
混在一条通道里，思考内容就会被当成正式回答渲染出来，所以各 adapter 都走
`ctx.emitThink()`，绝不能用 `ctx.emit()`。

四家实时能给的东西差别很大（2026-11-23 全部实测，`node` 直接跑 adapter 验证）：

| 工具 | 实时思考 | 细节 |
|---|---|---|
| claude | ✅ 完整明文 | `assistant.message.content[]` 里 `{type:"thinking",thinking:"…"}`，无需额外参数 |
| dsh | ✅ 完整明文 | `{"type":"thinking","text":"…"}` 一行一增量 |
| codex | ⚠️ 只有一句摘要标题 | 必须加 `-c model_reasoning_summary=detailed`；给的是 `{"item":{type:"reasoning","text":"**Checking server…**"}}`，完整思维链留在服务端。**还不是每轮都有**：一句话能答完的简单提问常常一条都不吐 |
| pi | ❌ 拿不到 | 有 `thinking_start/end` 事件，但 `thinking` 恒为空串，真内容在 `thinkingSignature.encrypted_content` 里（加密）。代码已接住非空值，换 provider 可能就是明文 |

🔴 **codex 恢复模式从纯文本改成了 `--json`**。原先是纯文本直通、正文逐字流式；
但纯文本模式完全不吐 reasoning，codex 会话就永远没有思考。实测
`codex exec resume --json <id> -` 回带的 thread_id 与原会话一致，可以安全切换。
代价是正文按 `item.completed` 整段到达、不再逐字出现 —— 别误判成"流式坏了"。

前端实现（`public/js/embed.js`）：

- `ensureThinkBox()` **懒建**：只有真收到 think 增量才插 `<details>`，
  所以 pi 这种拿不到明文的工具不会多出一个空框。
- 收到 think 时**不能清空正文气泡**（`ensureThinkBox(bubble, live)` 传 live 进去）。
  实测 codex 会先到 `agent_message` 再到 reasoning，无脑清空会让已显示的正文闪没。
- `settleThink()` 收尾：一次性转 Markdown（流式期间是纯文本，边打字边解析会闪）、
  写字数、去掉 `live` 类、折叠。用户中途手动点过（`dataset.touched`）就不再自动折叠，
  尊重他的选择。
- `markSettled()` 必须同时摘掉**卡片**和**思考块**上的 `live` 类：
  卡片 `live` 是绿边框，思考块 `live` 是「· 进行中」的呼吸标记。漏摘会一直显示"正在跑"。
- 只有思考、没有正文时（模型想了但没答）：摘掉空正文气泡、**保留思考块**；
  两者都没有才删整张卡片。

### 正文解析

事件流是 JSONL，只取两类：

| 事件 | 取什么 |
|---|---|
| `user/message` | `data.content`，套 `dshStrip()` 去掉注入前缀；纯注入则丢弃 |
| `assistant/message` | `data.message.content` 里的 text 块与 `tool-call` 块 |

`step/start`、`turn/*`、`system/message`、独立的 `tool/call` 都是控制流或重复信息，跳过。

**注入前缀**（`DSH_INJECT_PATTERNS`，5 条）会被剥掉，否则每条用户消息开头都挂一段
`[Workspace::v1:…]` / `[OUT-OF-BAND…]`：

```
[Workspace::v1: /home/you/work]
[OUT-OF-BAND USER MESSAGE]
[CONTEXT COMPACTION …]
[PRIOR CONTEXT …]
[IMPORTANT: Background process …]
```

### 恢复与新建

| 场景 | 命令 |
|---|---|
| 终端恢复 | `cd <会话 cwd> && dsh --profile headless --session-id <session-uuid>` |
| 页面内恢复 | 同上，由 `lib/embed/adapters/dsh.js` 拉起，消息走 **stdin（`-`）** |
| 页面内新建 | `dsh --profile headless --json -`，从 `{type:"session",sessionId}` 拿 id |

**消息必须走 stdin，不能拼到命令行参数里**（2026-11-24 修正）。dsh headless 的位置参数就是任务文本，`-` 是它自己的 stdin 约定（`--help` 写着 "`-` reads stdin"）。原来把 message 直接 push 进 args，长消息撞内核单进程参数上限：实测 240KB 请求体 → `spawn E2BIG`，前端只看到「⚠ spawn E2BIG」。改走 stdin 后长度只受内存限制，和 claude/codex/pi 的传法也统一了。新建与 `--session-id` 恢复两条路径都实测支持 `-`。

**`cd` 不能省**：`dsh --session-id` 会校验会话记录的 cwd，不在原目录执行直接报
`session "…" was recorded in "<x>", not "<y>"`。所以扫描时 cwd 必须从首行 `session` 事件里读**原文**——
目录名 `--home-you-work--` 是转义过的，反解不回原路径（且 `/` → `-` 不可逆）。

**目录名转义规则**（与 pi 不同，别照抄）：cwd 去掉首尾 `/`，把中间的 `/` 换成 `-`，两头各加 `--`。
`/home/you/work` → `--home-you-work--`。`.` 原样保留。

新建参数不能和另三家互换：claude 用 `--session-id <uuid>`（服务端造）；codex 必须 `--json` 才有
`thread.started.thread_id`；pi 用 `--session <自定路径>`；dsh 用 `--session-id <已有 id>`，
新建时**不传**该参数、靠 `--json` 首行回带。

### 模型下拉为空

`lib/models.js` 里 `EFFORTS.dsh = []`、`modelCatalog.dsh = []`——dsh 的模型清单在
`~/.dsh/profiles/*.yaml` 里，为了不引 YAML 解析库（本项目零依赖），下拉留空，
前端遇到空数组自动隐藏。想指定模型直接在输入栏里用 `-m <name>` 或改 profile。

## 空会话（只有元数据、没有对话）

有些会话点开后一片空白，这不是解析 bug，文件里确实没有对话内容。典型例子：

```
codex resume --no-daemon 01a200f5-aaac-7f70-82a1-b25059212597
```

这个文件只有 4 行：

| 行 | 类型 | 内容 |
|---|---|---|
| 1 | `session_meta` | 会话元数据（cwd、模型、20KB 系统提示词） |
| 2 | `event_msg / task_started` | 任务开始 |
| 3 | `response_item / message (developer)` | `<turn_aborted>` 中断通知 |
| 4 | `event_msg / turn_aborted` | 中断原因 `interrupted`，持续 699ms |

**成因**：`codex exec` 启动后 0.7 秒就被中断，用户提问还没落盘。文件有 23KB 是因为 `session_meta` 里塞了 20KB 系统提示词，不是对话内容。

**识别方式**：扫描器在扫描时就地判断——读到 `user`/`assistant` 的非注入正文才算有内容；读满行数上限（400 行）还不确定时不标记为空，避免误判大文件。命中后：

- 列表标题显示 `(空会话 · 无对话内容)`，meta 行加虚框「空」标签
- 正文区显示解释卡片，说明原因和可选项（恢复会话 / 删除）

**验证**：129 条会话中标记 3 条为空，与实际解析结果逐条交叉比对，0 条误标。

注意 `claude` 扫描器的一个坑：`summary` 类型单独就能给出标题，所以提前退出条件必须是 `id && cwd && title && hasBody`。只判断前三个的话，"仅有 summary、无正文"的会话会被漏标成有内容。

## 列表去重：子代理转录与重复文件（2026-11-25）

现象：列表里同一个标题（如「你从哪判断的 acc 抖动」）连着出现三四条，时间不同、大小不同。

**根因有两个，都必须处理**：

### 1. 子代理转录被当成独立会话

| 工具 | 落盘位置 | 文件里的会话 id |
|---|---|---|
| claude | `~/.claude/projects/<proj>/<sessionId>/subagents/agent-*.jsonl` | 每行都带**父会话**的 `sessionId` |
| codex | `~/.codex/sessions/**/rollout-*.jsonl`，首条 `session_meta.payload.source.subagent` | `payload.session_id` = 父会话，`payload.id` = 自己 |

这些是主代理用 Agent 工具派出去干活的分身，产出本来就在父会话的工具结果里。单独列出来只会变成同 id 的重复条目（实测 25 条冗余里，claude 7 个文件、codex 18 个）。

- claude：扫描器打 `sub: isSub` 标记（路径含 `/subagents/`）
- codex：只认**第一条** `session_meta`，看 `source.subagent` 打标记
- 用户主动 `/fork` 的真会话带 `forked_from_id` / `parent_thread_id` 但**没有** `source.subagent`，正常保留

🔴 **codex 必须只认第一条 `session_meta`**：0.171 起派生文件的写法是「先写自己那条（`id`=自己，`session_id`=父），紧接着把父会话的 `session_meta` 原样抄一遍」。原代码每遇一次就 `id = payload.id`，于是最后一条（父 id）胜出 —— 18 个文件全被标成父会话 id。

### 2. 同一 (tool,id) 仍有多个文件

codex 老版本 rollout 会被复制、会话中断重开后留下半截文件。`lib/sessions.js` 的 `dedupe()` 按 `(tool, id)` 收敛，保留**体积最大**的那个（最可能是完整转录），体积相同取 mtime 更新的。

聚合层统一做，不让各家扫描器各删各的：去重规则只有一套，加新工具时只要保证 `id` 语义一致就自动生效。

**验证**：168 条原始扫描 → 143 条唯一会话（去 25 条），`(tool,id)` 重复键 0；抽查 claude 三个受影响 id 均保留了主文件（`subagents/` 之外的 `<sessionId>.jsonl`）。

## 全文搜索与导航（2026-11-24）

### 搜索：标题 vs 全文

左侧搜索框有两种模式，右上角按钮切换（默认「标题」）：

| 模式 | 实现 | 速度 | 搜什么 |
|---|---|---|---|
| 标题 | 前端过滤已加载列表 | 即时 | 标题 + cwd |
| 全文 | `GET /api/search` → `lib/search.js` | 首次 2–4s，之后 10–20ms | 消息正文 + 思考内容 + 工具命令 |

默认标题模式不是偷懒，是**性能边界**：全文要把全部会话文件解析一遍。实测 171 个会话、原始 225MB、正文约 7MB，冷启动 3.2s（同步串行解析 9513 条消息）。每敲一个字符触发一次会让输入明显发卡，所以：

- 全文模式走 320ms 防抖 + 请求序号（`state.searchSeq`）丢弃过期响应——连打关键字时先发的慢请求可能后到，不丢序号会用它盖掉新结果；
- `lib/search.js` 按 `file` 缓存解析结果，失效条件是 `mtime + size` 都变了（会话被追加或被外部改写）；
- 首次搜索是**异步流式解析**，不阻塞事件循环：实测搜索进行中并发请求 `/api/trash` 只需 14ms。

片段安全：后端只返回 `{pre, hit, post}` 三段**纯文本**，前端 `esc()` 之后再拼 `<mark>`。后端不产出任何标签，所以会话正文里的尖括号永远进不了标签位置。

搜思考内容时命中项标 `field:"think"`，点进去会**先展开那个折叠块**再滚动——否则滚过去只看到一行摘要，用户会以为没定位到。命令命中同理解开 `details.toolcall`（`field:"tool"`）。

片段来源在 `fieldLabel` 里（`思考` / `命令`，正文为空），前端渲染成小标签。不标的话，搜到命令里的片段时用户会以为那是助手说的话。

### 为什么不用倒排索引

串行 `indexOf` 走 6361 条消息本身就在几十毫秒内（缓存命中后 10–20ms）。建倒排索引要额外处理增量更新、失效、落盘，复杂度远大于收益。等会话量涨到几千个再考虑。

### 提问导航（`public/js/outline.js`）

会话动辄上百条消息（实测最长 199 条），想回到「刚才问的那个问题」只能靠滚动。右下角悬浮按钮打开大纲，**只列用户提问**——回答太长且连续，列出来就是第二个正文，而人记话题时记得的是自己问过什么。

少于 2 个提问时按钮自动隐藏（`display:none`），给一个只有一条的列表不如不给。

快捷键 `Alt+↑` / `Alt+↓` 跳上/下一条提问。

🔴 **坐标换算是这里最容易写错的地方**。`#chat` 是 `position:static`，`.msg` 的 `offsetParent` 会一路找到 `body`，`offsetTop` 里混进了 `#bar` 高度和页面偏移，与 `scrollTop` 不同量纲。直接拿 `offsetTop` 和 `scrollTop` 比较，结果是「按键完全没反应」（实测 `scrollTop` 恒为 14 不动）。正确做法是相对 `#chat` 的矩形差值再加回 `scrollTop`：

```js
function chatTopOf(el, chat) {
  return el.getBoundingClientRect().top - chat.getBoundingClientRect().top + chat.scrollTop;
}
```

另外要留 8px 容差：滚到某条提问时它的 top 正好等于 `scrollTop`，不设容差不按方向判定会原地不动。

### 另外两处配套

- **消息复制**：悬停消息右上角出现 `⧉`，复制正文 + 工具调用（不含思考，思考是旁注）。用事件委托绑定，不给每条消息挂监听——长会话有几百条，逐个绑会泄漏。
- **时间筛选 + 会话规模**：`不限 / 今天 / 7 天 / 30 天` 按 mtime 过滤；顶栏显示「N 条 · 跨 X 小时」，跨度用首末消息时间算，不是「耗时」（中间可能隔几天没用，说耗时是错的）。

🔴 **筛选 chip 必须带 `[data-t]` 选择器**。页面上有两组 `.tchip`（工具筛选 `#typebar` + 时间筛选 `#timebar`），`bindTypeChips` 原来用裸 `.tchip`，会把时间 chip 一起绑上，点击时 `dataset.t` 是 `undefined`，`state.typeFilter` 被写成 `undefined` → 所有会话都匹配不上，列表整片变空，而且切回标题模式也救不回来。`setTypeFilter` 里另加了 `if (!tool) return` 兜底。

## 工具调用折叠（2026-11-25）

🔴 **默认整块不渲染**，顶栏 `⚙ 命令N` 打开才铺出来。打开后每条只显示一行 chip，再点开才看完整命令原文。

### 为什么默认隐藏（2026-11-25 追加）

一次回答背后常挂十几个 `exec_command` / `write_stdin`。实测某 codex 会话 1233 条消息里 **927 条是工具调用**——铺在正文里等于把答案整个淹掉，用户翻半天不见人话。BOSS 原话：「这种指令就直接去掉不显示了」。

实现要点：

- `state.toolOff` 默认 `true`；`toolHtml()` 第一行 `if (state.toolOff) return ""`。
- 偏好写 `localStorage["opensession.toolOff"]`（`main.js` 的 `initToolPref()` 读回），和侧栏折叠同一套做法。存 `"0"` 才显示。
- 🔴 **必须先滤掉空消息再分组**：隐藏后「只有工具调用、没有正文/思考」的消息会只剩一个角色行，白占一张卡片。`msgEmpty()` 的判断必须和 `msgHtml()` 实际渲染的三部分（text / think / tool）严格对齐；过滤后 `data-i` 仍用**原始序号**，否则搜索定位全错位。实测全库 9546 条消息里 7319 条含工具调用，其中 **3915 条除了工具调用什么都没有**——不过滤的话正文会插满 3915 张空卡片，比不隐藏还糟。
- 顶栏条数按**看得见的**算：显示「66 条」而不是原始 139 条，否则用户以为渲染漏了。原始条数放进 `title` 悬停可查。
- 整段会话只有工具调用时保留一条空态提示（指路 `⚙ 命令`）。当前 165 个会话里**没有**这种（实测 `emptySessions: 0`），属于防御性分支：解析规则一改、或某个工具开始只写工具调用，就会走到这里，留个说明总比白屏好。
- 全文搜索命中 `field==="tool"` 时自动 `toolOff=false` 再渲染一次。🔴 重绘后 `#chat` 是新节点，必须重新取引用——拿旧的 `el` 去 `scrollIntoView` 无声无息什么都不做。

### 为什么必须另存 `toolFull`，而不是放宽 chip 的截断上限

`toolHint()` 用 `firstText(JSON.stringify(hint), 70)` 生成摘要。这个函数做两件事：**把 `\s+` 压成单空格**、截到 70 字。所以直接在 `m.tool` 上放宽上限是错的：

1. 压缩空白把多行 shell 脚本压成一行乱麻，展开后看到的仍然不是原命令；
2. `m.tool` 是既有契约——chip 摘要、全文搜索命中、导出 MD、单条复制都在读它。把长命令塞进去会让列表 chip 撑爆、搜索片段被大段脚本淹没。

新增 `toolFull: [{name, body}]` 与之并列，只在「摘要装不下」时写入（`withFull()` 会过滤掉 null 并跳过空数组）。实测 7869 次调用里 6487 条需要折叠。

### 判定「要不要给折叠入口」

```js
const need = isCmd ? (s.includes("\n") || s.length > 60) : s.length > 120;
```

- 有 `cmd` / `command` 字段 → 命令原文（保住换行），多行或超 60 字才折叠；
- 只有单个 `file_path` → 摘要已经完整，返回 null，不折叠；
- 其他（子代理参数、多字段编辑）→ 整个参数对象的 `JSON.stringify(a, null, 2)`，超 120 字才折叠。

实测 6888/7869 条摘要不足 200 字，大多一眼能看全。给这些也加折叠箭头只是多一次点击。

单个调用上限 `MAX_TOOL_CHARS = 8000`。实测 7869 次调用含换行的 878 条、超 8000 字的 0 条，全库增量约 1.8MB，单会话最大 296KB（`解析一下xlog`）。

### 布局约束

🔴 **展开区必须限高**。实测一条命令 50 行 / 1100px，不限高展开后整段正文被顶出屏幕。`max-height: 42vh` + 内部纵向滚动，与思考块 `.tbody` 的 46vh 同一套做法。

横向不能出滚动条（会变成第二层滚动，与「正文整页滚动」冲突），用 `white-space: pre-wrap` + `overflow-wrap: anywhere` 折行。

单条命令时块头**不重复函数名**——summary 那行 chip 已经写了 `exec_command("…")`，展开后再顶一遍同名标题纯属重复占位。此时块头只剩贴右的「⧉ 复制命令」。

### 事件委托的先后顺序

命令块的复制按钮 `.tfcopy` 必须**先于** `.msgcopy` 判断，否则会被当成「复制整条消息」。另外要点 `preventDefault()` + `stopPropagation()`：按钮在 `<details>` 里，不拦的话点复制会顺手把折叠块收起来，复制完内容就看不见了。

## 本地文件预览与链接（2026-11-27）

正文里出现的路径（`/home/x/a.kt:44`、`~/b.log#L96`、`out/report.md`）和网络链接
现在都可点：网络链接新标签打开，本地路径在弹窗里预览，还能一键送进编辑器定位到行。

三块代码：

| 位置 | 职责 |
|---|---|
| `public/js/md.js` | 渲染时识别路径，产出 `<a class="filelink" data-file data-line>` |
| `public/js/peek.js` | 弹窗：文本 / 图片 / 目录 / 二进制；翻页；Esc 关闭 |
| `lib/fileview.js` | 路径解析、按行取窗口、`/api/raw`、编辑器打开 |

### 🔴 为什么必须在渲染层判断，后端不做

一条路径在会话文件里就是一串普通文本，和「TCP/IP」「24/7」长得一样。后端解析消息时
没有上下文，判不出用户是不是想点它。只有渲染时才看得见反引号、markdown 链接这些信号。

### 🔴 路径识别的三条硬规则（都是实测踩出来的）

全库 3085 条正文里出现过 2882 处路径，靠自然语言猜的代价很高。三条规则：

1. **反引号里的内容要单独判**。agent 写路径的主流形式是 `` `/home/x/a.kt:44` ``。
   行内代码如果一律当纯代码，最该点的那些一个都点不了。所以 `mdInline` 的第 1 步
   先判断「这段代码是不是路径 / URL」，是就渲染成带等宽样式的链接。
2. **相对路径必须带已知扩展名**（`.md`/`.kt`/`.log`…）。`24/7`、`TCP/IP`、`和/或`
   都是常见写法，放行纯目录相对路径会让正文变成蓝色乱麻。
3. **绝对路径要通过可信度校验**（`isRealAbsPath`），不能「以 / 开头就算路径」：
   - 顶层目录必须是常见系统根（`/home` `/data` `/tmp` `/media` `/ota` …），
     挡住 `/v1/chat/completions`、`/api/pricing` 这类 API 路径（实测 21 处）；
   - 或末段带扩展名（兜住非常规根）；
   - 且至少一段含 ASCII 字母数字 —— 中文行文里 `判定/理由/错在哪`、`版本/写成方`
     这类并列结构极多，放宽前导后一下冒出 11 处假链接。
4. **glob 不链接**：`decoded/*.log`、`/data/anr/trace_*` 点了必然「文件不存在」，
   连结束位置紧跟 `* ? { [ <` 的候选一并跳过。

审计脚本对全库跑过一遍：2695 个链接里假链接 0 处（剩下 5 处「可疑」是带中文文件名的
真路径，审计脚本按「含中文」误报）。

### 🔴 文本窗口：50MB 文件不能整读

日志类文件实测 90 万行 / 50MB。`fs.readFileSync` 后 `split("\n")` 会把服务撑爆。
`readWindow()` 用 `readline` 流式过一遍，只留目标行前 120 行起、共 400 行的窗口，
总行数顺路数出来（「共 N 行」这个信息定位日志全靠它）。

两个边界：

- **行号超出文件末尾**（旧文件里的行号，日志被轮转截短了）：一行动作都没有时
  退回「最后 400 行」，并标 `clamped: true`。留白页比给错位的信息更糟。
- **行号要在前端单独传**：`data-file` 已经把 `:44` 剥掉了，路径本身不带行号。
  这就要求 `/api/peek` 除了从路径里解析行号，还要接受 `line` 参数（第一版漏了，
  命中行不高亮）。

### 🔴 行号用 CSS counter，起点必须是 `from - 1`

`counter-reset: pkln N` 写在 `<pre>` 的行内样式上。翻到第 2280 行时若仍从 1 数起，
读日志会彻底错位。

### 视觉上的两个决定

- 本地链接用**青绿色虚下划线 + 等宽字体**，和网络链接（蓝色实线）区分开：
  一个是在弹窗里预览，一个是离开本页。
- 目录预览的 size 是 inode 大小（4096 这种），写出来只会让人困惑，改成「N 项」。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions?force=1` | 五家会话列表（按 mtime 倒序） |
| GET | `/api/session?file=&tool=` | 单会话消息数组，每项 `{role,time,text,tool,think,toolFull?}`（`think` 为思考过程，可能为空串/缺失；`toolFull` 为完整命令，仅摘要装不下时存在） |
| GET | `/api/models` | 模型目录 + 思考强度档位 |
| GET | `/api/search?q=&tool=&since=` | 全文搜索（正文 + 思考 + 命令）。返回 `{q,took,total,truncated,results[]}`，每条结果含 `count` 与最多 6 个 `hits[{i,role,field,fieldLabel,pre,hit,post}]`；`field` 为 `text`/`think`/`tool`，`since` 为毫秒时间戳 |
| GET | `/api/peek?path=&cwd=&line=&from=` | 本地文件预览。`kind` 为 `text`（含 `lines[]`/`from`/`to`/`totalLines`）/`image`/`dir`/`binary`；路径可带 `:44` 或 `#L96`；`cwd` 用于解析相对路径；`from` 翻页取窗口 |
| GET | `/api/raw?path=&cwd=` | 原样字节（图片预览 / 下载） |
| POST | `/api/open` | 用编辑器打开并定位到行（`{path, line}` → `{ok, via}`）；依次尝试 code / codium / cursor / subl / idea，最后退回系统默认程序 |
| GET | `/api/export?file=&tool=&title=&id=&cwd=` | 导出 Markdown |
| POST | `/api/resume` | 在终端恢复会话 |
| POST | `/api/new` | 在终端新建会话 |
| POST | `/api/embed` | 页面内会话（SSE 流）。`create:true` 时新建，其余字段为 `tool/cwd/message`；事件有 `{t:"delta",s}`（正文）、`{t:"think",s}`（思考）、`{t:"err",s}`，结束后回 `{t:"created",tool,id,file}` 与 `{t:"done"}` |
| POST | `/api/delete` | 删除单个会话（移入回收站） |
| POST | `/api/delete-batch` | 批量删除，逐条校验，非法项跳过 |
| GET | `/api/trash` | 回收站位置 + 当前平台（`{dir, platform, isWin, isMac}`，前端据此切换文案） |

## 删除会话

两种入口，都是**移入回收站**，不是物理删除：

| 方式 | 操作 |
|---|---|
| 单条 | 鼠标移到会话条目 → 右侧出现垃圾桶图标 → 点击 → 确认 |
| 批量 | 点筛选栏右侧「☑ 多选」→ 勾选多条（或「全选本页」）→「删除选中」 |

删除后文件进回收站，可还原：

| 平台 | 去向 | 还原方式 |
|---|---|---|
| Linux | `~/.local/share/Trash/{files,info}` | 文件管理器「回收站」 |
| macOS | `~/.Trash`（即 Finder 的「废纸篓」） | Finder 废纸篓，可拖出还原 |
| Windows | `$Recycle.Bin` | 桌面回收站 |

### 安全边界（`lib/trash.js`）

会话文件全在你的个人目录里，所以删除做了三层收窄，**不要为了省事改成 `fs.unlink`**：

1. **路径白名单**：`realpath` 解析后必须落在五家工具的会话目录内，`~/.claude/projects/../../.ssh/id_rsa`
   这类穿越会被拒（403），符号链接逃逸同理。Windows 下比较路径会折叠大小写
   （`C:\Users\Alice` 与 `c:\users\alice` 视为同一目录），否则真实路径会被误判越界。
2. **文件名白名单**：只允许 `.jsonl`（dsh 额外认 `.jsonl.zstd`）；hermes 只认 `session_*.json`，索引 `_index.json`、
   诊断用的 `request_dump_*.json` 一律拒绝。
3. **dsh 按目录删**：dsh 会话是一个目录（正文 + `session.lock`），只搬走 `.zstd` 会留孤儿目录。
   所以 `resolveDeletable` 会返回 `trashTarget`（指向父目录），三个平台的回收站实现都支持目录。
   **目录内容必须刚好是 `session.v4.jsonl.zstd` + `session.lock`**，多一个文件就拒删——
   防止把用户自己塞进会话目录的东西一起搬走。
4. **回收站而非删除**：
   - Linux 按 freedesktop 规范写 `files/` + `info/*.trashinfo`，重名自动加 `.1`、`.2` 不覆盖。
   - macOS 直接 `rename` 进 `~/.Trash`，重名按系统习惯变成 `name 2.jsonl`（编号在扩展名前）。
     默认不走 Finder（`osascript`）——那需要 Automation 权限，无人值守时会被 TCC 静默拒绝；
     想用 Finder 删（换取「放回原处」菜单）可 `OPENSESSION_MAC_TRASH=finder`，失败自动退回。
   - Windows 走 Shell API（`Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile` +
     `SendToRecycleBin`），与在资源管理器按 Delete 等效。**不能用 `fs.unlink`** —— 那是真删，
     进不了回收站。

> 批量删除是逐条校验的：一批里混进非法路径，合法的照删，非法的单独报错返回，不会整批失败。

## 跨平台改造（2026-11-23）

原来只有 Linux 实现。改造的思路是**只抽差一层，其余零改动**：

```
lib/platform.js          平台差异集中层：命令定位 / .cmd 转发 / 开 URL / 回收站位置
lib/terminal.js          统一入口（命令模板 + 按平台 require 实现）
lib/terminal-linux.js    Linux：终端候选 + sandbox DBus + /proc 探 GUI 环境
lib/terminal-mac.js      macOS：写 .command + open（跟随用户默认终端）
lib/terminal-win.js      Windows：start + 临时 .cmd
lib/trash.js             统一入口（路径白名单校验，三平台完全共用）
lib/trash-linux.js       freedesktop 回收站
lib/trash-mac.js         macOS 废纸篓 ~/.Trash
lib/trash-win.js         系统回收站（Shell API）
```

**刻意共用的部分**（不要重复实现）：会话扫描、正文解析、Markdown 渲染、路径白名单校验、
前端所有交互。这些与操作系统无关，分叉只会引入不一致。

**不得不分叉的部分**：终端启动、回收站搬运、开机自启、桌面快捷方式。

几个 Windows 特有的坑（都已处理，细节见「踩坑备忘」）：

- `PATH` 分隔符是 `;`，可执行后缀不固定（`PATHEXT`），`claude` 实际是 `claude.cmd`
- Node 18.20+ 直接 spawn `.cmd` 会 EINVAL，必须经 `cmd.exe` 转发
- `start` 的第一个带引号参数会被当窗口标题吞掉 → `start "" <目标>`
- 批处理里 `%` 是变量展开符，字面量要写 `%%`
- 回收站只能用 Shell API，`fs.unlink` 是真删

macOS 侧的三个要点：

- **终端**：没有 DBus activation、也没有 `start`。可用机制是 `.command` 文件——可执行的
  shell 脚本，双击即由系统默认终端在新窗口执行。所以写 `.command` 再 `open` 它，
  Terminal / iTerm / Warp 用户各自生效，我们不硬编码终端名。
- **引号**：`.command` 是 bash 脚本，命令串直接落盘会被 `$`、反引号、`;` 展开
  （会话目录是用户自己取的名，这些字符都合法）。所以先分词、再按 POSIX 规则逐词单引号引用，
  单引号内部的 `'` 写成 `'\''`。
- **废纸篓**：`~/.Trash` 就是 Finder 那个废纸篓，`rename` 进去即"可还原的删除"，
  不需要 Automation 权限。走 Finder（`osascript`）虽然能拿到「放回原处」元数据，
  但要 TCC 授权、无人值守时会被静默拒绝，所以只作可选、且失败自动退回。

**验证边界**：代码在 Linux 上实测通过（会话列表、解析、页面内恢复、**页面内新建
codex / claude / pi 三端到端跑通**、删除进回收站、Playwright 端到端、前端平台分支切换）。Windows 侧做了静态验证——用 PowerShell 7 的
`Parser::ParseFile` 校验 `install.ps1` 语法，并抽出 `New-Launcher` 函数实跑、
检查生成的 VBS 无残留占位符、引号拼接正确、UTF-16LE+BOM 编码正确。
macOS 侧做了三项可做得的验证：伪造 `process.platform = "darwin"` 确认模块分派
（`trash-mac` / `terminal-mac` 被加载、`trash-linux` 完全未加载）、用假 `uname` + 隔离
`HOME` 跑通 `install-mac.sh` 的安装/状态/卸载三档（产物用 `plistlib` 解析校验、`.command`
与 `launch` 用 `bash -n` 校验、`.icns` 逐块校验 PNG 头与尺寸）、把 `requote()` 的产物交给
真实 bash 解析，确认 `$HOME`、反引号、`$(...)`、`;`、`&&`、单引号全部原样成为参数而不被执行。
**三个平台都没有实机之外的第二台机器**：Windows 与 macOS 的最终确认仍需在真机上各跑一遍。

macOS 首次上机请重点看：双击桌面 `.app` 能否打开、终端恢复是否按你的默认终端弹窗、
删除是否真的进了 Finder 废纸篓。

## 踩坑备忘

- **sandbox DBus**：WorkBuddy 的 user namespace 把内部 uid 0 映射宿主 1000，gnome-terminal 发 EXTERNAL 认证用 `getuid()=0` 的凭据 → 永远被拒。解法是包一层 `unshare --user --map-user=1000 --map-group=1000`。
- **DISPLAY 不能写死**：服务由 `Linger` 在登录前就起来了，此刻还没有桌面，`DISPLAY` 是空的。
  `lib/terminal.js` 的 `detectGuiEnv()` 在每次点「恢复会话」时扫 `/proc/*/environ` 现取
  gnome-shell / gnome-session 的 `DISPLAY`、`XAUTHORITY`、`DBUS_SESSION_BUS_ADDRESS`
  （60 秒缓存，**探测失败不缓存**），所以开机自启、换会话、X11/Wayland 切换都不受影响。
- **`StartLimitIntervalSec` 属于 `[Unit]`**：写进 `[Service]` 会被 systemd 249 静默忽略，只打一行
  `Unknown key name` 警告，退避策略实际不生效。
- **busctl 的 `--address=` 不能用变量**：`--address="$VAR"` 报
  `Failed to create bus message: Invalid argument`，必须把 `unix:path=...` 字面量直接拼上。
- **sandbox 里 `systemctl --user` 连不上总线**（uid 0 与 bus 期望的 1000 不符）：要么
  `unshare --map-user=1000 --map-group=1000` 后调，要么改用 `busctl --address=unix:path=/run/user/1000/bus`。
- **`gio set metadata::trusted`**：GNOME 信任标记存在 dconf 里，**必须带会话 bus**
  （`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`）才写得进去，只 unshare 不够。
- **pi --list-models**：表格输出走 **stderr**。原来用 `execSync("pi --list-models 2>&1")` 靠 shell 重定向，
  Windows 的 cmd 下语义不同，已改为 `spawnSync` 分别读两个流再拼接（`lib/platform.runToolSync`）。
- **Node 18.20+ 不能直接 spawn `.cmd`**：CVE-2024-27980 修复后对 `.cmd`/`.bat` 抛 EINVAL。
  Windows 上 `claude` / `codex` 都是 npm 装的 `.cmd` shim，必须经 `cmd.exe /d /s /c ""exe" args"` 转发
  （`lib/platform.spawnTool` 统一处理）。
- **cmd.exe 的引号有两套规则**：`/c` 后接引号串时，加不加 `/S` 的剥离方式不同，目标命令自己还可能带引号。
  「拼一层再转义」在路径含空格时必崩。Windows 终端恢复改成把命令写进临时 `.cmd`，
  只让 `start "" <file>` 去跑文件，彻底绕开转义。
- **`start` 的第一个带引号参数是窗口标题**：写成 `start "C:\path\x.cmd"` 会把路径当标题吞掉，
  必须 `start "" "C:\path\x.cmd"`，那个空标题占位不能省。
- **systemd 用户服务的 PATH 只有 `/usr/bin:/bin`**：codex / claude / pi 装在 `~/.npm-global/bin`
  这类用户目录里，不补 PATH 会导致页面内恢复报「未找到命令」、`pi --list-models` 返回空。
  `bin/opensession-service` 已把常见用户 bin 追加到 PATH 末尾（不覆盖系统路径优先级）。
- **pi --session**：cwd 必须与会话原目录一致，否则只打印提示不执行。
- **前端不再内嵌在 Node 模板字符串里**：拆分后 HTML/CSS/JS 是独立文件，不存在模板转义问题。
- **列表按钮不要用内联 `onclick` 拼路径**：会话路径含中文、括号、单引号时会打断属性。
  `delbtn` 改成 DOM API + `addEventListener` 绑定（实测 `SP_TEST_(3).jsonl` 这类括号路径能正常删）。
- **WorkBuddy sandbox 会拦截删除**：`CODEBUDDY_SAFE_DELETE_ENABLED=1` + `NODE_OPTIONS` 注入的
  `node-language-shim.cjs` 会把 `unlink` 变成「移入沙箱回收站」，在**同一进程内连续删同名文件会
  不断产生 `.1.2.2` 这样的副本**。清理测试文件时要 `env -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_ENABLED`
  才删得干净（服务本身跑在 systemd 里，不受这个影响）。
- **Markdown 行内解析必须先占位再替换**：`target="_blank"` 里的下划线会被 `_斜体_` 规则吃成
  `target="<em>blank"`，链接与行内代码必须先换成占位符、等强调规则跑完再还原。
- **嵌套列表的 `<ul>` 必须在父 `<li>` 内部**：直接往闭合标签后追加会生成
  `<ul><li>a</li><ul>…</ul></ul>` 这种非法结构。做法是插入子列表前先去掉父项的 `</li>`。
- **气泡去掉 `pre-wrap` 后连带影响流式消息**：`embed.js` 的 `appendLiveMsg` 原来靠 `pre-wrap`
  保留换行，现在改 Markdown 后要显式加 `.raw`，并且流式结束后一次性 `mdToHtml()` 转换
  （边打字边解析会闪烁）。

## 许可证

[MIT](LICENSE) © 2026 1670295969


