#!/usr/bin/env bash
# ============================================================================
# 重建远端仓库并推送干净历史
#
# 适用场景：远端历史里残留了不该公开的信息（作者姓名/邮箱、旧提交等），
#   而 GitHub 不允许删除已合并 PR 的 head ref，旧提交会永远可被匿名下载。
#   唯一彻底解法是删库重建，再用本脚本把本地干净历史推回去。
#
# 前置：
#   1. 旧仓库已在 GitHub 网页删除（Settings → Danger Zone）
#   2. 已创建同名空仓库（不要勾 Add a README / .gitignore / license）
#
# 用法：
#   bash tools/rebuild-remote-repo.sh <owner/repo>            # 执行
#   bash tools/rebuild-remote-repo.sh <owner/repo> --check    # 只检查不推送
#
# 环境变量：
#   GIT_REMOTE_URL   自定义推送地址（默认走 ssh.github.com:443，可绕 DNS 污染）
#   LEAK_PATTERNS    额外的敏感词，空格分隔
# ============================================================================
set -uo pipefail

REPO="${1:-}"
CHECK_ONLY=0
[ "${2:-}" = "--check" ] && CHECK_ONLY=1

if [ -z "$REPO" ]; then
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

REMOTE="${GIT_REMOTE_URL:-git@ssh.github.com:${REPO}.git}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME:-/home/user}"
SSH_CMD="ssh -p 443 -o StrictHostKeyChecking=no -o HostKeyAlias=ssh.github.com"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m▶ %s\033[0m\n' "$*"; }

cd "$PROJECT_DIR" || { red "项目目录不存在：$PROJECT_DIR"; exit 1; }
export GIT_SSH_COMMAND="$SSH_CMD"

# 敏感词：家目录、内网段、密钥标记；公司域名/真实姓名请用 LEAK_PATTERNS 传入
PATTERNS=("$HOME_DIR" "192\\.168\\." "BEGIN.*PRIVATE"
          "ghp_" "github_pat_" "sk-[A-Za-z0-9]{20}")
if [ -n "${LEAK_PATTERNS:-}" ]; then
  read -r -a _extra <<< "$LEAK_PATTERNS"
  PATTERNS+=("${_extra[@]}")
fi

scan_history() {
  local bad=0 n p
  for p in "${PATTERNS[@]}"; do
    n=$(git log -p --all 2>/dev/null | grep -cE "$p")
    if [ "$n" -gt 0 ]; then red "  ✗ $p : $n 处"; bad=1; else echo "    $p : 0"; fi
  done
  return $bad
}

# ---------------------------------------------------------------- 1. 本地校验
step "1/5 校验本地历史是否干净"
echo "  提交数: $(git rev-list --count HEAD)"
echo "  文件数: $(git ls-files | wc -l)"
echo "  树哈希: $(git rev-parse 'HEAD^{tree}')"
if ! scan_history; then
  red "本地历史仍有敏感信息，中止。先修本地再推。"
  exit 1
fi
grn "  本地干净"
echo "  作者分布："
git log --format='%an <%ae>' | sort | uniq -c | sort -rn | sed 's/^/    /'

# ---------------------------------------------------------------- 2. 远端校验
step "2/5 校验远端仓库状态"
heads=$(timeout 60 git ls-remote --heads "$REMOTE" 2>&1)
if [ $? -ne 0 ]; then
  red "  连不上远端。可能还没创建，或地址不对。"
  echo "  原始输出: $heads"
  exit 1
fi
if [ -z "$heads" ]; then
  grn "  远端为空仓库"
else
  ylw "  远端已有引用，将强制覆盖："
  echo "$heads" | sed 's/^/    /'
  [ "$CHECK_ONLY" -eq 0 ] && sleep 3
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  ylw ""
  ylw "--check 模式，不推送。"
  exit 0
fi

# ---------------------------------------------------------------- 3. 推送
step "3/5 推送（含全部历史）"
git remote set-url origin "$REMOTE"
timeout 300 git push -u origin HEAD:main --force 2>&1 | tail -8
if [ "${PIPESTATUS[0]}" -ne 0 ]; then red "推送失败"; exit 1; fi
grn "  推送完成"

# ---------------------------------------------------------------- 4. 默认分支
step "4/5 确认默认分支为 main"
if command -v gh >/dev/null 2>&1; then
  cur=$(gh api "repos/$REPO" --jq '.default_branch' 2>/dev/null)
  if [ "$cur" = "main" ]; then
    grn "  默认分支已是 main"
  else
    ylw "  当前为 ${cur:-未知}，尝试修改"
    gh api -X PATCH "repos/$REPO" -f default_branch=main --jq '.default_branch' 2>&1 | head -2 \
      || ylw "  改不了，请手动到 Settings → Default branch 设为 main"
  fi
else
  ylw "  未安装 gh，跳过（请手动确认默认分支）"
fi

# ---------------------------------------------------------------- 5. 远端复查
step "5/5 从远端全新克隆复查"
TMPV="$(mktemp -d)"
trap 'rm -rf "$TMPV"' EXIT
if ! timeout 180 git clone -q "$REMOTE" "$TMPV"; then red "克隆失败"; exit 1; fi
cd "$TMPV" || exit 1
echo "  分支："; git branch -r | sed 's/^/    /'
echo "  提交数：$(git rev-list --count HEAD)"
echo "  树哈希：$(git rev-parse 'HEAD^{tree}')"
bad=0
if ! scan_history; then bad=1; fi
echo "  作者分布："
git log --format='%an <%ae>' | sort | uniq -c | sort -rn | sed 's/^/    /'
if node -e "require('./lib/sessions');require('./lib/router')" 2>/dev/null; then
  grn "  模块可加载"
fi
cd "$PROJECT_DIR" || exit 1

if [ "$bad" -eq 0 ]; then
  grn ""
  grn "完成：远端历史已重建，敏感信息 0 处。"
  echo "https://github.com/$REPO"
else
  red ""
  red "仍存在敏感信息，请检查。"
  exit 1
fi
