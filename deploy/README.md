# deploy/ — 上线与运维（Ubuntu + systemd + nginx + S3 备份）

本目录包含 English Learning Tool V1.2 的全部部署设施：

| 文件 | 说明 |
| --- | --- |
| `deploy.sh` | 服务器部署脚本（构建 web → rsync → 安装依赖 → 重启 api），幂等可重复 |
| `systemd/english-learning-api.service` | API 常驻服务（`Restart=always`） |
| `systemd/english-learning-{prefetch,backup,cleanup,maintenance}.{service,timer}` | 四个定时 job（`Type=oneshot` + timer） |
| `nginx/english-learning.conf.template` | nginx 站点模板（`__DOMAIN__` 占位；443 段预留为注释） |

定时计划（全部 `Persistent=true`，错过会在下次启动补跑）：

| job | 频率 | 职责 |
| --- | --- | --- |
| daily-prefetch | 每日 04:00 | 预生成未来 48h 到期题目 |
| weekly-cleanup | 每周日 03:00 | 生命周期清理（retired/bad 题、过期 Read、60 天明细、12 个月 tasks/sessions） |
| daily-backup | 每日 05:00 | SQLite 一致性快照 → S3（保留 30 天，本地临时文件上传后即删） |
| monthly-maintenance | 每月 1 日 02:00 | 表膨胀检查（只告警）+ 月度长期快照（保留 12 个月） |


## 快速模式：IP + 端口直访（无域名无证书，本机已实施）

适合自用/测试：`http://<服务器IP>:8080`，浏览器直接访问。

- 生产 env 关键项：`NODE_ENV=production`、**`COOKIE_SECURE=false`**（HTTP 必须，否则登录 Cookie 不回传）、`APP_ORIGINS=http://<IP>:8080`
- nginx：`deploy/nginx/` 的 80 段改 `listen 8080`、`server_name _`，root 指向 web dist
- **注意本服务器 nginx 用 `conf.d/` 而非 `sites-enabled/`**：站点文件放 `/etc/nginx/conf.d/english-review.conf`
- 代价：明文 HTTP（密码可被同网络嗅探，家用网络可接受）；**PWA 的 Service Worker/安装到主屏不可用**（浏览器仅信任 HTTPS 的 SW），网页功能不受影响
- 日后想上 HTTPS/PWA：免费域名或 `1-2-3-4.nip.io`（解析到 IP）+ certbot，切到 443 或其他端口

## 服务器目录约定（TECHNICAL_DESIGN §17）

```text
/opt/english-learning/app       # 代码（deploy.sh rsync 目标）
/var/lib/english-learning/      # SQLite 与快照目录
/etc/english-learning/env       # 服务环境变量（systemd EnvironmentFile）
```

---

## 上线 checklist

### 0. 服务器前置条件

- Ubuntu（nginx 1.18、systemd 249 或更高）
- Node.js >= 20.19、pnpm（`corepack enable` 或 `npm i -g pnpm`）
- `aws-cli` v1（`sudo apt-get install -y awscli`）并配置好 S3 凭证（`aws configure` 或实例 IAM 角色）
- `rsync`、`nginx`（`sudo apt-get install -y nginx rsync`）

### 1. DNS

为服务器公网 IP 添加 A 记录（例如 `english.example.com`）。等待解析生效：

```bash
dig +short english.example.com
```

### 2. /etc/english-learning/env（完整变量清单）

```bash
sudo mkdir -p /etc/english-learning
sudo cp .env.example /etc/english-learning/env
sudo chmod 600 /etc/english-learning/env
sudo nano /etc/english-learning/env
```

逐项修改（生产必填项加粗）：

```ini
# ---- API ----
PORT=5174                      # nginx 反代目标，保持默认
HOST=127.0.0.1                 # 只监听本机，由 nginx 对外
**NODE_ENV=production**
**SESSION_SECRET=<随机 >=32 字符>**   # 例如：openssl rand -hex 32
# 访问密码（二选一，HASH 优先；生产推荐 HASH）
**AUTH_PASSWORD=<强密码>**
# AUTH_PASSWORD_HASH=<hex盐>:<hex哈希>   # 生成命令见下
**DATABASE_PATH=/var/lib/english-learning/prod.db**
**APP_ORIGINS=https://english.example.com**
APP_TIMEZONE=Asia/Shanghai

# ---- GLM ----
**GLM_API_KEY=<密钥>**
GLM_API_BASE=https://open.bigmodel.cn/api/anthropic
GLM_MODEL_FLASH=
GLM_MODEL_AIR=
GLM_MODEL_MAX=
GLM_MAX_TOKENS=8192
GLM_THINKING=

# ---- 备份（S3 可选）----
# 不设置 = 本地备份模式：快照存 <数据库目录>/snapshots/，日备 daily-<日期>.db 保留 30 天、
# 月备 monthly-<年月>.db 保留 12 个月，自动轮转，无需任何云依赖
# 设置 = S3 异地容灾模式：快照上传 s3://<bucket>/english-review/{daily,monthly}/，本地不留副本
S3_BUCKET=
# AWS 凭证不要写在这里：aws-cli 用实例 IAM 角色或 root 的 `aws configure`
```

`AUTH_PASSWORD_HASH` 生成（scrypt，盐 16 字节 hex）：

```bash
node -e "const c=require('crypto');const s=c.randomBytes(16);const h=c.scryptSync(process.argv[1],s,64);console.log(s.toString('hex')+':'+h.toString('hex'))" '你的强密码'
```

### 3. 首次部署（deploy.sh）

在服务器上的仓库检出目录内执行：

```bash
cd /path/to/english-review
./deploy/deploy.sh
```

脚本内容见文件头注释（构建 web → rsync 到 `/opt/english-learning/app` → 目标目录
`pnpm install` → 根 `node_modules/.bin/tsx` 软链 → 重启 api）。要点：

- **幂等**：重复执行只做增量同步与服务重启。
- **migration 自动执行**：API 启动时运行 `runMigrations`，无需手工步骤。
- systemd unit 的 `ExecStart` 统一指向 `/opt/english-learning/app/node_modules/.bin/tsx`；
  脚本会把它软链到 `apps/api` 的 tsx（pnpm 的实际安装位置）。

### 4. systemd units 与 timers

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now english-learning-api \
  english-learning-prefetch.timer \
  english-learning-backup.timer \
  english-learning-cleanup.timer \
  english-learning-maintenance.timer
systemctl list-timers | grep english-learning   # 确认四个 timer 已排期
```

注意：`daily-prefetch` 在没有 `GLM_API_KEY` 时会拒绝生成并退出非 0（防止 mock 输出进生产库），
先确认 env 中已配置 GLM 密钥。

### 5. nginx（先 HTTP）

```bash
sudo sed 's/__DOMAIN__/english.example.com/g' deploy/nginx/english-learning.conf.template \
  | sudo tee /etc/nginx/sites-available/english-learning.conf
sudo ln -sf /etc/nginx/sites-available/english-learning.conf /etc/nginx/sites-enabled/english-learning.conf
sudo rm -f /etc/nginx/sites-enabled/default        # 避免默认站点抢占 80
sudo nginx -t && sudo systemctl reload nginx
```

此时 `http://english.example.com` 应能登录使用（cookie 暂为非 Secure）。

### 6. HTTPS（certbot）

```bash
sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /opt/english-learning/app/apps/web/dist -d english.example.com
```

签发成功后编辑 `/etc/nginx/sites-available/english-learning.conf`：

1. 取消文件底部 **443 server 段**的全部注释（证书路径已按 `__DOMAIN__` 替换）；
2. 取消 80 段内 `location / { return 301 https://$host$request_uri; }` 的注释；

```bash
sudo nginx -t && sudo systemctl reload nginx
```

certbot 自带 systemd timer 自动续期（`systemctl list-timers | grep certbot`）。

### 7. smoke 验收

```bash
curl -fsS https://english.example.com/api/health
```

浏览器（PC + 手机各一遍）：登录 → Today 开始/继续 → Library 列表与筛选 → Read 生成；
PWA 安装后跨设备续接 Today Session。任一步异常先看日志：

```bash
journalctl -u english-learning-api -n 100 --no-pager
```

---

## 备份验证与恢复演练

### 快照位置

| 模式 | 位置 | 保留 |
| --- | --- | --- |
| S3 模式（设置了 `S3_BUCKET`） | `s3://<bucket>/english-review/daily/<yyyy-mm-dd>.db` | 30 天（备份 job 轮转） |
| S3 模式 | `s3://<bucket>/english-review/monthly/<yyyy-mm>.db` | 12 个月（按月初边界轮转）；本地仅临时文件，上传后即删 |
| **本地模式（默认，无 S3_BUCKET）** | `<数据库目录>/snapshots/daily-<yyyy-mm-dd>.db` | 30 天（按文件名日期轮转） |
| 本地模式 | `<数据库目录>/snapshots/monthly-<yyyy-mm>.db` | 12 个月 |
| 恢复前快照 | `<数据库目录>/snapshots/backup-before-restore-<ts>.db` | 手动清理 |

> 无 S3 也完全可用：本地轮转防软件级灾难；建议偶尔在 PC 上「导出完整备份」保存到自己电脑作为异地副本。

### 验证备份真的在工作

```bash
sudo systemctl start english-learning-backup.service
journalctl -u english-learning-backup --since today --no-pager
aws s3 ls s3://<bucket>/english-review/daily/ | tail -5
# 下载当天快照并确认可打开
aws s3 cp s3://<bucket>/english-review/daily/$(date -u +%F).db /tmp/restore-check.db
sqlite3 /tmp/restore-check.db "select count(*) from learning_items;"
```

### 恢复演练（建议每季度一次，先在维护时段做）

**方式 A：S3 快照整库恢复**

```bash
sudo systemctl stop english-learning-api
sudo cp /var/lib/english-learning/prod.db /var/lib/english-learning/prod.db.bak   # 恢复前再留一份
aws s3 cp s3://<bucket>/english-review/daily/<日期>.db /var/lib/english-learning/prod.db
sudo chown <运行用户>: /var/lib/english-learning/prod.db
sudo systemctl start english-learning-api
# 重复步骤 7 的 smoke
sudo rm /var/lib/english-learning/prod.db.bak   # 确认无误后清理
```

**方式 B：完整备份 JSON 覆盖恢复（产品内）**

PC 登录 → Settings → 恢复备份：粘贴/上传备份 JSON → 预览（时间、数量、当前数据量）→
二次确认提交。恢复在维护锁内执行，提交前系统会自动创建当前库快照；
对应接口为 `POST /api/restore/preview` 与 `POST /api/restore/commit`。

## 日常运维速查

```bash
# 手动触发某个 job（均为幂等）
sudo systemctl start english-learning-cleanup.service
sudo systemctl start english-learning-backup.service

# 查看结果
journalctl -u english-learning-cleanup --since today --no-pager

# 月度维护的膨胀告警（questions>50k / attempts>100k / review_tasks>200k / read_articles>20k）
journalctl -u english-learning-maintenance --since today --no-pager | grep 超过阈值
```
