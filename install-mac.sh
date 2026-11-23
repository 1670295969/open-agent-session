#!/usr/bin/env bash
# install-mac.sh —— 一键安装 / 修复 Agent Sessionary 的开机自启与桌面图标（macOS）
#
# 用法：
#   ./install-mac.sh              安装或修复（幂等，可重复跑）
#   ./install-mac.sh --status     只查看状态，不改动任何东西
#   ./install-mac.sh --uninstall  撤销（停服务、删桌面图标与自启项，保留数据）
#
# 与 Linux 的 install.sh 一一对应，但机制完全不同：
#
#   Linux                    macOS
#   -----------------------  --------------------------------------------
#   systemd user unit    →   launchd LaunchAgent（plist）
#   systemd Linger       →   RunAtLoad（登录即起）
#   Restart=on-failure   →   KeepAlive + ThrottleInterval
#   .desktop 文件         →   .app 包（Info.plist + 图标）
#   .svg 图标            →   .icns 图标
#   gsettings dock 固定   →   无对应机制（macOS 只能在 Dock 里手动拖，不做自动化）
#
# 为什么用 LaunchAgent 而不是 LaunchDaemon：
#   LaunchAgent 跑在用户会话里，能访问 ~/.claude 等家目录数据，也能调起 GUI；
#   LaunchDaemon 是系统级、以 root 跑，既读不到用户目录也不需要 root 权限。

set -uo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "本脚本仅适用于 macOS；Linux 请运行 ./install.sh，Windows 请运行 install.ps1" >&2
  exit 64
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SELF_DIR"
SERVER_JS="$APP_DIR/agent-sessionary-server.js"

APP_NAME="Agent Sessionary"
BUNDLE_ID="com.agentsessionary.viewer"
LABEL="com.agentsessionary.viewer"

LA_DIR="$HOME/Library/LaunchAgents"
PLIST="$LA_DIR/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/agent-sessionary"
APP_BUNDLE="$HOME/Applications/$APP_NAME.app"
DESKTOP_LINK="$HOME/Desktop/$APP_NAME.app"
ICNS="$APP_DIR/assets/agent-sessionary.icns"

MODE="install"
case "${1:-}" in
  --status)    MODE="status" ;;
  --uninstall) MODE="uninstall" ;;
  "")          ;;
  *) echo "未知参数：$1（可用：--status / --uninstall）" >&2; exit 64 ;;
esac

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '    ✓ %s\n' "$*"; }
warn() { printf '    ! %s\n' "$*"; }

# ---------- 选 node ----------
# 为什么不在 plist 里写死 node 全路径：WorkBuddy / nvm / Homebrew 升级后路径会变，
# 写死会在下次登录时静默失效。这里在安装时解析一次写进 plist，
# 并在 wrapper 里做二次兜底（见下），两边都改版本也能自愈。
pick_node() {
  if [ -n "${ASRY_NODE:-}" ] && [ -x "${ASRY_NODE}" ]; then
    printf '%s' "${ASRY_NODE}"; return 0
  fi
  # WorkBuddy 自带的 node 优先（与 Linux 侧一致），其次常见安装位置
  local known
  for known in \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2/bin/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    [ -x "$known" ] && { printf '%s' "$known"; return 0; }
  done
  local v
  v="$(ls -1d "$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "$v" ] && [ -x "$v" ] && { printf '%s' "$v"; return 0; }
  command -v node 2>/dev/null && return 0
  return 1
}

# ---------- 写服务 wrapper ----------
# launchd 的 ProgramArguments 只能是一个命令，而我们需要「补 PATH → 找 node → exec」，
# 所以落一个小 shell 脚本，plist 只负责调它。这样 plist 保持静态、逻辑可改。
SERVICE_SH="$APP_DIR/bin/asry-service-mac"
write_service() {
  cat > "$SERVICE_SH" << EOF
#!/bin/bash
# asry-service-mac —— 由 install-mac.sh 生成，可随时重跑安装脚本覆盖
#
# 为什么需要这一层：
#   1. launchd 给的环境极度贫瘠（PATH 仅 /usr/bin:/bin:/usr/sbin:/sbin），
#      而 codex / claude / pi 多装在 Homebrew（/opt/homebrew/bin）或 ~/.npm-global/bin，
#      不补 PATH 就会出现「页面内恢复报未找到命令」「模型下拉框是空的」。
#   2. node 路径含版本号，升级后会消失 —— 每次启动重新查找，比写死更耐用。
set -uo pipefail

APP_DIR="$APP_DIR"
ENTRY="\$APP_DIR/agent-sessionary-server.js"

log() { printf '[asry-service-mac] %s\n' "\$*" >&2; }
[ -f "\$ENTRY" ] || { log "找不到服务入口: \$ENTRY"; exit 78; }

for d in /opt/homebrew/bin /usr/local/bin "\$HOME/.local/bin" "\$HOME/.npm-global/bin" \\
         "\$HOME/.bun/bin" "\$HOME/bin" "\$HOME/.cargo/bin"; do
  case ":\$PATH:" in *":\$d:"*) ;; *) [ -d "\$d" ] && PATH="\$PATH:\$d" ;; esac
done
export PATH

NODE_BIN=""
for c in "$(pick_node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "\$c" ] && [ -x "\$c" ] && { NODE_BIN="\$c"; break; }
done
if [ -z "\$NODE_BIN" ]; then
  v="\$(ls -1d "\$HOME"/.workbuddy/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
  [ -n "\$v" ] && NODE_BIN="\$v"
fi
[ -n "\$NODE_BIN" ] || NODE_BIN="\$(command -v node 2>/dev/null || true)"
[ -n "\$NODE_BIN" ] || { log "找不到可用的 node"; exit 127; }

log "node: \$NODE_BIN"
log "PATH: \$PATH"

# 被 launchd 拉起时不要自动弹浏览器：用户自己点图标打开
export ASRY_NO_BROWSER="\${ASRY_NO_BROWSER:-1}"
export ASRY_PORT="\${ASRY_PORT:-8347}"

cd "\$APP_DIR" || exit 78
exec "\$NODE_BIN" "\$ENTRY"
EOF
  chmod 755 "$SERVICE_SH"
}

# ---------- 写 LaunchAgent ----------
write_plist() {
  mkdir -p "$LA_DIR" "$LOG_DIR"
  # ThrottleInterval 10：崩溃后 10 秒重试，避免端口冲突时疯狂重启刷日志
  # ProcessType=Interactive：让 launchd 认为它会碰 UI（会稍微提高调度优先级）
  # KeepAlive.SuccessfulExit=false：正常退出（比如手动 kill -TERM）不重启，
  #   异常退出才拉起来 —— 避免「停服务」被立刻自动重启
  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$SERVICE_SH</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>ProcessType</key>
    <string>Interactive</string>

    <key>WorkingDirectory</key>
    <string>$APP_DIR</string>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/agent-sessionary.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/agent-sessionary.err.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>ASRY_NO_BROWSER</key>
        <string>1</string>
    </dict>
</dict>
</plist>
EOF
}

# ---------- 写 .app 包 ----------
# 为什么做成 .app 而不是 .command 或 .alias：
#   1. .app 能挂自定义图标（.command 在 Finder 里是通用文档图标），点桌面图标才像个应用
#   2. .app 双击由 LaunchServices 打开，不会被 Gatekeeper 判为「未验证的脚本」
#   3. 可以在 Dock 里右键「保留在程序坞」，符合 macOS 使用习惯
#
# 注意：这是**本机生成**的包，没有 quarantine 扩展属性，不需要签名/公证。
write_app() {
  local bundle="$1"
  # 用绝对路径 /bin/rm，不走 PATH 里可能被 alias / 函数 / 包装器替换的 rm
  # （遇到过：某环境的 rm 是个转调废纸篓的函数，在非交互脚本里失败并静默，
  #   结果 rm -rf 变成空操作，旧包残留、图标看着没更新）
  /bin/rm -rf "$bundle" 2>/dev/null || true
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"

  cp "$ICNS" "$bundle/Contents/Resources/agent-sessionary.icns"

  cat > "$bundle/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>            <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>     <string>会话馆</string>
    <key>CFBundleIdentifier</key>      <string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key>         <string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key>     <string>APPL</string>
    <key>CFBundleExecutable</key>      <string>launch</string>
    <key>CFBundleIconFile</key>        <string>agent-sessionary</string>
    <key>LSMinimumSystemVersion</key>  <string>10.13</string>
    <!-- 启动器本身只活一两秒，不该在 Dock 里留一个占位图标 -->
    <key>LSUIElement</key>             <true/>
    <!-- 不声明为文档型应用，避免 Finder 拿它去开 .jsonl -->
    <key>CFBundleDocumentTypes</key>   <array/>
</dict>
</plist>
EOF

  cat > "$bundle/Contents/MacOS/launch" << EOF
#!/bin/bash
# Agent Sessionary 启动器（由 install-mac.sh 生成）
#
# 职责：探活 → 不活就请 launchd 拉起（拿不到 launchd 就直接起进程）→ 等就绪 → 开浏览器窗口。
# 为什么不直接 exec node：那样每次双击都起第二个实例（端口冲突），
# 而且关掉浏览器后 node 变孤儿进程，用户看不到、也停不掉。
set -uo pipefail

PORT="\${ASRY_PORT:-8347}"
BASE="http://127.0.0.1:\$PORT"
LABEL="$LABEL"
SERVER_JS="$SERVER_JS"
APP_DIR="$APP_DIR"

alive() { curl -s -o /dev/null --max-time 2 "\$BASE/api/models"; }

if ! alive; then
  # launchd 管着就用它（能常驻、崩溃自愈）；失败则自己起一个兜底
  launchctl kickstart -k "gui/\$(id -u)/\$LABEL" >/dev/null 2>&1 || true
  if ! alive; then
    PATH="/opt/homebrew/bin:/usr/local/bin:\$PATH"
    [ -x /bin/bash ] && nohup /bin/bash "$APP_DIR/bin/asry-service-mac" \\
      >/dev/null 2>&1 &
  fi
  for _ in \$(seq 1 40); do alive && break; sleep 0.25; done
fi

if ! alive; then
  osascript -e 'display alert "Agent Sessionary 启动失败" message "后端无响应，请查看 ~/Library/Logs/agent-sessionary/agent-sessionary.err.log"' >/dev/null 2>&1 || true
  exit 1
fi

# 优先 Chrome 独立窗口（无地址栏，像原生应用）；没有 Chrome 就用默认浏览器
CHROME=""
for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
         "/Applications/Chromium.app/Contents/MacOS/Chromium" \\
         "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \\
         "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
  [ -x "\$c" ] && { CHROME="\$c"; break; }
done

URL="\$BASE/"
if [ -n "\$CHROME" ]; then
  "\$CHROME" --app="\$URL" --window-size=1600,1000 --no-first-run \\
    --no-default-browser-check --user-data-dir="\$HOME/.cache/asry-chrome" \\
    >/dev/null 2>&1 &
else
  open "\$URL"
fi
exit 0
EOF
  chmod 755 "$bundle/Contents/MacOS/launch"

  # 让 Finder / LaunchServices 立刻认这个包（否则图标可能还是旧的缓存）
  touch "$bundle"
}

loaded() {
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1
}

port_alive() {
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8347/api/models"
}

# ============================ 动作 ============================

do_status() {
  step "Agent Sessionary 状态（macOS）"

  if loaded; then ok "LaunchAgent 已加载：$LABEL"; else warn "LaunchAgent 未加载"; fi
  if port_alive; then ok "服务在跑：http://127.0.0.1:8347"; else warn "服务无响应"; fi
  [ -f "$PLIST" ]     && ok "plist: $PLIST"        || warn "plist 不存在"
  [ -f "$SERVICE_SH" ]&& ok "wrapper: $SERVICE_SH" || warn "wrapper 不存在"
  [ -d "$APP_BUNDLE" ]&& ok "应用包: $APP_BUNDLE"  || warn "应用包不存在"
  [ -d "$DESKTOP_LINK" ] && ok "桌面图标：已创建"  || warn "桌面图标不存在"
  [ -f "$ICNS" ]      && ok "图标: agent-sessionary.icns" || warn "图标不存在（先跑 tools/make-icon.py）"

  step "node 与 PATH"
  printf '    node: %s\n' "$(pick_node || echo '未找到')"
  printf '    日志: %s\n' "$LOG_DIR/agent-sessionary.err.log"

  step "常用命令"
  say "    重启服务：launchctl kickstart -k gui/$(id -u)/$LABEL"
  say "    看日志：  tail -f ~/Library/Logs/agent-sessionary/agent-sessionary.err.log"
  say "    停服务：  launchctl bootout gui/$(id -u)/$LABEL"
}

do_install() {
  step "Agent Sessionary 安装（macOS）"

  if [ ! -f "$SERVER_JS" ]; then
    echo "找不到 $SERVER_JS，请在项目目录内运行本脚本" >&2
    exit 78
  fi

  NODE_BIN="$(pick_node)" || { echo "找不到 node，请先安装 Node.js" >&2; exit 127; }
  ok "node: $NODE_BIN"

  if [ ! -f "$ICNS" ]; then
    warn "缺少 assets/agent-sessionary.icns，尝试生成…"
    if command -v python3 >/dev/null 2>&1; then
      python3 "$APP_DIR/tools/make-icon.py" >/dev/null 2>&1 || warn "图标生成失败，将使用系统默认图标"
    fi
  fi

  say ""
  say "1) 写服务 wrapper"
  write_service
  ok "$SERVICE_SH"

  say "2) 写 LaunchAgent"
  mkdir -p "$LA_DIR" "$LOG_DIR"
  write_plist
  ok "$PLIST"

  say "3) 装载 / 重载 LaunchAgent"
  # bootout 后 bootout 会报错，用 || true 吞掉；bootout+load 比单纯 kickstart 更干净，
  # 能确保 plist 内容变更被重新读取（launchd 不热加载 plist）
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
    ok "bootstrap 成功"
  else
    # 旧版 macOS 没有 bootstrap，退回 load -w
    launchctl load -w "$PLIST" >/dev/null 2>&1 && ok "load -w 成功" || warn "装载失败，见下方提示"
  fi
  launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

  say "4) 等后端就绪"
  for _ in $(seq 1 40); do port_alive && break; sleep 0.25; done
  if port_alive; then ok "http://127.0.0.1:8347 已响应"; else warn "尚未响应，请查看 $LOG_DIR/agent-sessionary.err.log"; fi

  say "5) 生成应用包与桌面图标"
  write_app "$APP_BUNDLE"
  ok "$APP_BUNDLE"
  mkdir -p "$HOME/Desktop"
  write_app "$DESKTOP_LINK"
  ok "$DESKTOP_LINK"

  say ""
  say "完成。双击桌面上的「会话馆」即可打开；已设为登录自启。"
  say "查看状态：./install-mac.sh --status"
}

do_uninstall() {
  step "Agent Sessionary 卸载（macOS）"

  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  launchctl disable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  ok "已停用 LaunchAgent"

  # 删完必须复核：rm 在某些环境里会静默失败（见 write_app 里的注释），
  # 只报「已删」而不检查，等于把失败藏起来
  /bin/rm -f "$PLIST" 2>/dev/null || true
  if [ -e "$PLIST" ]; then warn "删除失败: $PLIST"; else ok "已删 $PLIST"; fi

  /bin/rm -rf "$APP_BUNDLE" "$DESKTOP_LINK" 2>/dev/null || true
  if [ -e "$APP_BUNDLE" ] || [ -e "$DESKTOP_LINK" ]; then
    warn "应用包删除不完整，请手动删除（可能需要关闭正在运行的窗口）"
    [ -e "$APP_BUNDLE" ]   && warn "  $APP_BUNDLE"
    [ -e "$DESKTOP_LINK" ] && warn "  $DESKTOP_LINK"
  else
    ok "已删应用包与桌面图标"
  fi

  say ""
  say "已卸载。数据（会话文件）、日志与 wrapper 保留："
  say "  $LOG_DIR"
  say "  $SERVICE_SH"
  say "如需彻底清理，自行删除上述目录。"
}

case "$MODE" in
  status)    do_status ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
