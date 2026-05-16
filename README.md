# 树洞热榜

一个本地运行的北大树洞热榜工作台。服务会复用你本机 Chrome 里已经登录的树洞 `localStorage.token`，抓取近 7 天帖子，然后按回复数或关注数生成小时榜/日榜/周榜。

## 启动

```bash
npm install
npm start
```

默认监听 `http://localhost:3000`。如果端口被占用，服务会自动尝试后续端口。

## 配置

可选环境变量：

```bash
HOST=0.0.0.0
PORT=3000
TREEHOLE_SCHEDULE_MODE=hourly
TREEHOLE_CRAWL_INTERVAL_MS=3600000
TREEHOLE_PAGE_SIZE=100
TREEHOLE_MAX_PAGES=240
CHROME_USER_DATA_DIR="/path/to/Chrome/User Data"
TREEHOLE_CHROME_PROFILE="Profile 1"
TREEHOLE_TOKEN="..."
TREEHOLE_UUID="..."
```

默认 `TREEHOLE_SCHEDULE_MODE=hourly`，服务启动后会先立即抓取一次，之后在每个整点触发下一轮抓取。若想恢复成固定间隔轮询，可以设为 `TREEHOLE_SCHEDULE_MODE=interval` 并用 `TREEHOLE_CRAWL_INTERVAL_MS` 控制间隔。若放在 Nginx 后面，建议设置 `HOST=127.0.0.1`。

不设置 `TREEHOLE_TOKEN` 时，会自动扫描 macOS Chrome profile 中 `treehole.pku.edu.cn` 的本地存储。缓存文件写在 `data/hot-cache.json`。

## 校内网部署

可行。部署机器需要满足两点：

1. 机器所在网络能访问 `https://treehole.pku.edu.cn/chapi/`。
2. 服务端能拿到有效树洞登录态。可以在服务器的 Chrome 里登录后让程序读取 profile，也可以通过环境变量提供 `TREEHOLE_TOKEN` 和 `TREEHOLE_UUID`；token 过期后需要更新。如果服务器不是 macOS，通常需要设置 `CHROME_USER_DATA_DIR` 指向 Chrome 的 User Data 目录。

建议用 `pm2` 或 `systemd` 保活，再用 Nginx 反向代理到本服务端口。这个站点只应该开放给校内网或可信 VPN，不要把带登录态的抓取服务直接暴露到公网。
