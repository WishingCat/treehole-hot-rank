import { authPublicInfo, clearTreeholeAuthCache, resolveTreeholeAuth } from "./auth.js";
import { fetchHolePage, normalizePost } from "./treeholeClient.js";

const DAY_SECONDS = 24 * 60 * 60;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nextHourDate(now = new Date()) {
  const next = new Date(now.getTime());
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return next;
}

export class TreeholeCrawler {
  constructor(store, options = {}) {
    this.store = store;
    this.pageSize = options.pageSize || envNumber("TREEHOLE_PAGE_SIZE", 100);
    this.maxPages = options.maxPages || envNumber("TREEHOLE_MAX_PAGES", 240);
    this.incrementalMaxPages =
      options.incrementalMaxPages || envNumber("TREEHOLE_INCREMENTAL_MAX_PAGES", 3);
    this.incrementalKnownOverlap =
      options.incrementalKnownOverlap || envNumber("TREEHOLE_INCREMENTAL_KNOWN_OVERLAP", 30);
    this.commentLimitFast =
      options.commentLimitFast || envNumber("TREEHOLE_COMMENT_LIMIT_FAST", 100);
    this.commentLimitBackfill =
      options.commentLimitBackfill || envNumber("TREEHOLE_COMMENT_LIMIT_BACKFILL", 1000);
    this.commentLimitArchive =
      options.commentLimitArchive ||
      envNumber("TREEHOLE_COMMENT_LIMIT_ARCHIVE", 100);
    this.backfillIntervalMs =
      options.backfillIntervalMs || envNumber("TREEHOLE_BACKFILL_INTERVAL_MS", 60 * 60 * 1000);
    this.archiveEnabled =
      options.archiveEnabled ?? envFlag("TREEHOLE_ARCHIVE_ENABLED", false);
    this.archiveDays = options.archiveDays || envNumber("TREEHOLE_ARCHIVE_DAYS", 365);
    this.archiveMaxPages =
      options.archiveMaxPages || envNumber("TREEHOLE_ARCHIVE_MAX_PAGES", 5000);
    this.archiveSlicePages =
      options.archiveSlicePages || envNumber("TREEHOLE_ARCHIVE_SLICE_PAGES", 1);
    this.archiveIntervalMs =
      options.archiveIntervalMs || envNumber("TREEHOLE_ARCHIVE_INTERVAL_MS", 15 * 1000);
    const lastBackfillAt = Date.parse(store.status?.lastBackfillAt || "");
    this.lastBackfillStartedAt = Number.isFinite(lastBackfillAt)
      ? lastBackfillAt
      : Date.now();
    this.pageDelayMs = options.pageDelayMs || envNumber("TREEHOLE_PAGE_DELAY_MS", 150);
    this.intervalMs =
      options.intervalMs || envNumber("TREEHOLE_CRAWL_INTERVAL_MS", 10 * 1000);
    this.errorLogThrottleMs =
      options.errorLogThrottleMs || envNumber("TREEHOLE_ERROR_LOG_THROTTLE_MS", 5 * 60 * 1000);
    const scheduleMode =
      options.scheduleMode || process.env.TREEHOLE_SCHEDULE_MODE || "interval";
    this.scheduleMode = scheduleMode === "hourly" ? "hourly" : "interval";
    this.activeRun = null;
    this.timer = null;
    this.archiveTimer = null;
    this.schedulerActive = false;
    this.nextRunAt = null;
    this.archiveNextRunAt = null;
    this.lastErrorLogs = new Map();
  }

  startScheduler() {
    if (this.schedulerActive) return;
    this.schedulerActive = true;

    if (this.scheduleMode === "interval") {
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      this.timer = setInterval(() => {
        this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
        if (this.activeRun) return;
        this.refresh({ reason: "schedule", mode: "incremental" }).catch((error) => {
          this.logRefreshError("scheduled refresh", error);
        });
      }, this.intervalMs);
    } else {
      this.scheduleNextHourlyRun();
    }

    this.startArchiveScheduler();
  }

  stopScheduler() {
    this.schedulerActive = false;
    if (this.timer) {
      clearInterval(this.timer);
      clearTimeout(this.timer);
    }
    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.timer = null;
    this.archiveTimer = null;
    this.nextRunAt = null;
    this.archiveNextRunAt = null;
  }

  startArchiveScheduler() {
    if (!this.archiveEnabled) return;
    if (this.store.status.archive?.completed) return;
    this.scheduleArchiveRun(1000);
  }

  scheduleArchiveRun(delayMs = this.archiveIntervalMs) {
    if (!this.schedulerActive || !this.archiveEnabled) return;
    if (this.store.status.archive?.completed) {
      this.archiveNextRunAt = null;
      return;
    }

    if (this.archiveTimer) clearTimeout(this.archiveTimer);
    this.archiveNextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.archiveTimer = setTimeout(async () => {
      this.archiveTimer = null;
      if (this.activeRun) {
        this.scheduleArchiveRun(Math.max(1000, Math.floor(this.intervalMs / 2)));
        return;
      }
      try {
        await this.refresh({ reason: "archive", mode: "archive" });
      } catch (error) {
        this.logRefreshError("archive refresh", error);
      } finally {
        if (!this.store.status.archive?.completed) {
          this.scheduleArchiveRun(this.archiveIntervalMs);
        } else {
          this.archiveNextRunAt = null;
        }
      }
    }, delayMs);
  }

  scheduleNextHourlyRun() {
    if (!this.schedulerActive) return;

    const nextRun = nextHourDate();
    this.nextRunAt = nextRun.toISOString();
    const delayMs = Math.max(1000, nextRun.getTime() - Date.now());

    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.refresh({ reason: "schedule", mode: "backfill" });
      } catch (error) {
        this.logRefreshError("scheduled refresh", error);
      } finally {
        this.scheduleNextHourlyRun();
      }
    }, delayMs);
  }

  logRefreshError(label, error) {
    const message = errorMessage(error);
    const key = `${label}:${message}`;
    const now = Date.now();
    const lastLoggedAt = this.lastErrorLogs.get(key) || 0;
    if (now - lastLoggedAt < this.errorLogThrottleMs) return;
    this.lastErrorLogs.set(key, now);
    console.error(`[crawler] ${label} failed:`, message);
  }

  nextRunMode() {
    const now = Date.now();
    if (!this.lastBackfillStartedAt) return "backfill";
    return now - this.lastBackfillStartedAt >= this.backfillIntervalMs
      ? "backfill"
      : "incremental";
  }

  refresh({ reason = "manual", mode = null } = {}) {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.run(reason, mode || this.nextRunMode()).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async run(reason, mode = "incremental") {
    const startedAt = new Date();
    const isBackfill = mode === "backfill";
    const isArchive = mode === "archive";
    if (isBackfill) this.lastBackfillStartedAt = startedAt.getTime();
    const archiveStatus = this.store.status.archive || {};
    const archiveStartPage = Math.max(1, Number(archiveStatus.nextPage || 1));
    const archiveStartedAt = archiveStatus.startedAt || startedAt.toISOString();

    await this.store.updateStatus(
      {
        running: true,
        lastStartedAt: startedAt.toISOString(),
        lastReason: reason,
        lastRunMode: mode,
        lastError: null,
        ...(isArchive
          ? {
              archive: {
                ...archiveStatus,
                enabled: true,
                running: true,
                completed: false,
                days: this.archiveDays,
                startedAt: archiveStartedAt,
                lastStartedAt: startedAt.toISOString(),
                lastError: null,
              },
            }
          : {}),
      },
      { persist: false },
    );

    try {
      const auth = await resolveTreeholeAuth();
      const cutoffDays = isArchive ? this.archiveDays : 7;
      const cutoff = Math.floor(Date.now() / 1000) - cutoffDays * DAY_SECONDS;
      const posts = [];
      let pendingPosts = [];
      let pagesFetched = 0;
      let oldestTimestamp = Number.POSITIVE_INFINITY;
      let stoppedByCutoff = false;
      let stoppedByEmpty = false;
      let stoppedByKnownOverlap = false;
      let consecutiveKnown = 0;
      let totalCached = this.store.pidIndex.size;
      let newPosts = 0;
      let updatedPosts = 0;
      let commentsCached = 0;
      const startPage = isArchive ? archiveStartPage : 1;
      const maxPages = isArchive
        ? Math.min(this.archiveMaxPages, startPage + this.archiveSlicePages - 1)
        : isBackfill
          ? this.maxPages
          : this.incrementalMaxPages;
      const commentLimit = isArchive
        ? this.commentLimitArchive
        : isBackfill
          ? this.commentLimitBackfill
          : this.commentLimitFast;

      for (let page = startPage; page <= maxPages; page += 1) {
        const { list } = await fetchHolePage(auth, {
          page,
          limit: this.pageSize,
          commentLimit,
        });
        pagesFetched = page;

        if (!list.length) {
          stoppedByEmpty = true;
          break;
        }

        const normalized = list.map(normalizePost);
        posts.push(...normalized);
        pendingPosts.push(...normalized);
        oldestTimestamp = Math.min(
          oldestTimestamp,
          ...normalized.map((post) => post.timestamp || Number.POSITIVE_INFINITY),
        );

        if (!isBackfill && !isArchive) {
          for (const post of normalized) {
            consecutiveKnown = this.store.hasPost(post.pid) ? consecutiveKnown + 1 : 0;
          }
        }

        if (page === startPage || (page - startPage + 1) % 5 === 0 || page === maxPages) {
          if (pendingPosts.length) {
            const cacheStats = await this.store.upsertPosts(pendingPosts);
            totalCached = cacheStats.totalCached;
            newPosts += cacheStats.newPosts;
            updatedPosts += cacheStats.updatedPosts;
            commentsCached += cacheStats.commentsCached;
            pendingPosts = [];
          }

          await this.store.updateStatus(
            {
              running: true,
              lastProgress: {
                mode,
                startPage,
                pagesFetched,
                postsFetched: posts.length,
                totalCached,
                newPosts,
                updatedPosts,
                commentsCached,
                oldestTimestamp:
                  oldestTimestamp === Number.POSITIVE_INFINITY ? null : oldestTimestamp,
              },
            },
            { persist: false },
          );
        }

        if (oldestTimestamp < cutoff) {
          stoppedByCutoff = true;
          break;
        }

        if (!isBackfill && !isArchive && consecutiveKnown >= this.incrementalKnownOverlap) {
          stoppedByKnownOverlap = true;
          break;
        }

        if (this.pageDelayMs) await wait(this.pageDelayMs);
      }

      if (pendingPosts.length) {
        const cacheStats = await this.store.upsertPosts(pendingPosts);
        totalCached = cacheStats.totalCached;
        newPosts += cacheStats.newPosts;
        updatedPosts += cacheStats.updatedPosts;
        commentsCached += cacheStats.commentsCached;
      }

      const finishedAt = new Date();
      const reachedMaxPages = isArchive && pagesFetched >= this.archiveMaxPages;
      const archiveCompleted = isArchive && (stoppedByCutoff || stoppedByEmpty || reachedMaxPages);
      const archiveNextPage = isArchive
        ? archiveCompleted
          ? pagesFetched || startPage
          : (pagesFetched || startPage) + 1
        : null;
      const stats = {
        mode,
        startPage,
        pagesFetched,
        postsFetched: posts.length,
        totalCached,
        newPosts,
        updatedPosts,
        commentsCached,
        stoppedByCutoff,
        stoppedByEmpty,
        stoppedByKnownOverlap,
        reachedMaxPages,
        pageSize: this.pageSize,
        maxPages,
        commentLimit,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };

      await this.store.updateStatus({
        running: false,
        lastFinishedAt: finishedAt.toISOString(),
        lastSuccessAt: finishedAt.toISOString(),
        lastError: null,
        lastStats: stats,
        lastProgress: null,
        lastIncrementalAt:
          mode === "incremental"
            ? finishedAt.toISOString()
            : this.store.status.lastIncrementalAt,
        lastBackfillAt: isBackfill ? finishedAt.toISOString() : this.store.status.lastBackfillAt,
        lastArchiveAt: isArchive ? finishedAt.toISOString() : this.store.status.lastArchiveAt,
        ...(isArchive
          ? {
              archive: {
                ...archiveStatus,
                enabled: true,
                running: false,
                completed: archiveCompleted,
                days: this.archiveDays,
                startedAt: archiveStartedAt,
                lastStartedAt: startedAt.toISOString(),
                lastRunAt: finishedAt.toISOString(),
                lastError: null,
                startPage,
                nextPage: archiveNextPage,
                lastPageFetched: pagesFetched,
                oldestTimestamp:
                  oldestTimestamp === Number.POSITIVE_INFINITY ? null : oldestTimestamp,
                cutoffTimestamp: cutoff,
                totalCached,
                newPosts,
                updatedPosts,
                commentsCached,
                stoppedByCutoff,
                stoppedByEmpty,
                reachedMaxPages,
              },
            }
          : {}),
        auth: authPublicInfo(auth),
      });

      return stats;
    } catch (error) {
      const message = errorMessage(error);
      if (/HTTP 401|HTTP 403|code=401|code=403|登录态/.test(message)) {
        clearTreeholeAuthCache();
      }
      await this.store.updateStatus({
        running: false,
        lastFinishedAt: new Date().toISOString(),
        lastError: message,
        lastProgress: null,
        ...(isArchive
          ? {
              archive: {
                ...archiveStatus,
                enabled: true,
                running: false,
                completed: false,
                days: this.archiveDays,
                startedAt: archiveStartedAt,
                lastError: message,
              },
            }
          : {}),
      });
      throw error;
    }
  }
}
