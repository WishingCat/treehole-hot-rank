# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project overview

This is a local Node.js/Express app for a PKU Treehole dashboard. It reuses a Treehole login token from either `TREEHOLE_TOKEN`/`TREEHOLE_UUID` or Chrome localStorage, crawls Treehole's API, stores normalized posts in month-based JSON shards under `data/`, downloads and archives the images embedded in image posts, and serves a static Chinese-language dashboard from `public/`. The frontend is an editorial "夜话集 / almanac" UI with a **day/night dual theme** (toggle persisted in `localStorage`, defaulting to day mode on first visit), built with plain HTML/CSS/JS and no build step.

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
- Backfill images for already-cached image posts (best-effort, needs auth): `npm run media-scan`

There is no lint, build, or unit test script in `package.json` currently. The smoke command requires valid Treehole auth and network access to `https://treehole.pku.edu.cn/chapi/`.

Useful runtime environment variables from the README:

- `HOST` / `PORT`: server bind address and initial port; the server retries later ports if occupied.
- `TREEHOLE_SCHEDULE_MODE=hourly|interval`: default is interval, running at startup and then every `TREEHOLE_CRAWL_INTERVAL_MS`.
- `TREEHOLE_CRAWL_INTERVAL_MS`, `TREEHOLE_PAGE_SIZE`, `TREEHOLE_MAX_PAGES`: crawler pacing and fetch limits.
- `TREEHOLE_ARCHIVE_ENABLED`, `TREEHOLE_ARCHIVE_DAYS`, `TREEHOLE_ARCHIVE_SLICE_PAGES`, `TREEHOLE_ARCHIVE_INTERVAL_MS`: background archive crawling.
- `TREEHOLE_DELETED_SCAN_ENABLED`, `TREEHOLE_DELETED_SCAN_HOUR`, `TREEHOLE_DELETED_LOOKBACK_DAYS`: deleted-post comparison scheduling and scope.
- `TREEHOLE_MAX_LOADED_SHARDS`, `TREEHOLE_MAX_LOADED_SUMMARY_SHARDS`, `TREEHOLE_TOP_CACHE_LIMIT`: memory/cache limits for shard loading and top caches.
- `TREEHOLE_IMAGE_ARCHIVE_ENABLED`, `TREEHOLE_IMAGE_BASE`, `TREEHOLE_IMAGE_CONCURRENCY`, `TREEHOLE_IMAGE_DELAY_MS`, `TREEHOLE_IMAGE_MAX_BYTES`, `TREEHOLE_IMAGE_MIN_FREE_GB`: in-post image archiving (download endpoint, concurrency, politeness, per-image size cap, and a free-disk floor that pauses downloads).
- `TREEHOLE_TOKEN`, `TREEHOLE_UUID`: explicit auth, used before Chrome discovery.
- `CHROME_USER_DATA_DIR`, `TREEHOLE_CHROME_PROFILE`: Chrome localStorage discovery settings.

## Architecture

- `src/server.js` is the app entrypoint. It creates the `HotStore`, loads index/status/shard metadata, creates `TreeholeCrawler`, `DeletedPostTracker`, and `MediaArchiver`, serves `public/` and the archived images at `/media`, exposes list/detail/status APIs, triggers a startup crawl, and starts the schedulers.
- `src/crawler.js` owns crawl scheduling and refresh concurrency. `TreeholeCrawler.refresh()` deduplicates concurrent runs through `activeRun`; `run()` resolves auth, paginates Treehole API results, persists progress, updates store status, coordinates incremental/backfill/archive crawling, and (non-blocking) enqueues image posts into the `MediaArchiver`.
- `src/auth.js` resolves Treehole credentials. Environment-token auth wins; otherwise it scans Chrome profiles, copies each profile's Local Storage LevelDB into a temp directory to avoid reading a live DB, extracts `token` and `pku-uuid`, and selects a non-expired candidate.
- `src/treeholeClient.js` is the Treehole API boundary. It fetches `api/v3/hole/list_comments` with bearer token plus `uuid`, validates the Treehole response code, and normalizes raw posts into the cache/UI shape (including `imageSources`). `imageSourcesForPost`/`imageFetchUrl`/`fetchImageBuffer` resolve and download in-post images: new posts fetch each `media_id` via `api/v3/media/getMediaBinary?id=`, old image posts (no `media_ids`) fetch the single image via `?pid=` — mirroring the official web client.
- `src/store.js` is the sharded JSON persistence layer. It maintains `data/shards/*.json` full posts, `data/summaries/*.json` list summaries, `data/tops/*.json` top caches, `data/index.json`, `data/status.json`, and bounded in-memory LRU-style loaded shard caches.
- `src/deletedTracker.js` owns deleted-post comparison. It scans currently visible Treehole PIDs, compares them with local cached posts in the configured lookback window, writes `data/deleted-posts.json`, and schedules daily checks.
- `src/mediaArchiver.js` owns in-post image archiving. A bounded-concurrency background worker downloads images for queued image posts and stores them under `data/media/files/<YYYY-MM>/<pid>-<idx>.<ext>` with a per-month sidecar manifest `data/media/<YYYY-MM>.json` (kept off the post-shard hot path, LRU in memory). It exposes `getImages(post)` for the detail endpoint and `publicStatus()` for `/api/status`, and pauses on low free disk.
- `public/index.html`, `public/app.js`, and `public/styles.css` are a static frontend. `app.js` keeps a controller layer (fetch/state/pagination/refresh) and a view layer (render functions); the detail view renders archived in-post images as an inline grid with a click-to-zoom lightbox. `styles.css` is a tokenized design system with `:root` (night) and `:root[data-theme="day"]` (day) themes. A small inline `<head>` script sets the theme before first paint to avoid FOUC. The browser polls `/api/status` every 10 seconds; list refresh rates are context-specific: realtime every 10 seconds, archive/deleted every minute, hot lists hourly.
- `src/cli-crawl.js`, `src/smoke.js`, `src/warm-summaries.js`, `src/migrate-cache.js`, `src/deleted-scan.js`, and `src/media-scan.js` are operational scripts that share the same store/crawler/tracker/archiver code paths as the server.

## API behavior

- `/api/hot` accepts `window=hour|day|week`, `sort=reply|follow`, `limit`, and `query`. The frontend requests `limit=100` and treats hot lists as top-100 lists.
- `/api/realtime` accepts `limit`, `offset`, and `query`; it does not use reply/follow sort and defaults to original post time descending.
- `/api/archive` accepts `month=YYYY-MM` or `start`/`end`, plus `sort=reply|follow`, `limit`, `offset`, and `query`. Without a month or range, it returns `requiresMonth: true`.
- `/api/deleted` accepts `limit`, `offset`, and `query`; default sort is original post time descending. Backend still accepts `sort=detected|time|reply|follow` for compatibility, but the frontend does not expose deleted sorting.
- Paginated endpoints return `pagination: { offset, limit, nextOffset, hasMore }`.
- `/api/post/:pid` returns the full post plus `images`: an array of `{ src, bytes, ext }` for archived in-post images, where `src` is a `/media/<YYYY-MM>/<pid>-<idx>.<ext>` path served statically. Empty when the post has no images or they are not yet downloaded.

## Data and auth cautions

- Everything under `data/` is generated runtime state. It may include cached post content, comments, status, index metadata, top caches, and deleted-post comparison results; avoid treating it as source code.
- Do not log or commit `TREEHOLE_TOKEN` values or copied Chrome storage contents.
- The README notes this service should only be exposed on campus network or trusted VPN because the server has authenticated Treehole access.
