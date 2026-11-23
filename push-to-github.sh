#!/usr/bin/env bash
# 一键推送到 GitHub —— 仓库需先在网页上建好（当前令牌没有建仓权限）
#
# 用法：
#   ./push-to-github.sh                  # 默认 agent-sessionary
#   ./push-to-github.sh my-repo          # 换仓库名
#
# 前提：已在 https://github.com/new 建好同名**空仓库**（不要勾 README / gitignore / license）
#
# 为什么优先用 SSH：本机 gh 的 fine-grained PAT 只被授权到既有仓库，
# 新建的仓库可能不在其范围内；而 SSH 密钥对整个账号有效，且实测 22 端口不通、
# 443 端口的 ssh.github.com 可用。
set -uo pipefail

REPO_NAME="${1:-agent-sessionary}"
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
  3. 选 Private（公开也行，内容已脱敏）
  4. **不要**勾 "Add a README" / .gitignore / license
  5. 创建好后再跑一次本脚本

EOF
  exit 1
fi

# 探一下 443 端口的 SSH 通道（22 端口在本机被拦）
SSH_URL="git@ssh.github.com:${OWNER}/${REPO_NAME}.git"
HTTPS_URL="https://github.com/${OWNER}/${REPO_NAME}.git"
GIT_SSH_443="ssh -p 443 -o StrictHostKeyChecking=no"

if GIT_SSH_COMMAND="$GIT_SSH_443" git ls-remote "$SSH_URL" >/dev/null 2>&1; then
  URL="$SSH_URL"
  export GIT_SSH_COMMAND="$GIT_SSH_443"
  echo "→ 走 SSH(443)"
else
  URL="$HTTPS_URL"
  echo "→ 走 HTTPS"
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$URL"
else
  git remote add origin "$URL"
fi

echo "→ 推送到 $URL"
git push -u origin main && echo "✓ 完成：https://github.com/${OWNER}/${REPO_NAME}"
