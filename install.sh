#!/usr/bin/env bash
# install.sh —— 一键安装 / 修复 OpenSession 的开机服务与桌面快捷方式
#
# 用法：
#   ./install.sh            安装或修复（幂等，可重复跑）
#   ./install.sh --status   只查看状态，不改动任何东西
#   ./install.sh --uninstall 撤销（停服务、删桌面图标，保留数据）
#
# 会做的事：
#   1. 生成 ~/.local/bin/opensession-service（服务 wrapper，自动找 node）
#   2. 写入 ~/.config/systemd/user/opensession.service 并 enable（开机自启）
#   3. 打开 linger，让服务在登录前也能起来
#   4. 安装图标 + 桌面快捷方式，并标记「可信」（GNOME 双击必需）
#
# 之所以把 1、2 也放进脚本：node 路径含版本号，WorkBuddy 升级后旧 unit 会失效，
# 重跑一次本脚本就能自动指向新版本。

set -uo pipefail

# 本脚本只处理 Linux 桌面（systemd + .desktop + GNOME dock）。
# 其余两个平台请用同目录的对应脚本 —— 提前拦下，避免跑到一半报一堆
# 「systemctl 不存在」这类看不出根因的错。
case "$(uname -s)" in
  Linux) ;;
  Darwin)
    echo "本脚本仅适用于 Linux；macOS 请运行：./install-mac.sh" >&2
    exit 64 ;;
  *)
    echo "本脚本仅适用于 Linux；Windows 请运行：powershell -ExecutionPolicy Bypass -File install.ps1" >&2
    exit 64 ;;
esac

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$SELF_DIR"
SERVER_JS="$APP_DIR/opensession-server.js"

BIN_DIR="$HOME/.local/bin"
OPEN_BIN="$BIN_DIR/opensession-open"
SVC_BIN="$BIN_DIR/opensession-service"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/opensession.service"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
ICON="$ICON_DIR/opensession.svg"
DESKTOP_APPS="$HOME/.local/share/applications/opensession.desktop"

MODE="install"
case "${1:-}" in
  --status)    MODE="status" ;;
  --uninstall) MODE="uninstall" ;;
  "")          ;;
  *) echo "未知参数：$1（可用：--status / --uninstall）" >&2; exit 64 ;;
esac

# WorkBuddy sandbox 里 systemctl --user 会报 "Failed to connect to bus"：
# uid 被映射成 0，而 bus 期望 1000；即便 unshare 还原 uid，systemctl 的运行时目录
# 属主校验仍不通过。实测 busctl 显式指定地址可稳定连上，所以这里全走 busctl。
#
# 坑：busctl 对 `--address="$VAR"` 会报 "Failed to create bus message: Invalid argument"，
# 必须把地址字面量直接拼在 --address= 后面（下面用 eval 里的单引号固定住）。
BUS_ADDR='unix:path=/run/user/1000/bus'
UNIT_OBJ="/org/freedesktop/systemd1/unit/opensession_2eservice"

# 在正确 uid 下执行（sandbox 里 uid 0 的 DBus EXTERNAL 凭据会被 bus 拒绝）
as_user() {
  if [ "$(id -u)" = "0" ] && command -v unshare >/dev/null 2>&1; then
    unshare --user --map-user=1000 --map-group=1000 -- \
      env HOME="$HOME" XDG_RUNTIME_DIR=/run/user/1000 \
      bash -c 'export XDG_RUNTIME_DIR=/run/user/1000; exec "$@"' _ "$@"
  else
    XDG_RUNTIME_DIR=/run/user/1000 "$@"
  fi
}

# ---- dock（左侧导航栏）固定 ----
# Ubuntu 22.04 的左侧栏来自 ubuntu-dock 扩展，它的「固定应用」列表就是
# org.gnome.shell favorite-apps（XDG_CURRENT_DESKTOP=ubuntu:GNOME 时
# dash-to-dock 的 dock-position 默认为 LEFT）。
#
# 坑：sandbox 里直接 gsettings set 会返回 0 但值不变（dconf 写被拦，且 uid=0
# 写的不是 liu 的库），必须走 as_user + 会话 bus 才真正落盘。
DESKTOP_ID="opensession.desktop"
dock_gsettings() { as_user env DBUS_SESSION_BUS_ADDRESS="$BUS_ADDR" gsettings "$@"; }

dock_pinned() {
  dock_gsettings get org.gnome.shell favorite-apps 2>/dev/null | grep -q "$DESKTOP_ID"
}

do_pin_dock() {
  local cur new
  cur="$(dock_gsettings get org.gnome.shell favorite-apps 2>/dev/null)"
  if [ -z "$cur" ]; then
    echo "! 读不到 favorite-apps（无桌面会话？），跳过固定"
    return 0
  fi
  if printf '%s' "$cur" | grep -q "$DESKTOP_ID"; then
    echo "✓ 已在左侧导航栏固定"
    return 0
  fi
  # 排到 workbuddy 后面（同类工具挨着），没有就放最前
  if printf '%s' "$cur" | grep -q "'workbuddy.desktop'"; then
    new="$(printf '%s' "$cur" | sed "s/'workbuddy\.desktop',/'workbuddy.desktop', '$DESKTOP_ID',/")"
  else
    new="$(printf '%s' "$cur" | sed "s/^\[/['$DESKTOP_ID', /")"
  fi
  if dock_gsettings set org.gnome.shell favorite-apps "$new" 2>/dev/null; then
    if dock_pinned; then
      echo "✓ 已固定到左侧导航栏"
    else
      echo "! 固定未生效（dconf 写入被拦），请手动拖图标到导航栏"
    fi
  else
    echo "! 固定失败，请手动拖图标到导航栏"
  fi
}

do_unpin_dock() {
  local cur new
  cur="$(dock_gsettings get org.gnome.shell favorite-apps 2>/dev/null)"
  [ -z "$cur" ] && return 0
  printf '%s' "$cur" | grep -q "$DESKTOP_ID" || return 0
  new="$(printf '%s' "$cur" | sed "s/'$DESKTOP_ID', //; s/, '$DESKTOP_ID'//")"
  # 列表只剩它一个时上面两个模式都匹配不到（既无前导逗号也无后继逗号）
  printf '%s' "$new" | grep -q "$DESKTOP_ID" && new="[]"
  dock_gsettings set org.gnome.shell favorite-apps "$new" 2>/dev/null || true
  echo "✓ 已从左侧导航栏移除"
}

# 统一把 busctl 参数用字面量地址拼好再执行
sd_call() {  # sd_call <Method> [签名 参数...]
  as_user busctl --address=unix:path=/run/user/1000/bus call \
    org.freedesktop.systemd1 /org/freedesktop/systemd1 \
    org.freedesktop.systemd1.Manager "$@" 2>&1
}

sd_unit_state() {  # ActiveState（空表示查询失败）
  as_user busctl --address=unix:path=/run/user/1000/bus get-property \
    org.freedesktop.systemd1 "$UNIT_OBJ" org.freedesktop.systemd1.Unit ActiveState 2>/dev/null \
    | awk '{gsub(/"/,"",$2); print $2}'
}

sd_enabled() {  # enabled / disabled / static ...
  sd_call GetUnitFileState s opensession.service 2>/dev/null \
    | awk '{gsub(/"/,"",$2); print $2}'
}

# ---------------------------------------------------------------- status
do_status() {
  echo "== 服务 =="
  local st en
  st="$(sd_unit_state)"; en="$(sd_enabled)"
  echo "  运行: ${st:-查询失败}"
  echo "  自启: ${en:-查询失败}"
  echo "  开机免登录启动(linger): $(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || echo unknown)"
  echo "== 端口 =="
  if curl -s -o /dev/null --max-time 3 http://127.0.0.1:8347/api/models; then
    echo "  8347: 正常（HTTP 200）"
  else
    echo "  8347: 无响应"
  fi
  echo "== 桌面入口 =="
  for f in "$OPEN_BIN" "$SVC_BIN" "$UNIT" "$ICON" "$DESKTOP_APPS" "$HOME/桌面/opensession.desktop"; do
    if [ -e "$f" ]; then echo "  ✓ $f"; else echo "  ✗ 缺失 $f"; fi
  done
  echo "== 左侧导航栏 =="
  if dock_pinned; then
    echo "  ✓ 已固定（favorite-apps）"
  else
    echo "  ✗ 未固定"
  fi
}

# ---------------------------------------------------------------- install
do_install() {
  mkdir -p "$BIN_DIR" "$UNIT_DIR" "$ICON_DIR" \
           "$HOME/.local/share/applications" "$HOME/桌面"

  # --- 0) 启动脚本（项目里的 bin/ 为准，复制到 ~/.local/bin 便于全局调用）---
  # 复制出去后脚本与本项目的相对位置就断了，所以把项目路径记到
  # ~/.config/opensession/appdir，脚本按它回找（也支持 OPENSESSION_HOME 覆盖）。
  mkdir -p "$HOME/.config/opensession"
  printf '%s\n' "$APP_DIR" > "$HOME/.config/opensession/appdir"
  echo "✓ 项目位置记录 $HOME/.config/opensession/appdir"

  local pair
  for pair in "opensession-open:$OPEN_BIN" "opensession-service:$SVC_BIN"; do
    local src="$APP_DIR/bin/${pair%%:*}" dst="${pair##*:}"
    if [ -f "$src" ]; then
      cp "$src" "$dst" && chmod 775 "$dst" && echo "✓ $dst"
    else
      echo "! 缺少 $src（跳过 ${pair##*:}）"
    fi
  done

  # --- 1) 图标 ---
  cat > "$ICON" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#3d5afe"/>
      <stop offset="1" stop-color="#7c4dff"/>
    </linearGradient>
  </defs>
  <rect x="3" y="6" width="58" height="46" rx="7" fill="url(#g)"/>
  <rect x="11" y="15" width="26" height="3.4" rx="1.7" fill="#fff" opacity=".95"/>
  <rect x="11" y="23" width="40" height="3.4" rx="1.7" fill="#fff" opacity=".8"/>
  <rect x="11" y="31" width="33" height="3.4" rx="1.7" fill="#fff" opacity=".65"/>
  <rect x="11" y="39" width="20" height="3.4" rx="1.7" fill="#fff" opacity=".5"/>
  <path d="M20 52h24l-4 7H24z" fill="#2a36b1"/>
  <circle cx="52" cy="50" r="10" fill="#00c853" stroke="#fff" stroke-width="2.5"/>
  <path d="M47.5 50.2l3.2 3.2 6-6.4" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
SVG
  echo "✓ 图标 $ICON"

  # --- 2) 桌面入口 ---
  cat > "$DESKTOP_APPS" <<DESKTOP
[Desktop Entry]
Version=1.0
Type=Application
Name=OpenSession
Name[zh_CN]=OpenSession
GenericName=Agent Session Browser
GenericName[zh_CN]=Agent 会话浏览器
Comment=聚合查看 Codex CLI / Claude Code / Pi / Hermes 的历史会话
Comment[zh_CN]=聚合查看 Codex CLI / Claude Code / Pi / Hermes 的历史会话
Exec=$OPEN_BIN --app
TryExec=$OPEN_BIN
Path=$APP_DIR
Icon=opensession
Terminal=false
Categories=Development;
Keywords=session;history;conversation;codex;claude;pi;hermes;会话;
StartupNotify=true
StartupWMClass=OpenSession
DESKTOP
  chmod 664 "$DESKTOP_APPS"
  cp "$DESKTOP_APPS" "$HOME/桌面/opensession.desktop"
  chmod 775 "$HOME/桌面/opensession.desktop"

  # 信任标记：GNOME 下没有它双击会弹「不受信任的应用程序启动器」。
  # gio 的 metadata 存在 dconf 里，必须带着会话 bus 才写得进去（只 unshare 不够）。
  local trusted=""
  if as_user env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
       gio set "$HOME/桌面/opensession.desktop" metadata::trusted true >/dev/null 2>&1; then
    trusted="$(as_user env DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
      gio info -a metadata::trusted "$HOME/桌面/opensession.desktop" 2>/dev/null | grep -o 'true' | head -1)"
  fi
  if [ "$trusted" = "true" ]; then
    echo "✓ 桌面图标已信任"
  else
    echo "! 信任标记未写入，首次双击请右键选「允许启动」（仅需一次）"
  fi
  update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
  echo "✓ 桌面快捷方式 $HOME/桌面/opensession.desktop"

  # --- 2.5) 固定到左侧导航栏（Ubuntu dock）---
  do_pin_dock

  # --- 3) systemd unit ---
  cat > "$UNIT" <<UNITEOF
[Unit]
Description=OpenSession (opensession) — 聚合 codex/claude/pi/hermes 会话历史
Documentation=file://$APP_DIR/README.md
After=network.target
ConditionPathExists=$SERVER_JS
# 连续崩溃的退避阈值。这两项属于 [Unit]；写进 [Service] 会被 systemd 249 静默忽略
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
# 走 wrapper 而不是直写 node：node 路径含版本号，升级后会失效
ExecStart=$SVC_BIN
WorkingDirectory=$APP_DIR
Environment=OPENSESSION_NO_BROWSER=1
Environment=OPENSESSION_PORT=8347
# 崩溃自动重启；正常退出（exit 0）不重启
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opensession

[Install]
WantedBy=default.target
UNITEOF
  chmod 664 "$UNIT"
  echo "✓ unit $UNIT"

  # --- 4) 启用 + 启动 ---
  sd_call Reload >/dev/null

  # enable：写 default.target.wants 软链。systemctl enable 在 sandbox 里连不上总线，
  # 所以直接建软链（等价于 systemctl --user enable）
  mkdir -p "$UNIT_DIR/default.target.wants"
  ln -sf "$UNIT" "$UNIT_DIR/default.target.wants/opensession.service"
  if [ -L "$UNIT_DIR/default.target.wants/opensession.service" ]; then
    echo "✓ 已设为开机自启（default.target.wants 软链）"
  else
    echo "! 自启软链创建失败"
  fi

  sd_call RestartUnit ss opensession.service replace >/dev/null
  sleep 2
  local st; st="$(sd_unit_state)"
  if [ "$st" = "active" ]; then
    echo "✓ 服务已启动（active）"
  else
    echo "! 服务状态=${st:-未知}"
  fi

  # linger：让 user 实例在无人登录时也常驻（否则重启后要等登录才起）
  if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null)" != "yes" ]; then
    loginctl enable-linger "$USER" 2>/dev/null && echo "✓ 已开启 linger（免登录自启）"
  else
    echo "✓ linger 已开启（免登录自启）"
  fi

  if curl -s -o /dev/null --max-time 4 http://127.0.0.1:8347/api/models; then
    echo "✓ 健康检查通过：http://127.0.0.1:8347"
  else
    echo "! 健康检查失败：journalctl --user -u opensession -n 50 --no-pager"
  fi
}

# ---------------------------------------------------------------- uninstall
do_uninstall() {
  do_unpin_dock
  sd_call StopUnit ss opensession.service replace >/dev/null
  rm -f "$UNIT_DIR/default.target.wants/opensession.service"
  rm -f "$UNIT" "$DESKTOP_APPS" "$HOME/桌面/opensession.desktop" "$ICON"
  sd_call Reload >/dev/null
  echo "已撤销服务与桌面图标（$SVC_BIN / $OPEN_BIN 保留，可手动删）"
}

case "$MODE" in
  status)    do_status ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
esac
