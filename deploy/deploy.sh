#!/usr/bin/env bash
# English Learning Tool — 服务器部署脚本（在服务器上的仓库检出目录内执行）
#
# 用法：
#   cd /path/to/english-review && ./deploy/deploy.sh
# 可用环境变量覆盖：TARGET_DIR（默认 /opt/english-learning/app）
#
# 步骤（幂等，可重复执行）：
#   1. 仓库根 pnpm install
#   2. pnpm --filter @el/web run build（生成 apps/web/dist）
#   3. rsync 仓库 → TARGET_DIR（排除 node_modules / data / .git / 测试产物）
#   4. TARGET_DIR 内 pnpm install（tsx 运行时依赖），并在根 node_modules/.bin
#      校验 apps/api/node_modules/.bin/tsx 就绪（systemd unit 的 ExecStart 指向它）
#   5. systemctl daemon-reload + enable/restart english-learning-api
#   6. 打印后续手动步骤（timers / nginx，见 deploy/README.md）
#
# 说明：数据库 migration 不在此执行 —— API 启动时自动运行 runMigrations。
set -euo pipefail

TARGET_DIR="${TARGET_DIR:-/opt/english-learning/app}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIST="$REPO_DIR/apps/web/dist"

log() { printf '\n==> %s\n' "$*"; }

if ! command -v pnpm >/dev/null 2>&1; then
  echo "错误：未找到 pnpm（先安装 Node >= 20 与 pnpm）" >&2
  exit 1
fi
if ! command -v rsync >/dev/null 2>&1; then
  echo "错误：未找到 rsync（sudo apt-get install -y rsync）" >&2
  exit 1
fi

SUDO=""
if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
fi

# ---------- 1. 安装依赖（仓库检出目录） ----------
log "1/5 pnpm install（仓库：$REPO_DIR）"
pnpm --dir "$REPO_DIR" install --frozen-lockfile

# ---------- 2. 构建前端 ----------
log "2/5 构建 web（apps/web/dist）"
pnpm --dir "$REPO_DIR" --filter @el/web run build
if [[ ! -f "$WEB_DIST/index.html" ]]; then
  echo "错误：web 构建产物缺失（$WEB_DIST/index.html）" >&2
  exit 1
fi

# ---------- 3. 同步到目标目录 ----------
log "3/5 rsync → $TARGET_DIR"
$SUDO mkdir -p "$TARGET_DIR"
$SUDO rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude '.git/' \
  --exclude 'apps/api/data/' \
  --exclude 'playwright-report/' \
  --exclude 'test-results/' \
  --exclude 'coverage/' \
  "$REPO_DIR/" "$TARGET_DIR/"

# ---------- 4. 目标目录安装运行依赖 ----------
log "4/5 pnpm install（目标：$TARGET_DIR）"
$SUDO env "PATH=$PATH" pnpm --dir "$TARGET_DIR" install --frozen-lockfile

# systemd unit 的 ExecStart 使用 apps/api 自己的 .bin/tsx（pnpm 的 shim 按 realpath 解析，
# 根级软链会导致模块解析到错误目录）。
log "4/5 确认 tsx 可执行入口存在（apps/api/node_modules/.bin/tsx）"
if [[ ! -x "$TARGET_DIR/apps/api/node_modules/.bin/tsx" ]]; then
  echo "错误：$TARGET_DIR/apps/api/node_modules/.bin/tsx 不可用" >&2
  exit 1
fi

# ---------- 5. systemd ----------
log "5/5 重启 api 服务"
if [[ -f /etc/systemd/system/english-learning-api.service ]]; then
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable english-learning-api
  $SUDO systemctl restart english-learning-api
  echo "api 已重启。状态：systemctl status english-learning-api"
else
  echo "提示：尚未安装 systemd unit（见 deploy/README.md 步骤 4），本次跳过服务重启。"
fi

# ---------- 后续手动步骤 ----------
log "部署完成。后续步骤（首次上线时执行，详见 deploy/README.md）："
cat <<'EOF'
  4. 安装 systemd units 与 timers：
     sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
     sudo systemctl daemon-reload
     sudo systemctl enable --now english-learning-api \
       english-learning-{prefetch,backup,cleanup,maintenance}.timer
     systemctl list-timers | grep english-learning
  5. 配置 nginx（替换 __DOMAIN__ 后启用，certbot 签发证书后放开 443 段）：
     见 deploy/nginx/english-learning.conf.template 与 deploy/README.md 步骤 5-6
  6. smoke：浏览器登录 → Today → Library；curl -fsS https://<域名>/api/health
EOF
