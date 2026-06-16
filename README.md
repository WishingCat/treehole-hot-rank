# 北大树洞 · 夜话集（树洞热榜）

> 一个本地 / 校内自托管的北大树洞热榜工作台：持续抓取并**永久归档**树洞帖子与留言，按热度与时间多维度回溯，识别被官方删除的帖子，并以「夜话集」编辑式版面（**昼夜双主题**）呈现。

树洞只能看到滚动的最新帖，热度无法排序、历史无法回溯、帖子被删后便难以寻回。本项目在后台持续增量同步并把数据写入本地分片缓存——已抓到的帖子**不会**因源站删除而消失——于是你可以按回复 / 关注数排榜、回溯任意月份、并发现哪些帖子被删除了。

服务会复用你本机 Chrome 里已登录的树洞 `localStorage.token`，或使用环境变量里的 `TREEHOLE_TOKEN` / `TREEHOLE_UUID`；默认每 10 秒增量同步。所有访问者都可浏览，无需登录。

## 功能特性

- **四大栏目**
  - 实时数据：按发布时间倒序的最新缓存帖
  - 热榜：小时榜 / 日榜 / 周榜，按回复数或关注数排序，固定展示前 100
  - 历史库：本地全部归档，按回复 / 关注排序，支持月份与日期范围筛选
  - 被删帖：对比本地缓存与当前树洞仍可见帖，列出最近约 2 个月内已被官方删除的帖子
- **恒定工具栏 + 统一排序**：第二行工具栏始终保持「时段 + 排序」两槽，切换栏目不塌行；排序为单一状态，跨栏目保持一致
- **全文搜索**：`#PID` / 关键词 / 标签
- **帖子详情**：完整正文、回复 / 关注 / 赞 / 踩、标签、媒体、**已缓存留言**（洞主标识、楼层、点赞）
- **永久本地归档**：源站删帖或超出榜单时间窗口都不会清掉本地缓存
- **后台自动同步**：高频增量 + 定时深页补抓 + 后台分片归档过去一年
- **每日被删帖比对**：默认每天凌晨 4:00 扫描
- **分页「继续翻阅」**：实时 / 历史 / 被删帖首屏 100 条，底部按需加载，避免长列表卡顿

## 界面与设计

- **「树洞夜话集」编辑式版面**：年鉴感报头、年轮（同心轮廓）环境纹理、纸面颗粒、朱红印章式前三名、霞鹜文楷的文学正文与等宽数据字。
- **昼夜双主题**：
  - 夜·墨 — 深墨夜底、暖米色字、朱红印，契合树洞"深夜匿名倾诉"的气质
  - 宣纸·昼 — 暖米纸底、浓墨字、朱砂印，明亮书卷感
  - 报头右上角一键切换，偏好存入 `localStorage`，首次访问默认跟随系统 `prefers-color-scheme`，并在首帧前定主题、无闪烁
- **字体**：正文用霞鹜文楷（经 jsdelivr CDN 加载，`font-display: swap` + unicode-range 分片），配系统衬线兜底（Songti SC / Source Han Serif / SimSun），CDN 不可达时优雅降级。
- 响应式（桌面 / 平板 / 手机）、键盘可达、`prefers-reduced-motion` 收敛动效。

页面刷新节奏与后端抓取分开：实时数据每 10 秒、热榜每小时、历史库与被删帖每分钟刷新一次状态；切换栏目 / 排序 / 筛选 / 搜索会立即刷新。

## 快速开始

```bash
npm install
npm start          # 或 npm run dev
```

默认监听 `http://localhost:3000`；端口被占用会自动尝试后续端口。未设置 `TREEHOLE_TOKEN` 时，会在 macOS Chrome profile 中自动扫描 `treehole.pku.edu.cn` 的登录态。

## 登录态（auth）

- 优先使用环境变量 `TREEHOLE_TOKEN`（可选 `TREEHOLE_UUID`）。
- 否则扫描 Chrome 的 Local Storage（把 LevelDB 复制到临时目录后读取，避免读活动数据库），取 `token` / `pku-uuid`，挑选未过期者。
- 非 macOS 通常需设置 `CHROME_USER_DATA_DIR` 指向 Chrome 的 User Data 目录；可用 `TREEHOLE_CHROME_PROFILE` 指定 profile。
- token 过期后抓取会失败（日志 / `/api/status` 出现 401/403/登录态字样），更新环境变量后重启即可。

## 配置（环境变量）

```bash
# 服务
HOST=0.0.0.0
PORT=3000

# 调度与抓取
TREEHOLE_SCHEDULE_MODE=interval        # interval（默认）| hourly
TREEHOLE_CRAWL_INTERVAL_MS=10000       # 增量同步间隔
TREEHOLE_PAGE_SIZE=100
TREEHOLE_MAX_PAGES=240
TREEHOLE_INCREMENTAL_MAX_PAGES=3
TREEHOLE_COMMENT_LIMIT_FAST=100        # 高频增量每帖留言数
TREEHOLE_COMMENT_LIMIT_BACKFILL=1000   # 低频补抓每帖留言数
TREEHOLE_FETCH_TIMEOUT_MS=15000
TREEHOLE_BACKFILL_INTERVAL_MS=3600000

# 一年归档（后台分片抓取过往数据）
TREEHOLE_ARCHIVE_ENABLED=1
TREEHOLE_ARCHIVE_DAYS=365
TREEHOLE_ARCHIVE_MAX_PAGES=5000
TREEHOLE_ARCHIVE_SLICE_PAGES=1
TREEHOLE_ARCHIVE_INTERVAL_MS=15000
TREEHOLE_COMMENT_LIMIT_ARCHIVE=100

# 缓存 / 内存上限
TREEHOLE_MAX_LOADED_SHARDS=4
TREEHOLE_MAX_LOADED_SUMMARY_SHARDS=8
TREEHOLE_TOP_CACHE_LIMIT=5000

# 被删帖比对
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

# 登录态
TREEHOLE_TOKEN="..."
TREEHOLE_UUID="..."
CHROME_USER_DATA_DIR="/path/to/Chrome/User Data"
TREEHOLE_CHROME_PROFILE="Profile 1"
```

## 数据与缓存

缓存采用按月份分片的 JSON 文件，全部位于 `data/`（已 `.gitignore`，属运行期生成数据）：

| 文件 | 用途 |
| --- | --- |
| `data/shards/*.json` | 按月保存完整帖子与已缓存留言 |
| `data/summaries/*.json` | 按月保存轻量帖子摘要，供列表接口快速读取 |
| `data/tops/*.json` | 按月保存回复 / 关注 Top 缓存，加速历史库排序 |
| `data/index.json` | 帖子 PID → 月份分片索引及分片统计 |
| `data/status.json` | 抓取状态 |
| `data/deleted-posts.json` | 被删帖比对结果 |
| `data/hot-cache.json` | 旧版本遗留缓存，仅用于迁移 |

存储层用 `stream-json` 流式解析大分片，避免一次性载入整月数据；并对已载入分片做有界 LRU 管理。

## 后台任务与脚本

服务运行时自动执行：高频增量同步、按 `TREEHOLE_BACKFILL_INTERVAL_MS` 的深页补抓、（启用时）后台一年归档、每日被删帖比对。

```bash
npm start              # 启动服务（含全部调度）
npm run dev            # 同上
npm run crawl          # 命令行跑一次抓取
npm run smoke          # 单页冒烟测试（TREEHOLE_SMOKE_PAGES=3 可多页）
npm run migrate-cache  # 把旧版 data/hot-cache*.json 迁成月份分片
npm run warm-summaries # 为已有月份生成 summaries/ 与 tops/ 缓存
npm run deleted-scan   # 命令行跑一次被删帖比对
```

首次部署或迁移旧缓存后，建议运行 `npm run migrate-cache && npm run warm-summaries`。脱离 systemd 手动执行 `deleted-scan` / `smoke` 时需自行提供 `TREEHOLE_TOKEN` 和 `TREEHOLE_UUID`。

## HTTP 接口

- `GET /api/status` — 抓取状态、缓存统计、配置摘要
- `GET /api/hot?window=hour|day|week&sort=reply|follow&limit=100` — 热榜；前端固定取前 100
- `GET /api/realtime?limit=100&offset=0&query=...` — 实时数据，按发布时间倒序，返回 `pagination`
- `GET /api/archive?month=YYYY-MM&sort=reply|follow&limit=100&offset=0` — 历史库（月份）
- `GET /api/archive?start=<unix>&end=<unix>&sort=reply|follow&limit=100&offset=0` — 历史库（日期范围）
- `GET /api/deleted?limit=100&offset=0&query=...` — 被删帖，按原帖发布时间倒序，返回 `pagination`
- `GET /api/post/:pid` — 帖子详情与已缓存留言
- `GET /api/auth/me`、`POST /api/auth/login`、`POST /api/auth/logout` — 可选的管理员会话（仅用于手动刷新；默认浏览无需登录）
- `POST /api/refresh`、`POST /api/deleted/refresh` — 手动触发抓取 / 被删帖比对

分页接口返回 `pagination: { offset, limit, nextOffset, hasMore }`；历史库未选月份或范围时返回空列表与 `requiresMonth: true`。

## 技术栈与项目结构

Node.js ≥ 20 · Express 5 · `stream-json`（流式分片解析）· `level`（读取 Chrome Local Storage LevelDB）· 原生前端（无构建步骤，单文件 HTML/CSS/JS）。

```
src/
  server.js          应用入口：建 HotStore、TreeholeCrawler、DeletedPostTracker，挂 API，启动调度
  crawler.js         抓取调度与并发去重（增量 / 补抓 / 归档）
  auth.js            解析树洞登录态（环境变量优先，否则扫描 Chrome localStorage）
  treeholeClient.js  树洞 API 边界：拉取与归一化帖子 / 留言、判断帖子是否仍存在
  store.js           分片 JSON 持久化层（shards / summaries / tops / index / status）
  deletedTracker.js  被删帖比对与每日调度
  cli-crawl.js / smoke.js / migrate-cache.js / warm-summaries.js / deleted-scan.js  运维脚本
public/
  index.html         版面骨架（报头 / 工具栏 / 榜单 / 札记 / 详情弹窗 / 环境层）
  app.js             前端控制器与视图渲染、主题切换
  styles.css         夜·墨 / 宣纸·昼 双主题设计系统
```

## 校内网部署

部署机器需能访问 `https://treehole.pku.edu.cn/chapi/`，并持有有效树洞登录态。建议用 systemd 保活 + Nginx 反向代理，并设置 `HOST=127.0.0.1`。**仅应开放给校内网或可信 VPN，切勿把带登录态的抓取服务直接暴露公网。** 详细的服务器配置、更新与排查见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 安全提示

- 不要把 `TREEHOLE_TOKEN` 写入代码、前端、截图或日志；统一放在服务器环境文件并设 `chmod 600`。
- `data/` 为运行期生成数据（含缓存帖文与留言），已在 `.gitignore` 中，请勿提交。
- 本仓库为公开仓库：`DEPLOYMENT.md` 含服务器地址与运维细节，如不希望公开请评估是否将其移出仓库或改为私有仓库。
