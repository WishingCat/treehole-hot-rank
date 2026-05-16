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

项目内置抓取调度。环境变量中设置：

```bash
TREEHOLE_SCHEDULE_MODE=hourly
```

含义是：

- 服务启动后会立即抓取一次。
- 之后每到整点自动重新抓取一次。
- 如果想改成从启动时间开始每隔固定时间抓取，可以设置：

```bash
TREEHOLE_SCHEDULE_MODE=interval
TREEHOLE_CRAWL_INTERVAL_MS=3600000
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
TREEHOLE_SCHEDULE_MODE=hourly
TREEHOLE_PAGE_SIZE=100
TREEHOLE_MAX_PAGES=240
TREEHOLE_TOKEN=...
TREEHOLE_UUID=...
```

权限建议：

```bash
sudo chmod 600 /etc/treehole-hot-rank.env
```

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
node --check public/app.js

rsync -av --delete \
  -e "ssh -i /Users/wishingcat/.ssh/Linux-TZJ1.pem" \
  --exclude .git \
  --exclude node_modules \
  --exclude data \
  --exclude output \
  --exclude .playwright-cli \
  --exclude .DS_Store \
  /Users/wishingcat/LovingHeart/树洞热搜榜/ \
  ubuntu@10.129.245.10:/home/ubuntu/treehole-hot-rank/

ssh -i /Users/wishingcat/.ssh/Linux-TZJ1.pem ubuntu@10.129.245.10 \
  'cd /home/ubuntu/treehole-hot-rank && npm ci --omit=dev && sudo systemctl restart treehole-hot-rank && sudo systemctl status treehole-hot-rank --no-pager'
```

检查网站和 API：

```bash
curl http://10.129.245.10/api/status
```

如果服务器已经配置了 GitHub 私有仓库访问权限，也可以在服务器上用 Git 更新：

```bash
cd /home/ubuntu/treehole-hot-rank
git pull --ff-only
npm ci --omit=dev
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
