# 树洞热榜部署手册

本文档记录当前项目在校内服务器上的部署方式，以及后续重新部署、更新树洞登录态的方法。

## 当前服务器

- 服务器：`10.129.245.10`
- 登录用户：`ubuntu`
- SSH key：`/Users/wishingcat/.ssh/Linux-TZJ1.pem`
- 项目目录：`/home/ubuntu/treehole-hot-rank`
- 服务名：`treehole-hot-rank`
- 环境变量文件：`/etc/treehole-hot-rank.env`
- 内部 Node 端口：`127.0.0.1:3000`
- 外部访问：通过 Nginx 的 `80` 端口反向代理

Ubuntu 镜像禁止直接用 `root` SSH 登录，需要这样连接：

```bash
ssh -i /Users/wishingcat/.ssh/Linux-TZJ1.pem ubuntu@10.129.245.10
```

## 自动更新逻辑

项目内置抓取调度。当前需求是高频自动同步，环境变量中设置：

```bash
TREEHOLE_SCHEDULE_MODE=interval
TREEHOLE_CRAWL_INTERVAL_MS=10000
```

含义是：

- 服务启动后会立即抓取一次。
- 之后约每 10 秒增量抓取最新帖子并写入本地缓存。
- 已经抓到本地的帖子不会因为源站删除而被主动清掉。
- 服务会按 `TREEHOLE_BACKFILL_INTERVAL_MS` 定期做更深页数的补抓。
- 被删帖对比任务独立调度，默认每天凌晨 4:00 扫描最近 2 个月内可能被删除的帖子。
- 如果想恢复成每到整点补抓，可以设置：

```bash
TREEHOLE_SCHEDULE_MODE=hourly
```

## 服务器环境变量

服务端登录态不要写入 Git，也不要放到前端文件里。统一保存在服务器：

```bash
/etc/treehole-hot-rank.env
```

推荐内容如下，`TREEHOLE_TOKEN` 和 `TREEHOLE_UUID` 用实际值替换：

```bash
HOST=127.0.0.1
PORT=3000
NODE_ENV=production
TZ=Asia/Shanghai
TREEHOLE_SCHEDULE_MODE=interval
TREEHOLE_CRAWL_INTERVAL_MS=10000
TREEHOLE_PAGE_SIZE=100
TREEHOLE_MAX_PAGES=240
TREEHOLE_INCREMENTAL_MAX_PAGES=3
TREEHOLE_COMMENT_LIMIT_FAST=100
TREEHOLE_COMMENT_LIMIT_BACKFILL=1000
TREEHOLE_FETCH_TIMEOUT_MS=15000
TREEHOLE_BACKFILL_INTERVAL_MS=3600000
TREEHOLE_ARCHIVE_ENABLED=1
TREEHOLE_ARCHIVE_DAYS=365
TREEHOLE_ARCHIVE_MAX_PAGES=5000
TREEHOLE_ARCHIVE_SLICE_PAGES=1
TREEHOLE_ARCHIVE_INTERVAL_MS=15000
TREEHOLE_COMMENT_LIMIT_ARCHIVE=100
TREEHOLE_MAX_LOADED_SHARDS=4
TREEHOLE_MAX_LOADED_SUMMARY_SHARDS=8
TREEHOLE_TOP_CACHE_LIMIT=5000
TREEHOLE_IMAGE_ARCHIVE_ENABLED=1
TREEHOLE_IMAGE_CONCURRENCY=3
TREEHOLE_IMAGE_DELAY_MS=250
TREEHOLE_IMAGE_MAX_BYTES=26214400
TREEHOLE_IMAGE_MIN_FREE_GB=5
TREEHOLE_DELETED_SCAN_ENABLED=1
TREEHOLE_DELETED_SCAN_HOUR=4
TREEHOLE_DELETED_PAGE_SIZE=500
TREEHOLE_DELETED_MAX_PAGES=6000
TREEHOLE_DELETED_PAGE_DELAY_MS=150
TREEHOLE_DELETED_CONCURRENCY=8
TREEHOLE_DELETED_PAGE_CONCURRENCY=8
TREEHOLE_DELETED_LOOKBACK_DAYS=60
TREEHOLE_DELETED_VERIFY_DETAIL=1
TREEHOLE_DELETED_IGNORE_RECENT_SECONDS=600
TREEHOLE_TOKEN=...
TREEHOLE_UUID=...
```

权限建议：

```bash
sudo chmod 600 /etc/treehole-hot-rank.env
```

`TREEHOLE_ARCHIVE_ENABLED=1` 会让服务器启动后自动分片抓取过去一年的帖子。归档进度会写入缓存文件，重启后从上次页数继续。访问者可以打开“历史库”，在所有本地已缓存帖子里按回复数或关注数排序，并通过月份、日期范围、PID、关键词或标签搜索。

`TREEHOLE_IMAGE_ARCHIVE_ENABLED=1` 会让服务在抓取帖子的同时，把图片帖里的图片下载到本地永久保存（`data/media/`），并经 `/media/...` 公开访问、内嵌展示在帖子详情里。图片帖约占缓存帖的 9%，全量约几十 GB；`TREEHOLE_IMAGE_MIN_FREE_GB` 会在磁盘可用空间不足时自动暂停下载。部署后用 `df -h /` 与 `du -sh data/media` 观察占盘。

页面栏目和加载策略：

- 第一层栏目是“实时数据 / 热榜 / 历史库 / 被删帖”。
- 工具栏第二行恒定保留“时段 + 排序”两槽：热榜显示 小时榜/日榜/周榜 与 回复数/关注数 排序（固定展示前 100 条）；历史库显示 回复数/关注数 排序与月份、日期范围筛选；实时数据、被删帖显示固定文案（如“近 14 天 · 固定 / 时间倒序 · 固定”）。排序为单一状态，跨栏目保持一致。
- 实时数据、历史库、被删帖首屏只加载 100 条；底部“继续翻阅”每次继续读取 100 条，避免一次性渲染过多导致页面卡顿。
- 界面为“夜话集”版面，支持昼/夜双主题，报头右上角一键切换并记忆偏好（默认跟随系统）。

页面刷新策略：打开“实时数据”时，每 10 秒读取一次最新缓存；小时榜、日榜、周榜每小时自动刷新一次；历史库和被删帖每分钟刷新一次状态；切换栏目、筛选条件或搜索会立即刷新。

运行数据文件：

- `data/shards/*.json`：按月份保存完整帖子和已缓存留言。
- `data/summaries/*.json`：按月份保存轻量帖子摘要，供列表接口快速读取。
- `data/tops/*.json`：按月份保存回复数/关注数 Top 缓存，加速历史库排序。
- `data/index.json`：帖子 PID 到月份分片的索引，以及分片统计。
- `data/status.json`：抓取状态。
- `data/deleted-posts.json`：被删帖对比结果。
- `data/media/<YYYY-MM>.json`：按月保存的帖子图片清单（pid → 本地图片文件）。
- `data/media/files/<YYYY-MM>/<pid>-<序号>.<ext>`：下载保存的图片原文件，经 `/media/...` 访问。
- `data/media/status.json`：图片归档累计进度。
- `data/hot-cache.json`：旧版本遗留缓存文件，仅用于迁移场景。

历史库和榜单接口使用 `data/summaries/*.json` 和 `data/tops/*.json` 的轻量缓存，避免反复解析带留言的大型月度分片。首次部署、迁移旧缓存，或发现 `data/summaries` 缺失时，先运行：

```bash
cd /home/ubuntu/treehole-hot-rank
npm run migrate-cache
npm run warm-summaries
```

`migrate-cache` 会把旧版 `data/hot-cache*.json` 转为月份分片；如果没有旧缓存文件，会直接跳过。

被删帖栏目使用 `data/deleted-posts.json` 保存对比快照。服务会每天凌晨 4:00 自动扫描当前树洞可见 PID，并与本地缓存中最近 2 个月的帖子比较。首次上线或需要立即刷新时运行：

```bash
sudo bash -s <<'EOF'
set -euo pipefail
cd /home/ubuntu/treehole-hot-rank
TOKEN="$(awk -F= '$1=="TREEHOLE_TOKEN"{sub(/^[^=]*=/,""); print; exit}' /etc/treehole-hot-rank.env)"
UUID="$(awk -F= '$1=="TREEHOLE_UUID"{sub(/^[^=]*=/,""); print; exit}' /etc/treehole-hot-rank.env)"
sudo -u ubuntu env TREEHOLE_TOKEN="$TOKEN" TREEHOLE_UUID="$UUID" npm run deleted-scan
EOF
```

新上线图片归档功能后，服务会自动下载“新抓到 / 重抓到”的图片帖图片。要把**已缓存的存量图片帖**也补齐图片，可跑一次回填（仍存在的帖能下到，已删的下不到属正常）。可用 `TREEHOLE_MEDIA_SCAN_MONTHS=N` 只回填最近 N 个月、或 `TREEHOLE_MEDIA_SCAN_ONLY=2026-06,2026-05` 指定月份：

```bash
sudo bash -s <<'EOF'
set -euo pipefail
cd /home/ubuntu/treehole-hot-rank
TOKEN="$(awk -F= '$1=="TREEHOLE_TOKEN"{sub(/^[^=]*=/,""); print; exit}' /etc/treehole-hot-rank.env)"
UUID="$(awk -F= '$1=="TREEHOLE_UUID"{sub(/^[^=]*=/,""); print; exit}' /etc/treehole-hot-rank.env)"
sudo -u ubuntu env TREEHOLE_TOKEN="$TOKEN" TREEHOLE_UUID="$UUID" TREEHOLE_MEDIA_SCAN_MONTHS=2 npm run media-scan
EOF
```

> 回填脚本会读写 `data/media/`，与正在运行的服务共用同一目录。两者都用原子写，但若同月同时大量写入仍可能互相覆盖少量清单条目；建议在低峰期运行，或先 `sudo systemctl stop treehole-hot-rank` 再跑、跑完再启动。

## systemd 服务

服务文件位置：

```bash
/etc/systemd/system/treehole-hot-rank.service
```

推荐内容：

```ini
[Unit]
Description=Treehole Hot Rank
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/treehole-hot-rank
EnvironmentFile=/etc/treehole-hot-rank.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

常用命令：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now treehole-hot-rank
sudo systemctl restart treehole-hot-rank
sudo systemctl status treehole-hot-rank --no-pager
sudo journalctl -u treehole-hot-rank -f
```

## Nginx 反向代理

推荐 Nginx 配置文件：

```bash
/etc/nginx/sites-available/treehole-hot-rank
```

内容：

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用配置：

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/treehole-hot-rank /etc/nginx/sites-enabled/treehole-hot-rank
sudo nginx -t
sudo systemctl reload nginx
```

访问：

```text
http://10.129.245.10
```

## 本地改完项目后如何重新部署

推荐用 `rsync` 从本机同步到服务器。这样不需要服务器配置 GitHub 私有仓库权限。

在本机项目目录执行：

```bash
cd /Users/wishingcat/LovingHeart/树洞热搜榜

node --check src/auth.js
node --check src/treeholeClient.js
node --check src/store.js
node --check src/crawler.js
node --check src/server.js
node --check src/smoke.js
node --check src/cli-crawl.js
node --check src/migrate-cache.js
node --check src/warm-summaries.js
node --check src/deletedTracker.js
node --check src/deleted-scan.js
node --check src/mediaArchiver.js
node --check src/media-scan.js
node --check public/app.js

rsync -av --delete \
  -e "ssh -i /Users/wishingcat/.ssh/Linux-TZJ1.pem" \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  --exclude output \
  --exclude .playwright-cli \
  --exclude .playwright-mcp \
  --exclude .claude \
  --exclude .DS_Store \
  /Users/wishingcat/LovingHeart/树洞热搜榜/ \
  ubuntu@10.129.245.10:/home/ubuntu/treehole-hot-rank/

ssh -i /Users/wishingcat/.ssh/Linux-TZJ1.pem ubuntu@10.129.245.10 \
  'cd /home/ubuntu/treehole-hot-rank && npm ci --omit=dev && npm run warm-summaries && sudo systemctl restart treehole-hot-rank && sudo systemctl status treehole-hot-rank --no-pager'
```

检查网站和 API：

```bash
curl http://10.129.245.10/api/status
curl 'http://10.129.245.10/api/hot?window=day&sort=follow&limit=100'
curl 'http://10.129.245.10/api/realtime?limit=100&offset=0'
curl 'http://10.129.245.10/api/realtime?limit=100&offset=100'
curl 'http://10.129.245.10/api/deleted?limit=100&offset=0'
```

预期结果：热榜前端只展示前 100 条；实时数据、历史库、被删帖接口返回 `pagination`，并且第二页 `offset=100` 不应与第一页重复。

如果服务器已经配置了 GitHub 私有仓库访问权限，也可以在服务器上用 Git 更新：

```bash
cd /home/ubuntu/treehole-hot-rank
git pull --ff-only
npm ci --omit=dev
npm run warm-summaries
sudo systemctl restart treehole-hot-rank
sudo systemctl status treehole-hot-rank --no-pager
```

## 树洞账号登录信息过期后如何更新

token 过期时，网站通常会抓取失败，`/api/status` 或日志里会出现登录态无效、401、403 一类的信息。

先在本机 Chrome 打开已经登录的树洞网页，然后打开 DevTools Console，执行：

```js
copy([
  `TREEHOLE_TOKEN=${localStorage.getItem("token")}`,
  `TREEHOLE_UUID=${localStorage.getItem("pku-uuid") || ""}`
].join("\n"))
```

然后更新服务器环境变量：

```bash
ssh -i /Users/wishingcat/.ssh/Linux-TZJ1.pem ubuntu@10.129.245.10
sudo nano /etc/treehole-hot-rank.env
```

替换其中的：

```bash
TREEHOLE_TOKEN=...
TREEHOLE_UUID=...
```

保存后重启服务：

```bash
sudo systemctl restart treehole-hot-rank
sudo systemctl status treehole-hot-rank --no-pager
```

验证：

```bash
curl http://127.0.0.1:3000/api/status
sudo journalctl -u treehole-hot-rank -n 80 --no-pager
```

注意：不要把真实 token 提交到 GitHub，也不要写进 README、前端 JS、截图或日志里。

## 常见排查

看服务是否启动：

```bash
sudo systemctl status treehole-hot-rank --no-pager
```

看实时日志：

```bash
sudo journalctl -u treehole-hot-rank -f
```

看 Node 服务是否可访问：

```bash
curl http://127.0.0.1:3000/api/status
```

看 Nginx 配置是否正确：

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
```

看端口监听：

```bash
ss -lntp | grep -E ':80|:3000'
```
