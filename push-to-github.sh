#!/usr/bin/env bash
# 一键推送到 GitHub
#
# 用法：
#   ./push-to-github.sh                  # 默认推 open-agent-session
#   ./push-to-github.sh my-repo          # 换仓库名
#
# 前提：仓库已在 https://github.com/new 建好（空仓或有初始 commit 都能推）
#
# 两条通道与各自的坑（都实测过）：
#   1. HTTPS —— 本机 gh 的 fine-grained PAT 只授权到「令牌创建时勾选的仓库」，
#      对之后新建的仓库会返回 403 Resource not accessible by personal access token
#      （哪怕 API 显示 permissions.push=true）。所以 HTTPS 只作兜底。
#   2. SSH(443) —— 密钥对整个账号有效，是主通道。但本机 DNS 被劫持，
#      ssh.github.com 会解析到 198.18.0.130（代理假地址）导致 kex 失败。
#      因此下面会探测 GitHub 真实 IP 并用 Hostname 覆盖，SNI/主机名校验仍按
#      ssh.github.com 走，不影响可信性。
set -uo pipefail

REPO_NAME="${1:-open-agent-session}"
OWNER="$(gh api user --jq .login 2>/dev/null || echo "")"
if [ -z "$OWNER" ]; then
  echo "✗ 取不到 GitHub 用户名，先跑 gh auth status" >&2
  exit 1
fi

cd "$(dirname "$0")" || exit 1

# 仓库不存在就直接说清楚，别让 push 报一堆看不懂的错
if ! gh repo view "${OWNER}/${REPO_NAME}" >/dev/null 2>&1; then
  cat >&2 <<EOF
✗ 仓库 ${OWNER}/${REPO_NAME} 还不存在。

当前令牌是 fine-grained PAT，没有创建仓库的权限，所以这一步只能手动做：

  1. 打开 https://github.com/new
  2. Repository name 填：${REPO_NAME}
  3. 选 Private 或 Public（内容已脱敏）
  4. 不要勾 "Add a README" / .gitignore / license
  5. 创建好后再跑一次本脚本

EOF
  exit 1
fi

SSH_TARGET="ssh.github.com"
HTTPS_URL="https://github.com/${OWNER}/${REPO_NAME}.git"
SSH_URL="git@${SSH_TARGET}:${OWNER}/${REPO_NAME}.git"

# 找出一个能连上的 GitHub SSH(443) 真实 IP。直连不走代理时 DNS 可能被劫持。
# 注意：必须先把 ssh 输出收进变量再匹配，不能用 `ssh | grep -q`。
# 开启 pipefail 后，ssh 因「不提供 shell 访问」返回 1，会让整条管道判负，
# 即使 grep 成功。这是本脚本踩过的坑。
ssh_auth_ok() {
  local out
  out="$(timeout 15 ssh -p 443 -o StrictHostKeyChecking=no -o BatchMode=yes "$@" -T "git@${SSH_TARGET}" 2>&1)"
  case "$out" in
    *"successfully authenticated"*) return 0 ;;
    *) return 1 ;;
  esac
}

probe_ssh_host() {
  local ip
  for ip in "$@"; do
    timeout 6 bash -c "cat < /dev/null > /dev/tcp/${ip}/443" 2>/dev/null || continue
    if ssh_auth_ok -o HostKeyAlias="$SSH_TARGET" -o Hostname="$ip"; then
      echo "$ip"
      return 0
    fi
  done
  return 1
}

URL="$HTTPS_URL"
if ssh_auth_ok -o HostKeyAlias="$SSH_TARGET"; then
  echo "→ SSH(443) 直连可用"
  URL="$SSH_URL"
  export GIT_SSH_COMMAND="ssh -p 443 -o StrictHostKeyChecking=no -o HostKeyAlias=${SSH_TARGET}"
else
  echo "→ DNS 解析不可用，探测 GitHub 真实 IP…"
  SSH_IP="$(probe_ssh_host 140.82.121.35 140.82.113.35 140.82.112.35 140.82.114.35 140.82.116.35)"
  if [ -n "$SSH_IP" ]; then
    echo "→ SSH(443) 走真实 IP ${SSH_IP}"
    URL="$SSH_URL"
    export GIT_SSH_COMMAND="ssh -p 443 -o StrictHostKeyChecking=no -o HostKeyAlias=${SSH_TARGET} -o Hostname=${SSH_IP}"
  else
    echo "→ SSH 全部不通，退回 HTTPS（新建仓库可能 403）"
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$URL"
else
  git remote add origin "$URL"
fi

echo "→ 推送到 $URL"
# 远端若只有网页初始化的一行 README，本地历史与之无关，用 force-with-lease
# （带租约保护：远端被别人改过会自动拒绝，不会盲覆盖）
if git push -u origin main; then
  echo "✓ 完成：https://github.com/${OWNER}/${REPO_NAME}"
  exit 0
fi

echo "→ 常规推送失败（可能是远端有独立初始 commit），尝试 force-with-lease 覆盖"
git push -u --force-with-lease origin main || {
  echo "✗ 推送失败。若报 403 说明当前令牌对该仓库没有 Contents:write，请改用 SSH 或换令牌。" >&2
  exit 1
}
echo "✓ 完成：https://github.com/${OWNER}/${REPO_NAME}"
