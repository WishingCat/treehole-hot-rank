# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project overview

This is a local Node.js/Express app for a PKU Treehole dashboard. It reuses a Treehole login token from either `TREEHOLE_TOKEN`/`TREEHOLE_UUID` or Chrome localStorage, crawls Treehole's API, stores normalized posts in month-based JSON shards under `data/`, and serves a static Chinese-language dashboard from `public/`. The frontend is an editorial "夜话集 / almanac" UI with a **day/night dual theme** (toggle persisted in `localStorage`, defaulting to the system `prefers-color-scheme`), built with plain HTML/CSS/JS and no build step.

The UI has four top-level sections:

- `实时数据`: latest cached posts, sorted by original post time descending.
- `热榜`: contains `小时榜` / `日榜` / `周榜`, sorted by reply or follow count; the frontend shows the top 100.
- `历史库`: local archive with reply/follow sorting plus month and date-range filters.
- `被删帖`: posts found in the local cache but no longer visible in Treehole, limited to the configured recent lookback window and sorted by original post time descending.

The frontend intentionally pages non-hot sections: realtime, archive, and deleted initially load 100 rows and then use `加载更多` with `limit` / `offset`. Do not change these views to render every matching post at once; large lists can make the site feel stuck.

## Commands

- Install dependencies: `npm install`
- Start the server: `npm start` or `npm run dev`
- Run one crawl from the CLI: `npm run crawl`
- Smoke-test crawling with the default single page: `npm run smoke`
- Smoke-test multiple pages: `TREEHOLE_SMOKE_PAGES=3 npm run smoke`
- Migrate legacy `data/hot-cache*.json` files into month shards: `npm run migrate-cache`
- Warm summary/top caches for existing shards: `npm run warm-summaries`
- Run one deleted-post comparison: `npm run deleted-scan`

There is no lint, build, or unit test script in `package.json` currently. The smoke command requires valid Treehole auth and network access to `https://treehole.pku.edu.cn/chapi/`.

Useful runtime environment variables from the README:

- `HOST` / `PORT`: server bind address and initial port; the server retries later ports if occupied.
- `TREEHOLE_SCHEDULE_MODE=hourly|interval`: default is interval, running at startup and then every `TREEHOLE_CRAWL_INTERVAL_MS`.
- `TREEHOLE_CRAWL_INTERVAL_MS`, `TREEHOLE_PAGE_SIZE`, `TREEHOLE_MAX_PAGES`: crawler pacing and fetch limits.
- `TREEHOLE_ARCHIVE_ENABLED`, `TREEHOLE_ARCHIVE_DAYS`, `TREEHOLE_ARCHIVE_SLICE_PAGES`, `TREEHOLE_ARCHIVE_INTERVAL_MS`: background archive crawling.
- `TREEHOLE_DELETED_SCAN_ENABLED`, `TREEHOLE_DELETED_SCAN_HOUR`, `TREEHOLE_DELETED_LOOKBACK_DAYS`: deleted-post comparison scheduling and scope.
- `TREEHOLE_MAX_LOADED_SHARDS`, `TREEHOLE_MAX_LOADED_SUMMARY_SHARDS`, `TREEHOLE_TOP_CACHE_LIMIT`: memory/cache limits for shard loading and top caches.
- `TREEHOLE_TOKEN`, `TREEHOLE_UUID`: explicit auth, used before Chrome discovery.
- `CHROME_USER_DATA_DIR`, `TREEHOLE_CHROME_PROFILE`: Chrome localStorage discovery settings.

## Architecture

- `src/server.js` is the app entrypoint. It creates the `HotStore`, loads index/status/shard metadata, creates `TreeholeCrawler` and `DeletedPostTracker`, serves `public/`, exposes list/detail/status APIs, triggers a startup crawl, and starts both schedulers.
- `src/crawler.js` owns crawl scheduling and refresh concurrency. `TreeholeCrawler.refresh()` deduplicates concurrent runs through `activeRun`; `run()` resolves auth, paginates Treehole API results, persists progress, updates store status, and coordinates incremental, backfill, and archive crawling.
- `src/auth.js` resolves Treehole credentials. Environment-token auth wins; otherwise it scans Chrome profiles, copies each profile's Local Storage LevelDB into a temp directory to avoid reading a live DB, extracts `token` and `pku-uuid`, and selects a non-expired candidate.
- `src/treeholeClient.js` is the Treehole API boundary. It fetches `api/v3/hole/list_comments` with bearer token plus `uuid`, validates the Treehole response code, and normalizes raw posts into the cache/UI shape.
- `src/store.js` is the sharded JSON persistence layer. It maintains `data/shards/*.json` full posts, `data/summaries/*.json` list summaries, `data/tops/*.json` top caches, `data/index.json`, `data/status.json`, and bounded in-memory LRU-style loaded shard caches.
- `src/deletedTracker.js` owns deleted-post comparison. It scans currently visible Treehole PIDs, compares them with local cached posts in the configured lookback window, writes `data/deleted-posts.json`, and schedules daily checks.
- `public/index.html`, `public/app.js`, and `public/styles.css` are a static frontend. `app.js` keeps a controller layer (fetch/state/pagination/refresh) and a view layer (render functions); `styles.css` is a tokenized design system with `:root` (night) and `:root[data-theme="day"]` (day) themes. A small inline `<head>` script sets the theme before first paint to avoid FOUC. The browser polls `/api/status` every 10 seconds; list refresh rates are context-specific: realtime every 10 seconds, archive/deleted every minute, hot lists hourly.
- `src/cli-crawl.js`, `src/smoke.js`, `src/warm-summaries.js`, `src/migrate-cache.js`, and `src/deleted-scan.js` are operational scripts that share the same store/crawler/tracker code paths as the server.

## API behavior

- `/api/hot` accepts `window=hour|day|week`, `sort=reply|follow`, `limit`, and `query`. The frontend requests `limit=100` and treats hot lists as top-100 lists.
- `/api/realtime` accepts `limit`, `offset`, and `query`; it does not use reply/follow sort and defaults to original post time descending.
- `/api/archive` accepts `month=YYYY-MM` or `start`/`end`, plus `sort=reply|follow`, `limit`, `offset`, and `query`. Without a month or range, it returns `requiresMonth: true`.
- `/api/deleted` accepts `limit`, `offset`, and `query`; default sort is original post time descending. Backend still accepts `sort=detected|time|reply|follow` for compatibility, but the frontend does not expose deleted sorting.
- Paginated endpoints return `pagination: { offset, limit, nextOffset, hasMore }`.

## Data and auth cautions

- Everything under `data/` is generated runtime state. It may include cached post content, comments, status, index metadata, top caches, and deleted-post comparison results; avoid treating it as source code.
- Do not log or commit `TREEHOLE_TOKEN` values or copied Chrome storage contents.
- The README notes this service should only be exposed on campus network or trusted VPN because the server has authenticated Treehole access.
