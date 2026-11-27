#!/usr/bin/env bash
# opensession-tunnel —— 在「另一台设备」上建立 SSH 隧道，访问远端 OpenSession
#
# 这个脚本给**客户端**用（你的笔记本 / 另一台机器），不是给跑 OpenSession 的那台用。
#
# 原理：OpenSession 只监听 127.0.0.1:8347，本来只有本机能开。
# 用 SSH 本地端口转发把「客户端的 127.0.0.1:8347」接到「服务端的 127.0.0.1:8347」，
# 浏览器里就是本机地址 —— 服务端代码零改动，且因为是 127.0.0.1 属于安全上下文，
# 剪贴板 API、EventSource(SSE)、所有 /api 都正常。
#
# 用法：
#   ./tunnel-client.sh me@192.168.1.10                   # 同一局域网
#   ./tunnel-client.sh me@myhost.example.com -p 2222  # 换了 SSH 端口
#   ./tunnel-client.sh me@host -l 9000                # 本地换端口（8347 被占用时）
#   ./tunnel-client.sh me@host -i ~/.ssh/opensession_tunnel   # 用受限密钥
#
# 连上后浏览器打开 http://127.0.0.1:8347（或你 -l 指定的端口）。退出：Ctrl+C

set -uo pipefail

HOST=""
SSH_PORT=22
LOCAL_PORT=8347
REMOTE_PORT=8347
TUNNEL_KEY="${TUNNEL_KEY:-}"

# 帮助文本从文件头的注释块里抽，按标记而不是行号——
# 早先写死 `sed -n '2,20p'`，加两行注释后帮助就截断了。
usage() {
  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)    SSH_PORT="$2"; shift 2 ;;
    -l|--local)   LOCAL_PORT="$2"; shift 2 ;;
    -r|--remote)  REMOTE_PORT="$2"; shift 2 ;;
    -i|--key)     TUNNEL_KEY="$2"; shift 2 ;;
    -h|--help)    usage 0 ;;
    -*)           echo "未知参数：$1" >&2; usage 1 ;;
    *)            HOST="$1"; shift ;;
  esac
done

[ -n "$HOST" ] || { echo "缺少目标，例：./tunnel-client.sh me@192.168.1.10" >&2; exit 1; }
command -v ssh >/dev/null 2>&1 || { echo "本机没有 ssh 命令" >&2; exit 1; }

KEY_ARGS=()
if [ -n "$TUNNEL_KEY" ]; then
  [ -f "$TUNNEL_KEY" ] || { echo "私钥不存在：$TUNNEL_KEY" >&2; exit 1; }
  KEY_ARGS=(-i "$TUNNEL_KEY" -o IdentitiesOnly=yes)
fi

# 本地端口预检。不检的话 ssh 只会甩一句
#   bind [127.0.0.1]:8347: Address already in use
# 而不说明该换哪个参数（ExitOnForwardFailure 也是同样的粗暴提示）。
port_busy() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${p}") 2>/dev/null
  fi
}

if port_busy "$LOCAL_PORT"; then
  echo "本地端口 ${LOCAL_PORT} 已被占用。" >&2
  echo "  · 若这台就是跑 OpenSession 的机器，直接开 http://127.0.0.1:${LOCAL_PORT} 即可，不需要隧道" >&2
  echo "  · 否则换一个本地端口：$0 $HOST -l 9347" >&2
  exit 1
fi

echo "→ 建立隧道  127.0.0.1:${LOCAL_PORT}  ⇄  ${HOST}:${REMOTE_PORT}"
echo "→ 连上后浏览器打开： http://127.0.0.1:${LOCAL_PORT}"
echo "→ 按 Ctrl+C 断开"
echo

# ExitOnForwardFailure：端口占用时直接失败，而不是静默不转发
# ServerAliveInterval：防止空闲被 NAT 掐掉（每 30s 探活）
# ConnectTimeout=10：主机不可达/防火墙丢包时 10 秒内报错退出，
#   否则 ssh 会静默挂着，看起来像「卡住了」——踩过。
# StrictHostKeyChecking=accept-new：首次自动接受主机密钥，之后密钥若变则**拒绝**
#   不加这条，首次连接会卡在 "Host key verification failed"（无 ssh-askpass 的机器直接失败）
#    这些都是踩过的坑：少了 ExitOnForwardFailure 会「看起来连上了但页面打不开」。
exec ssh -N \
  "${KEY_ARGS[@]}" \
  -p "$SSH_PORT" \
  -L "${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
  -o ExitOnForwardFailure=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=accept-new \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  "$HOST"
