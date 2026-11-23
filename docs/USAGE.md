# 使用文档

面向**使用者**的完整操作说明。想看实现细节、踩坑记录和设计取舍，读 [README](../README.md)。

- [1. 它是什么](#1-它是什么)
- [2. 安装](#2-安装)
- [3. 打开](#3-打开)
- [4. 界面导览](#4-界面导览)
- [5. 查看会话](#5-查看会话)
- [6. 搜索 / 筛选 / 分页](#6-搜索--筛选--分页)
- [7. 导出与复制命令](#7-导出与复制命令)
- [8. 页面内恢复（不弹终端）](#8-页面内恢复不弹终端)
- [9. 终端恢复](#9-终端恢复)
- [10. 新建会话](#10-新建会话)
- [11. 删除与还原](#11-删除与还原)
- [12. 开启 / 关闭开机自启](#12-开启--关闭开机自启)
- [13. 参数与环境变量速查](#13-参数与环境变量速查)
- [14. 常见问题](#14-常见问题)

---

## 1. 它是什么

一个本地网页应用，把 **Codex CLI**、**Claude Code**、**Pi**、**DeepSeek Harness（dsh）**、**Hermes** 五个命令行 AI 工具散落在各处的历史会话，聚合成一个可搜索、可阅读、可继续对话的界面。

它**不落新数据、不改动已有文件**（除非你主动删除），只读这五家工具自己写的会话文件：

| 工具 | 会话文件位置 |
|---|---|
| Codex CLI | `~/.codex/sessions/**/*.jsonl`（标题另读 `~/.codex/session_index.jsonl`） |
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| Pi | `~/.pi/agent/sessions/**/*.jsonl`，或 `$PI_CODING_AGENT_SESSION_DIR` |
| DeepSeek Harness | `~/.dsh/sessions/**/session.v4.jsonl.zstd`（zstd 压缩的多帧 JSONL） |
| Hermes | `~/.hermes/webui/sessions/*.json`、`~/.hermes/sessions/session_*.json` |

（Windows 下 `~` 即 `%USERPROFILE%`，路径结构相同。）

所以：**你平时怎么用这五个工具，这里就怎么显示**；反过来，这里的操作也会真实作用到那些会话上——「恢复」是真的续上那次对话，「删除」是真的把文件移进回收站。

> **关于名字**：**OpenSession** = *open* + *session*。核心动作就两件——把散落各处的会话**打开**（查看、搜索、导出），
> 以及把旧会话重新**打开**继续聊（页面内恢复 / 终端恢复）。名字取自动作本身，不是"馆"或"仓库"那类收藏式命名。

---

## 2. 安装

需要 **Node.js 18+**。零 npm 依赖，不装任何包。

先拿到代码：

```bash
git clone https://github.com/1670295969/open-agent-session.git opensession
cd opensession
```

（本机 22 端口常被墙，克隆/拉取失败时改用 SSH 443：
`GIT_SSH_COMMAND="ssh -p 443 -o HostKeyAlias=ssh.github.com" git clone git@ssh.github.com:1670295969/open-agent-session.git`）

再跑一次纯手动模式确认能用（不需要装任何东西）：

```bash
node opensession-server.js
# OpenSession: http://localhost:8347
```

确认页面能打开、会话列得出来，再按平台一键安装（服务常驻 + 开机自启 + 桌面图标）：

### Linux

```bash
./install.sh                # 装服务 + 自启 + 桌面图标 + 左侧导航栏固定
./install.sh --status       # 只看状态，不改任何东西
./install.sh --uninstall    # 撤销（保留你的数据与脚本）
```

装完是三层保障：

| 层 | 机制 | 效果 |
|---|---|---|
| 开机自启 | systemd user unit（enabled） | 登录即起 |
| 免登录自启 | `loginctl enable-linger $USER` | 没人登录也常驻 |
| 崩溃自愈 | `Restart=on-failure`，3 秒后重拉 | 挂了自动恢复 |

### macOS

```bash
./install-mac.sh              # launchd LaunchAgent + 桌面 .app + 图标
./install-mac.sh --status
./install-mac.sh --uninstall
```

产物落在 `~/Library/LaunchAgents/com.opensession.viewer.plist`、桌面与 `~/Applications` 的
`OpenSession.app`、日志 `~/Library/Logs/opensession/`。不写系统目录，不需要签名或公证。

### Windows

**PowerShell** 里执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1   # 桌面快捷 + 开机自启 + 立即启动
.\install.ps1 -Status
.\install.ps1 -Uninstall
.\install.ps1 -NoAutoStart     # 不设自启
.\install.ps1 -NoDesktop       # 不建桌面快捷
```

不注册系统服务、不改 HKLM。常驻靠当前用户的启动文件夹，卸载就是删两个 `.lnk` 和一个
`%USERPROFILE%\.opensession` 目录，也可以在「任务管理器 → 启动」里自己关掉。

> **重装提示**：升级 Node / 换机器后如果服务起不来，直接重跑一遍安装脚本即可——它是幂等的，
> 会重新探测 Node 路径并修好服务配置。

---

## 3. 打开

| 方式 | 入口 | 说明 |
|---|---|---|
| **桌面图标** | 双击「OpenSession」 | 最快 |
| **左侧导航栏 / Dock** | 点已固定的图标（仅 Linux） | 与桌面图标同一入口 |
| 应用菜单 / 聚焦搜索 | 搜 "OpenSession" | |
| 命令行（独立窗口） | `opensession-open --app` | 1900×1150 无地址栏窗口，像个原生应用 |
| 命令行（普通标签页） | `opensession-open --tab` | 在你现有浏览器里开一页 |
| 带筛选启动 | `opensession-open --app --tool=claude` | 只显示 claude 会话 |
| 带搜索启动 | `opensession-open --app --q=关键词` | 预填搜索框 |
| 收起列表启动 | `opensession-open --app --noside` | 启动即占满窗口 |
| 直接开浏览器 | 手动访问 `http://localhost:8347` | 服务得先起着 |
| 装成独立 App | Chrome 地址栏右侧「安装」图标 | 见下方说明 |

`opensession-open` 会先探活，服务没起就自己拉起来，不用手动起服务。

**改窗口尺寸：**

```bash
OPENSESSION_WIN_W=1600 OPENSESSION_WIN_H=900 opensession-open --app
```

**装成独立 App（PWA）：**

页面自带 `manifest.webmanifest` 与一个不缓存的 service worker，Chrome / Edge 会认为它
「可安装」。点地址栏右侧的安装图标，或在菜单里选「安装 OpenSession / 固定到任务栏」，
就会得到一个用**自己的图标**、没有地址栏的窗口，和 `opensession-open --app` 效果接近。
好处是不用依赖启动器脚本，坏处是窗口尺寸由浏览器记忆、不受 `OPENSESSION_WIN_W/H` 控制。

service worker 刻意**不缓存任何内容**（只是透传），所以列表不会看到过期数据；
断网时页面打不开，这与本工具「读本机会话文件」的定位一致。

**为什么不建议从脚本 / CI 里拉起窗口**：那样启动的 GUI 进程往往没有真实的桌面会话
（缺 `DISPLAY` / DBus），窗口不会出现。日常请点图标或 `opensession-open`。

---

## 4. 界面导览

左右两栏，无多余装饰：

```
┌───────────────────────────────┬───────────────────────────────────────────────┐
│ 📜 OpenSession  ↻ «  ＋新建   │ 📁 工作目录    ● 嵌入会话中                   │
│ 搜索标题 / 项目路径…          │ $ resume 命令         [操作按钮行]            │
│ Codex 50 · Claude 46 · Pi 9   │ ───────────────────────────────────────────── │
│ DeepSeek 29 · Hermes 23       │ 👤 用户   2026-11-23 10:49                    │
│ [全部][Codex][…]  ☑ 多选      │    你好，帮我看看这个报错                     │
│ ──────────                    │ 🤖 助手   2026-11-23 10:49                    │
│ ▸ Codex   16 个               │    这是 Markdown 渲染后的正文…                │
│   · 会话标题                  │    ⚙ exec_command(...)                        │
│     时间  大小  路径          │                                               │
│   · 会话标题                  │    正文全文渲染，不分页                       │
│ ──────────                    │                                               │
│ ← 第 1/6 页 · 共 128 个       │ ───────────────────────────────────────────── │
└───────────────────────────────┴───────────────────────────────────────────────┘
```

左侧是**会话列表**，右侧是**当前会话正文 + 操作栏**，底部输入栏在「页面内恢复」打开时出现。

### 隐藏左侧列表

标题栏的 `«` 按钮可以收起左侧列表，让正文占满整个窗口（读长对话、对照代码时有用）。

| 操作 | 效果 |
|---|---|
| 点标题栏 `«` | 收起左侧列表 |
| 点左上角浮出的 `» 会话列表` | 展开回来 |
| `Ctrl+B`（macOS 也可 `Cmd+B`） | 来回切换 |

折叠状态会被记住，下次打开还是收起的样子；想恢复默认（展开）就再点一次 `»`。
在搜索框 / 输入栏里打字时 `Ctrl+B` 不生效，不会影响正常输入。

---

## 5. 查看会话

点左侧任意一条会话，右侧显示完整对话：

- **用户消息**和**助手消息**分开着色，各带时间戳
- 助手调用工具的那一步显示为一条 `⚙ 工具名` 的小标签
- sidechain（子代理对话）会额外标注 `· sidechain`
- 正文默认按 **Markdown** 渲染：标题、粗体、列表、表格、引用、链接、围栏代码块（右上角带**复制**按钮）

正文右上角的 `M↓ Markdown` 按钮可以一键切回**纯文本**（保留原始换行缩进），看被误解析的原始内容时用。

### 思考过程

模型的推理过程（thinking / reasoning）显示为助手消息上方的一条折叠行：

```
▸ 💭 思考过程  1.8k 字
```

**看历史会话时默认收起**，点一下那一行才展开，再点收起。折叠状态下只占一行，不会把正式回答挤走。

**在页面里继续对话时是反过来的**：思考过程一边生成一边显示（默认展开、带「· 进行中」标记），
回答跑完后自动收起成一行摘要。等待期间你能直接看到模型在想什么，不用干等。
中途自己点过那一行，收尾时就不会再自动收起，按你的选择来。

哪些工具能看到：

| 工具 | 思考内容来自 | 说明 |
|---|---|---|
| Claude Code | `thinking` 块 | 最完整，历史会话与实时对话都有 |
| Pi | `thinking` 块 | 历史会话完整；**实时对话看不到**（上游加密返回，本地解不开） |
| Hermes | `reasoning_content` | 推理模型（如 DeepSeek）才有 |
| Codex | `reasoning` 的 `summary` | 正文被加密，只剩要点式摘要，通常只有几十字；且不是每轮都有 |
| DeepSeek Harness | `reasoning` 块 | 明文完整（早前文档写"看不到"是错的，已更正） |

两点要知道：

- 折叠时内容虽然还在页面里，但浏览器自带的查找（`Ctrl` / `⌘` + `F`）**搜不到**，
  得先点开那一行。
- 特别长的单条思考会在 2 万字处截断（和正文同一档上限），末尾标 `…[思考已截断]`。
  原文仍完整存在会话文件里。

进度条上方的两行信息说明这条会话的来历：

```
📁 /home/you/work/myproject          ← 会话当时的工作目录
$ codex resume --no-daemon 01a2...   ← 可以复制到终端跑的命令
```

### 两处刷新

| 按钮 | 位置 | 作用 |
|---|---|---|
| `↻` | 左上标题栏 | 重取整个会话列表，同时重读当前会话。若会话已被外部删除，会提示并回到空白页 |
| `↻ 刷新` | 正文操作栏 | 只重读当前会话文件，保留你正在看的页码 |

终端里刚聊完，回来点一下 `↻ 刷新` 就能看到新内容。

### 空会话

有些会话点开一片空白——这不是 bug，文件里确实没有对话。典型情况是 `codex exec` 启动后
0.7 秒就被中断，只有元数据没有正文。识别出来后会：

- 列表标题显示 `(空会话 · 无对话内容)`，并带一个虚框「空」标签
- 正文区给出说明卡片，告诉你成因和可选项（恢复 / 删除）

---

## 6. 搜索 / 筛选 / 分页

**搜索框**同时匹配 **标题** 和 **项目路径**，输入即过滤，不区分大小写。

**类型筛选**是五个 chip：`全部` / `Codex` / `Claude` / `Pi` / `DeepSeek` / `Hermes`。

- 「全部」视图下，列表内**按工具分组**，每组带数量
- 切到单一类型或输入了搜索词后，改为**平铺**并给每条加工具徽标

**分页只作用于左侧列表**：每页 25 条（底部 `← 第 x/y 页 · 共 n 个`），分组视图下也按总条数翻页，
不会出现每组各自翻页的混乱。

**右侧正文不分页**，打开会话就一次性渲染全部消息。这样做的两个好处：
找上下文时不用来回翻页，浏览器的 `Ctrl+F` 也能一次搜到整个会话的内容。
实测最重的会话（155 条消息 / 57 万字）整篇渲染约 0.1 秒，无需担心卡顿。

---

## 7. 导出与复制命令

正文操作栏三个按钮：

| 按钮 | 结果 |
|---|---|
| **复制命令** | 把 `$ ...` 那行恢复命令复制到剪贴板，自己粘到终端里跑 |
| **导出 MD** | 下载一条 `标题.md`，包含元信息（工具 / 会话 id / 工作目录 / 时间）+ 全部消息，工具调用也保留 |
| **M↓ Markdown** | 切换渲染 / 纯文本 |

导出的 Markdown 可以直接丢进笔记软件或文档里，格式是通用的。思考过程也会一并导出，
每个放在 `<details><summary>💭 思考过程</summary>` 折叠块里，在支持 `<details>` 的
渲染器（GitHub、Obsidian、Typora、VS Code 预览）里默认收起。

---

## 8. 页面内恢复（不弹终端）

不想切终端时用这个：点操作栏的 **`💻 页面内恢复`**，底部弹出输入栏，直接在这里继续对话。

1. 输入消息，**Enter 发送**，**Shift+Enter 换行**
2. 回复**流式**显示（边生成边出现），跑完自动转成 Markdown
3. 回复会真实写回原会话文件，终端里再 `resume` 也能看到这段

输入栏还有两个下拉：

| 下拉 | 作用 |
|---|---|
| **模型** | 本次调用用哪个模型。默认留空 = 用 CLI 自己的默认 |
| **思考强度** | `low` / `medium` / `high` 等档位，各工具支持的档位不同，列表自动按工具过滤 |

两个都保持「默认」最省事，不要跨工具乱选——不同工具的模型 id 不通用。

**行为细节：**

- 运行期间输入框和下拉都锁住，显示「运行中…」，防止并发发送
- 单次运行超过 **10 分钟**自动终止并提示
- 如果回复还没跑完你就点开了别的会话，回复**照常写入原会话文件**，但不会把你拽回去；
  会 toast 提示「XX 已回复，切回该会话可查看」
- **Hermes 会话不支持页面内恢复**（它的存储是只读的），按钮根本不会出现

---

## 9. 终端恢复

想用完整的交互式 CLI（比如要看 CLI 自己的界面、要手动确认权限）就用 **`▶ 终端恢复会话`**。

它会打开系统终端并执行对应命令：

| 工具 | 执行的命令 |
|---|---|
| Codex | `codex resume --no-daemon <id>` |
| Claude | `claude --resume <id>` |
| Pi | `pi --session "<会话文件路径>"` |
| Hermes | `hermes -r <id>` |

打开方式按平台走各自的机制：Linux 用 gnome-terminal 等候选终端，macOS 写 `.command` 交给你的
**默认终端**，Windows 用 `cmd.exe`（Win11 上可能落到 Windows Terminal）。

失败时（比如没装终端）会把命令**自动复制到剪贴板**并提示，粘到任意终端里跑即可。

---

## 10. 新建会话

点左上 `＋ 新建会话`，三个字段：

| 字段 | 说明 |
|---|---|
| **工具** | Codex / Claude / Pi / Hermes |
| **工作目录** | 会话在哪个目录里跑。输入框带**历史目录下拉**（从你已有会话里取前 30 个） |
| **第一条消息** | 只有「页面内创建」需要，终端方式忽略 |

底部两个动作按钮：

### ⚡ 页面内创建（推荐）

不弹终端，直接在当前页面把第一条消息跑掉，跑完自动接进列表并打开，可以接着聊。

- 支持 Codex / Claude / Pi
- **第一条消息必填**（CLI 的一次性调用没有 prompt 起不来）
- **工作目录必须真实存在**，否则直接报错，**不会**偷偷把会话建到你的家目录去
- 弹窗里按 **Ctrl+Enter**（macOS：⌘+Enter）等同于点这个按钮
- 一次只跑一个创建流；重复点击会提示「上一个会话还在创建中」
- 创建失败会明确标红「未创建」并给出原因，不会停在「新建会话中」的假状态

### 启动终端

打开系统终端跑交互式 CLI，后续对话都在终端里。四家都支持（含 Hermes）。这种方式**忽略**「第一条消息」。

> 选 Hermes 时「页面内创建」按钮会变灰并说明原因——它的会话是只读存储，没有页面内适配器。

---

## 11. 删除与还原

**两个入口，都只是「移入回收站」，不是物理删除。**

| 方式 | 操作 |
|---|---|
| 单条 | 鼠标移到会话条目上 → 右侧出现垃圾桶图标 → 点击 → 确认 |
| 批量 | 筛选栏右侧点 `☑ 多选` → 勾选（或点「全选本页」）→「删除选中」 |

删除后去哪、怎么还原：

| 平台 | 去向 | 还原方式 |
|---|---|---|
| Linux | `~/.local/share/Trash/{files,info}` | 文件管理器打开「回收站」，右键还原 |
| macOS | `~/.Trash`（Finder 的「废纸篓」） | Finder 废纸篓里拖出，或右键「放回原处」 |
| Windows | 系统回收站 | 桌面回收站里右键「还原」 |

**安全边界**（为什么这里不是简单的删除）：

- 只认四家工具的会话目录内的文件，路径穿越（`../../.ssh/id_rsa`）和符号链接逃逸会被拒绝（403）
- 只接受 `.jsonl`；Hermes 只接受 `session_*.json`，索引和诊断 dump 一律拒绝
- 批量删除**逐条校验**：一批里混进非法项，合法的照删，非法的单独报错返回，不会整批失败

> 会话文件是你的历史记录。这个项目刻意不做「彻底删除」按钮——真要物理删，去回收站里清空。

---

## 12. 开启 / 关闭开机自启

不想让它常驻了：

```bash
# Linux
./install.sh --uninstall          # 停服务 + 撤自启 + 去图标（脚本与数据都留着）
systemctl --user disable --now opensession   # 只关自启，不动图标

# macOS
./install-mac.sh --uninstall

# Windows
.\install.ps1 -Uninstall
```

临时停一下（不撤销安装）：

```bash
systemctl --user stop opensession      # Linux
launchctl bootout gui/$(id -u)/com.opensession.viewer   # macOS
%USERPROFILE%\.opensession\stop.vbs    # Windows，双击即可
```

---

## 13. 参数与环境变量速查

### 服务端（`node opensession-server.js`）

| 变量 | 默认 | 作用 |
|---|---|---|
| `OPENSESSION_PORT` | `8347` | 监听端口（只绑 `127.0.0.1`，不对外） |
| `OPENSESSION_NO_BROWSER` | — | 设为 `1` 时不自动开浏览器。被开机自启拉起时应当设 |
| `OPENSESSION_HOME` | 安装时记录 | 项目目录。移动过项目目录、或想用多份副本时设它 |
| `OPENSESSION_NODE` | 自动探测 | 指定 node 可执行文件 |
| `OPENSESSION_MAC_TRASH` | — | macOS 设 `finder` 可改用 Finder 删除（换取「放回原处」，需要 Automation 权限） |

> **移动了项目目录怎么办**：`~/.local/bin` 下的 `opensession-open` / `opensession-service` 靠
> `~/.config/opensession/appdir` 里记录的项目路径回找。换了位置就在新目录里重跑一次
> `./install.sh`，它会更新这条记录；或者临时用 `OPENSESSION_HOME=/新路径 opensession-open`。

### 启动器（`opensession-open`）

| 参数 / 变量 | 作用 |
|---|---|
| `--app` / `--tab` | 独立窗口 / 普通标签页 |
| `--tool=codex\|claude\|pi\|dsh\|hermes` | 预置类型筛选 |
| `--noside` | 启动时直接收起左侧列表 |
| `--q=关键词` | 预置搜索 |
| `OPENSESSION_WIN_W` / `OPENSESSION_WIN_H` | 独立窗口宽高，默认 1900×1150 |
| `OPENSESSION_PROFILE` | Chrome 用户数据目录，默认 `~/.cache/opensession-chrome` |
| `OPENSESSION_BROWSER` | 指定浏览器可执行文件路径 |

### 快捷键

| 位置 | 按键 | 作用 |
|---|---|---|
| 页面内输入栏 | `Enter` | 发送 |
| 页面内输入栏 | `Shift` + `Enter` | 换行 |
| 新建弹窗 | `Ctrl` / `⌘` + `Enter` | 页面内创建 |
| 任意弹窗 | `Esc` / 点遮罩空白处 | 关闭弹窗 |
| 全局 | `Ctrl` / `⌘` + `B` | 收起 / 展开左侧列表（输入框内不触发） |

> 改过前端代码后，浏览器里要 **Ctrl+Shift+R**（macOS：⌘+Shift+R）强刷一次，否则跑的仍是被缓存的老 JS。

---

## 14. 常见问题

**Q：页面打开是空白，左侧一个会话都没有？**
先看五个工具目录存不存在（`~/.codex/sessions`、`~/.claude/projects`、`~/.pi/agent/sessions`、`~/.dsh/sessions`、`~/.hermes`）。
一个都没有说明你还没在那台机器上用过这些 CLI，不是程序的问题。有一个但没列出来，看服务日志：

```bash
journalctl --user -u opensession -f                    # Linux
tail -f ~/Library/Logs/opensession/opensession.err.log   # macOS
# Windows：直接看 `%USERPROFILE%\.opensession\` 下的日志，或前台手跑 node 看输出
```

**Q：点「页面内恢复」报「未找到命令」？**
服务进程的 `PATH` 里没有那个 CLI。开机自启的服务 `PATH` 往往只有 `/usr/bin:/bin`，
而 `codex` / `claude` / `pi` 通常装在 `~/.npm-global/bin` 这类目录。重跑 `./install.sh` 会自动补上；
手工确认：`systemctl --user show-environment | grep PATH`。

**Q：页面内恢复没反应、也没报错？**
通常是请求体不合法，后端返回了 JSON 错误而不是 SSE 流。看浏览器控制台的 Network 面板里
`/api/embed` 那条请求的响应体，会有明确的 `error` 字段。

**Q：新建会话报「工作目录不存在或不是目录」？**
这是刻意设计：目录打错时**不会**把会话静默建到家目录去。改成真实存在的目录再试。

**Q：macOS 上点「终端恢复」没弹窗口？**
`.command` 文件由系统默认终端打开。若你的默认终端是某个未注册的第三方终端，可能在设置里
指定一下。另外 Windows / macOS 侧都只做过静态与模拟验证，真机首次使用建议先点一次「复制命令」
手动跑，确认命令本身没问题。

**Q：删掉的会话能恢复吗？**
能。它们都在回收站里，见 [11. 删除与还原](#11-删除与还原)。

**Q：能从别的机器访问吗？**
不能，也不建议改。服务只监听 `127.0.0.1`。这个工具会读取你所有的 AI 对话历史，
**不要**把它绑到 `0.0.0.0` 或暴露到公网。

**Q：会往我的会话文件里写东西吗？**
只有一种情况会：你在「页面内恢复」或「页面内创建」里发了消息。其余所有操作（浏览、搜索、导出、
复制命令）都是只读。删除是把文件移进回收站，不改文件内容。

---

## 附录：名称沿革与命令对照

这个工具在 2026-11-23 一天里改过两次名，最终定名 **OpenSession**：

| 阶段 | 英文名 | 命令 | 服务 |
|---|---|---|---|
| 最初 | `agenthist` | `agenthist-open` | `agenthist.service` |
| 中间 | Agent Sessionary | `asry-open` | `asry.service` |
| **当前** | **OpenSession** | **`opensession-open`** | **`opensession.service`** |

### 从任一旧版本升级

```bash
./install.sh --uninstall          # 先撤掉旧服务（在旧目录里执行）
./install.sh                      # 在新目录里装一遍
```

旧命令与旧配置**不会自动删除**。如需清理：

```bash
# agenthist 时代
rm -f ~/.local/bin/agenthist ~/.local/bin/agenthist-open \
      ~/.local/bin/agenthist-service ~/.local/bin/agenthist-web
rm -rf ~/.config/agenthist ~/.cache/agenthist-chrome

# Agent Sessionary 时代
rm -f ~/.local/bin/asry-open ~/.local/bin/asry-service
rm -rf ~/.config/agent-sessionary ~/.cache/asry-chrome
```

### 配置与环境变量对照

| 项目 | agenthist | Agent Sessionary | OpenSession |
|---|---|---|---|
| 环境变量前缀 | `AGENTHIST_` | `ASRY_` | `OPENSESSION_` |
| 项目位置记录 | `~/.config/agenthist/appdir` | `~/.config/agent-sessionary/appdir` | `~/.config/opensession/appdir` |
| Chrome 配置 | `~/.cache/agenthist-chrome` | `~/.cache/asry-chrome` | `~/.cache/opensession-chrome` |
| Windows 数据 | `%USERPROFILE%\.agenthist` | `%USERPROFILE%\.agent-sessionary` | `%USERPROFILE%\.opensession` |
| macOS 日志 | `~/Library/Logs/agenthist/` | `~/Library/Logs/agent-sessionary/` | `~/Library/Logs/opensession/` |

**会话数据不受影响** —— 这个工具从不搬动会话文件，改名只涉及它自己的命令、服务和配置。
你的 Codex / Claude / Pi / DeepSeek Harness / Hermes 会话一条都不会丢。
