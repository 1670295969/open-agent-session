# Agent Sessionary · 会话馆

聚合查看 / 恢复 **Codex CLI**、**Claude Code**、**Pi**、**Hermes** 的历史会话。

**当前形态：纯网页版**（浏览器大窗口，窗口自由缩放）。**Linux / macOS / Windows 三平台支持。**

> 📖 **只是想用它？读 [使用文档](docs/USAGE.md)** —— 安装、界面、恢复、新建、删除、排错，按操作场景组织。
> 本 README 记录的是实现细节、跨平台差异和踩坑，面向要改代码的人。

```bash
node agent-sessionary-server.js          # 默认 8347
ASRY_PORT=9000 node agent-sessionary-server.js
ASRY_NO_BROWSER=1 node agent-sessionary-server.js   # 不自动开浏览器（被常驻服务拉起时用）
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

Windows 侧刻意不写系统目录、不改 HKLM、不注册系统服务：常驻靠当前用户的启动文件夹，卸载就是删两个 `.lnk` 加一个 `%USERPROFILE%\.agent-sessionary` 目录，用户也能在「任务管理器 → 启动」里自己关掉自启。

macOS 侧同样不写系统级目录：常驻是当前用户的 `~/Library/LaunchAgents`，卸载就是 `bootout` + 删两个 `.app` 和一个 plist，不留系统残留。

## 怎么打开

| 方式 | 命令 / 入口 |
|---|---|
| **左侧导航栏** | 点 dock 上的图标（已固定，与桌面图标同一入口）← 最快 |
| **桌面图标** | 双击桌面「会话馆」 |
| 应用菜单 | 搜索 Agent Sessionary / 会话馆 |
| 命令行（独立窗口） | `asry-open --app` |
| 命令行（普通标签页） | `asry-open --tab` |
| 带筛选 | `asry-open --app --tool=claude` / `--q=关键词` |
| 直接开浏览器 | `http://localhost:8347` |

`asry-open` 会自动探活，服务没起就先拉起来（优先 `systemctl --user start`，失败则直接起进程）。

### 窗口尺寸

默认 **1900×1150** 的独立 window（无地址栏，类原生应用）。要改：

```bash
ASRY_WIN_W=1600 ASRY_WIN_H=900 asry-open --app
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
| 开机自启 | `~/.config/systemd/user/asry.service`（enabled 软链） | 登录即起 |
| 免登录自启 | `loginctl enable-linger $USER` | 无人登录也常驻 |
| 崩溃自愈 | `Restart=on-failure` + `RestartSec=3` | 挂掉 3 秒后自动换 PID |

日常运维：

```bash
systemctl --user status asry     # 看状态
systemctl --user restart asry    # 重启（改过代码后）
systemctl --user stop asry       # 停
journalctl --user -u asry -f     # 跟日志
```

**服务入口是 `bin/asry-service` 而不是直接写 node**，原因有两个：

1. node 路径含版本号（`.../versions/22.22.2/bin/node`），WorkBuddy 升级后旧路径消失，
   unit 会 ExecStart 失败。wrapper 里按「显式指定 → 任意 managed 版本 → PATH」顺序探测。
2. `DISPLAY` / `XAUTHORITY` 在 X11 / Wayland / 换 DM 下都不一样，写死进 unit 换环境即挂。

两个 wrapper 都会被复制到 `~/.local/bin` 供全局调用，所以**不能写死项目路径**：安装时把项目
目录记进 `~/.config/agent-sessionary/appdir`，脚本按「`ASRY_HOME` → 自身相对位置 → 该记录」
三级回找。移动项目目录后重跑 `install.sh` 即可，或临时用 `ASRY_HOME=/新路径` 覆盖。

## 桌面快捷方式

### Linux（`install.sh`）

`install.sh` 会装四样东西：

| 文件 | 作用 |
|---|---|
| `~/桌面/asry.desktop` | 桌面图标（已打 `metadata::trusted`，双击即开） |
| `~/.local/share/applications/asry.desktop` | 应用菜单里可搜索「会话馆」 |
| `~/.local/share/icons/hicolor/scalable/apps/agent-sessionary.svg` | 自绘图标（窗口 + 对勾，不依赖系统图标主题） |
| `org.gnome.shell favorite-apps` | 固定到左侧导航栏（Ubuntu dock 的收藏列表），排在 WorkBuddy 后面 |

取消固定：`./install.sh --uninstall` 会自动从导航栏摘掉；也可在图标上右键「从收藏夹中移除」。

> 坑：sandbox 里直接 `gsettings set` 会返回 0 但值不变（dconf 写入被拦，且 uid=0 写的不是当前用户的库）。
> 脚本走 `as_user` + 会话 bus 才真正落盘。另注意 `dock-position` 在 `XDG_CURRENT_DESKTOP` 为空/`Unity`
> 时会误读成 `BOTTOM`，只有 `ubuntu:GNOME` 才读到真实的 `LEFT`——判断方位前先对齐这个变量。

### Windows（`install.ps1`）

| 文件 | 作用 |
|---|---|
| 桌面 `会话馆.lnk` | 桌面快捷方式，内嵌 `assets/agent-sessionary.ico`（7 种尺寸，小图标到大图标都清晰） |
| `%APPDATA%\...\Start Menu\Programs\Startup\Agent Sessionary.lnk` | 开机自启（登录即起） |
| `%USERPROFILE%\.agent-sessionary\launch.vbs` | 隐藏窗口启动器：探活 → 起 node（无黑窗）→ 等就绪 → 开浏览器 |
| `%USERPROFILE%\.agent-sessionary\stop.vbs` | 停止后端（按命令行匹配 `agent-sessionary-server.js`，不误杀其它 node） |

另外 `bin/asry-open.ps1` 是 Linux 版 `asry-open` 的对应物：

```powershell
.\bin\asry-open.ps1                 # 独立窗口
.\bin\asry-open.ps1 -Tab            # 普通标签页
.\bin\asry-open.ps1 -Tool claude    # 预置筛选
.\bin\asry-open.ps1 -Q 关键词        # 预置搜索
.\bin\asry-open.ps1 -Status         # 看状态
.\bin\asry-open.ps1 -Stop           # 停后端
```

为什么用 `wscript` + `.vbs` 而不是 `.lnk` 直接指 `node.exe`：直接指 node 会弹一个常驻黑色控制台，
关掉它就杀掉服务。`.vbs` 里 `WScript.Shell.Run(cmd, 0, False)` 以隐藏窗口起 node，用户全程看不到控制台。

浏览器优先用 Chrome / Edge 的 `--app` 模式（无地址栏独立窗口，与 Linux 版一致）；
都找不到就退回默认浏览器标签页。

> 图标不是手画的：`tools/make-icon.py` 按 Linux 版 SVG 的同一套视觉（蓝紫渐变窗口 + 绿色对勾角标）
> 用 PIL 重画，4× 超采样后逐级缩小做抗锯齿，最后把 16/24/32/48/64/128/256 打进一个 `.ico`。
> 要改配色改脚本里的常量重跑即可。

> 为什么 `install.ps1` 不注册系统服务：注册服务要管理员权限、写 HKLM，卸载容易留残留。
> 启动文件夹 + 一个 `.lnk` 已经够实现「登录即起」，而且用户能在「任务管理器 → 启动」里
> 自己关掉，卸载就是删两个 `.lnk` 加一个 `.agent-sessionary` 目录。

### macOS（`install-mac.sh`）

| 文件 | 作用 |
|---|---|
| 桌面 `会话馆.app` | 桌面图标，内嵌 `assets/agent-sessionary.icns`（含 1024，Retina 大图标清晰） |
| `~/Applications/会话馆.app` | 应用目录里的同一份，可在启动台/聚焦搜到 |
| `~/Library/LaunchAgents/com.agentsessionary.viewer.plist` | 登录自启（`RunAtLoad`），崩溃 10 秒后重启（`KeepAlive.SuccessfulExit=false`） |
| `~/Library/Logs/agent-sessionary/agent-sessionary.err.log` | 服务日志（`tail -f` 可看） |
| `bin/asry-service-mac` | 服务 wrapper：安装时生成，负责补 PATH、找 node、exec server |

`.app` 是**本机生成**的包（`Info.plist` + `MacOS/launch` + `Resources/agent-sessionary.icns`），
没有 quarantine 扩展属性，不需要签名或公证。`LSUIElement = true` 让启动器自己不在 Dock 留图标——
它的职责只是「探活 → 拉起 → 开浏览器 → 退出」，真正的窗口是 Chrome 的 `--app`。

为什么不把它做成 `install.sh` 的 Darwin 分支：两边的机制（systemd vs launchd、`.desktop` vs `.app`、
`gsettings` vs 无）几乎没有一行可共用，混在一个文件里只会更难读。`install.sh` 检测到 Darwin 时会直接
提示改用 `./install-mac.sh`。

> 图标同样不是手画的：`tools/make-icon.py` 现在同时产出 `.ico` / `.icns` / `.png`。
> `.icns` 是按 Apple 的容器格式手写的（`icns` magic + 若干 `OSType/长度/PNG` 块），
> 所以 Linux 上也能生成和校验，不必依赖只在 macOS 存在的 `iconutil`。

## 启动浏览器的三个坑（2026-11-22 实测）

1. **uid 必须是 1000**：WorkBuddy sandbox 在 user namespace 里把 uid 映射成 0，Chrome 直接报
   `Running as root without --no-sandbox is not supported` 起不来。`asry-open` 检测到 uid 0 时
   自动套一层 `unshare --user --map-user=1000 --map-group=1000`。
2. **必须独立 user-data-dir**：用默认 profile 启 `--app` 会被已运行的 Chrome 实例吞掉，
   退化成普通标签页（静默，无报错）。脚本固定用 `~/.cache/asry-chrome`。
3. **必须 `--disable-gpu`**：容器/root 环境 GPU 初始化崩（`exit_code=8704`、`MESA: Failed to query drm device`），
   不加会导致进程活着但没有窗口。

> 另外：从 WorkBuddy 的 Bash 会话里启动的 GUI 进程会随命令返回被清理掉。
> 日常请点**左侧导航栏图标**或**桌面图标**，那是在你自己的桌面会话里跑，不受这个限制。

## 目录结构

```
agent-sessionary/
├── agent-sessionary-server.js     入口：起 HTTP 服务 + 自动开浏览器
├── agent-sessionary-cli.py        早期 Python 原型（已废弃，不被任何代码引用，仅作历史留存）
├── agent-sessionary-web.py        同上：Python 原型时代的 Web 版
├── install.sh                     Linux 安装（systemd + .desktop + 左侧栏固定）
├── install-mac.sh                 macOS 安装（launchd LaunchAgent + .app + .icns）
├── install.ps1                    Windows 安装（启动文件夹 + .lnk + 隐藏窗口启动器）
├── push-to-github.sh              建好空仓库后一键推送
├── assets/
│   ├── agent-sessionary.ico       Windows 图标（16→256 七种尺寸）
│   ├── agent-sessionary.icns      macOS 图标（icp4…ic10，含 1024）
│   └── agent-sessionary-256.png   文档用大图
├── tools/
│   └── make-icon.py               从零生成 ico / icns / png（PIL，4× 超采样抗锯齿）
├── bin/
│   ├── asry-service               服务 wrapper：探测 node、补 PATH 与运行时环境、exec server
│   ├── asry-open                  开窗口：探活 → 拉起 → Chrome 独立大窗口（Linux）
│   └── asry-open.ps1              同上，Windows 版（Chrome/Edge --app）
├── lib/
│   ├── config.js                常量（端口、缓存时长、超时、注入前缀）
│   ├── platform.js              平台差异层：命令定位（PATHEXT）、.cmd 转发、开 URL
│   ├── utils.js                 通用工具（walk / readLines / 文本提取 / 标题清洗）
│   ├── static.js                静态资源服务（public/ 下的 html、css、js）
│   ├── router.js                HTTP 路由表（/api/*）
│   ├── sessions.js              会话聚合 + 5 秒缓存
│   ├── trash.js                 删除：路径白名单校验（跨平台共用）+ 平台分派
│   ├── trash-linux.js           freedesktop 回收站实现
│   ├── trash-mac.js             macOS 废纸篓（~/.Trash）实现
│   ├── trash-win.js             Windows 系统回收站实现（Shell API）
│   ├── models.js                模型 / 思考强度目录（10 分钟缓存）
│   ├── exporter.js              Markdown 导出
│   ├── terminal.js              终端启动统一入口（命令模板 + 平台选择）
│   ├── terminal-linux.js        Linux：终端候选 + sandbox DBus 修复 + /proc 探环境
│   ├── terminal-mac.js          macOS：写 .command + open（跟随默认终端）
│   ├── terminal-win.js          Windows：start + 临时 .cmd（绕开引号转义）
│   ├── scanners/                四处会话目录扫描
│   │   ├── claude.js            ~/.claude/projects/**/*.jsonl
│   │   ├── codex.js             ~/.codex/sessions/**/*.jsonl
│   │   ├── pi.js                ~/.pi/agent/sessions/**/*.jsonl
│   │   └── hermes.js            ~/.hermes/webui/sessions + ~/.hermes/sessions
│   ├── parsers/
│   │   └── index.js             正文解析 → 统一消息结构 {role,time,text,tool}
│   └── embed/                   页面内会话（恢复 / 新建，SSE 流式）
│       ├── index.js             SSE 骨架 + 子进程生命周期
│       └── adapters/            各工具的参数拼装与输出解析
│           ├── claude.js        stream-json 逐行解析 text 块
│           ├── codex.js         prompt 走 stdin（`-`），stdout 直接转发
│           └── pi.js            按行流式（防 UTF-8 截断）
└── public/                      前端
    ├── index.html               骨架
    ├── app.css                  样式
    ├── favicon.svg
    └── js/
        ├── state.js             全局状态 + 格式化工具（含平台相关文案）
        ├── md.js                轻量 Markdown 渲染（零依赖，先转义再解析）
        ├── list.js              左侧列表：筛选、统一分页、分组渲染、全局刷新
        ├── del.js               删除：确认弹窗、多选批量、回收站交互
        ├── chat.js              右侧正文：Markdown 消息渲染、分页、顶部操作
        ├── embed.js             页面内会话：输入栏、自绘下拉、SSE 收发、页面内新建
        ├── newmodal.js          新建会话弹窗（终端 / 页面内两条路径）
        └── main.js              入口装配（含 ?tool=&q= 预置筛选、平台信息拉取）
```

## 正文渲染与刷新

**Markdown**：正文默认走 `public/js/md.js` 渲染（零依赖，不引 CDN，断网可用）。支持标题、粗体 / 斜体 / 删除线、行内代码、围栏代码块（右上角带复制按钮）、有序 / 无序列表（可嵌套）、引用、表格（含列对齐）、分隔线、链接。

安全做法是**先整体转义 HTML，再解析 Markdown 语法**，且链接只放行 `http(s)` / `mailto`，所以会话正文里的 `<script>`、`onerror=`、`javascript:` 都只会当文本显示。代码块与链接的 HTML 用占位符暂存，避免 `target="_blank"` 里的下划线被斜体规则误伤。

顶栏的 `M↓ Markdown` 按钮可一键切回纯文本（保留原始换行缩进），方便看被误解析的原始内容。

**刷新**：两处。

| 位置 | 作用 |
|---|---|
| 左上标题栏 `↻` | 重取会话列表，同时重读当前打开的会话；会话若已被外部删除会提示并回到空白页 |
| 正文顶栏 `↻ 刷新` | 只重读当前会话文件，保留所在页码 |

## 新建会话：两条路径

弹窗（`＋ 新建会话`）里有三个字段：工具、工作目录、第一条消息。底部两个按钮对应两种创建方式：

| 按钮 | 行为 | 适用 |
|---|---|---|
| **⚡ 页面内创建** | 不弹终端，本页里直接跑第一条消息；跑完自动把这个新会话接进列表并打开，可以接着在输入栏里继续聊 | codex / claude / pi |
| **启动终端** | 打开系统终端跑交互式 CLI，之后的对话在终端里进行 | 四家都行（含 hermes） |

页面内创建时「第一条消息」必填——CLI 的 `-p` / `exec` 是一次性调用，没有 prompt 起不来。终端方式会忽略该字段。

hermes 会话是只读存储，没有页面内适配器，选中它时「页面内创建」自动禁用并给出原因。

### 三家 CLI 各自的「新建」方式

都是实测确认的，差异不小：

| 工具 | 命令 | 怎么拿到新会话 id |
|---|---|---|
| claude | `claude -p --output-format stream-json --verbose --session-id <uuid>` | uuid 由服务端生成后显式传入；`system/init` 事件也会回带，用作兜底 |
| codex | `codex exec --json --skip-git-repo-check -` | 必须加 `--json`：纯文本模式没有 id；JSONL 首行 `thread.started.thread_id` 就是 |
| pi | `pi --session <指定文件路径> -p` | 文件路径自己指定，id 从文件名尾部 uuid 取 |

落盘后按 id 反查文件：claude 在 `~/.claude/projects/**/` 找 `<uuid>.jsonl`；codex 在 `~/.codex/sessions/**/` 找文件名含 thread_id 的 `rollout-*.jsonl`；pi 路径本来就是自己给的。CLI 退出与文件写完之间有毫秒级延迟，所以最多轮询 2.5 秒（25×100ms），等不到也照常把 id 返回，前端提示刷新即可，不把请求判失败。

### 工作目录校验（两种创建方式一致）

- **新建**：目录必须真实存在且是目录，否则直接报「工作目录不存在或不是目录：xxx」，**不会**退回 `$HOME` 静默建会话。目录打错却毫无提示、把会话建到用户没指定的地方，比报错更糟。
- **恢复**：目录可能已被外部删除，此时退回 `$HOME`，让 CLI 至少能起来。

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

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sessions?force=1` | 四家会话列表（按 mtime 倒序） |
| GET | `/api/session?file=&tool=` | 单会话消息 |
| GET | `/api/models` | 模型目录 + 思考强度档位 |
| GET | `/api/export?file=&tool=&title=&id=&cwd=` | 导出 Markdown |
| POST | `/api/resume` | 在终端恢复会话 |
| POST | `/api/new` | 在终端新建会话 |
| POST | `/api/embed` | 页面内会话（SSE 流）。`create:true` 时新建，其余字段为 `tool/cwd/message`；结束后回 `{t:"created",tool,id,file}` |
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

1. **路径白名单**：`realpath` 解析后必须落在四家工具的会话目录内，`~/.claude/projects/../../.ssh/id_rsa`
   这类穿越会被拒（403），符号链接逃逸同理。Windows 下比较路径会折叠大小写
   （`C:\Users\Alice` 与 `c:\users\alice` 视为同一目录），否则真实路径会被误判越界。
2. **文件名白名单**：只允许 `.jsonl`；hermes 只认 `session_*.json`，索引 `_index.json`、
   诊断用的 `request_dump_*.json` 一律拒绝。
3. **回收站而非删除**：
   - Linux 按 freedesktop 规范写 `files/` + `info/*.trashinfo`，重名自动加 `.1`、`.2` 不覆盖。
   - macOS 直接 `rename` 进 `~/.Trash`，重名按系统习惯变成 `name 2.jsonl`（编号在扩展名前）。
     默认不走 Finder（`osascript`）——那需要 Automation 权限，无人值守时会被 TCC 静默拒绝；
     想用 Finder 删（换取「放回原处」菜单）可 `ASRY_MAC_TRASH=finder`，失败自动退回。
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
  `bin/asry-service` 已把常见用户 bin 追加到 PATH 末尾（不覆盖系统路径优先级）。
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


