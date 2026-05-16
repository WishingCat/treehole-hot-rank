import { authPublicInfo, resolveTreeholeAuth } from "./auth.js";
import { fetchHolePage, normalizePost } from "./treeholeClient.js";

const DAY_SECONDS = 24 * 60 * 60;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
    this.pageDelayMs = options.pageDelayMs || envNumber("TREEHOLE_PAGE_DELAY_MS", 150);
    this.intervalMs =
      options.intervalMs || envNumber("TREEHOLE_CRAWL_INTERVAL_MS", 60 * 60 * 1000);
    const scheduleMode =
      options.scheduleMode || process.env.TREEHOLE_SCHEDULE_MODE || "hourly";
    this.scheduleMode = scheduleMode === "interval" ? "interval" : "hourly";
    this.activeRun = null;
    this.timer = null;
    this.schedulerActive = false;
    this.nextRunAt = null;
  }

  startScheduler() {
    if (this.schedulerActive) return;
    this.schedulerActive = true;

    if (this.scheduleMode === "interval") {
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      this.timer = setInterval(() => {
        this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
        this.refresh({ reason: "schedule" }).catch((error) => {
          console.error("[crawler] scheduled refresh failed:", errorMessage(error));
        });
      }, this.intervalMs);
      return;
    }

    this.scheduleNextHourlyRun();
  }

  stopScheduler() {
    this.schedulerActive = false;
    if (this.timer) {
      clearInterval(this.timer);
      clearTimeout(this.timer);
    }
    this.timer = null;
    this.nextRunAt = null;
  }

  scheduleNextHourlyRun() {
    if (!this.schedulerActive) return;

    const nextRun = nextHourDate();
    this.nextRunAt = nextRun.toISOString();
    const delayMs = Math.max(1000, nextRun.getTime() - Date.now());

    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.refresh({ reason: "schedule" });
      } catch (error) {
        console.error("[crawler] scheduled refresh failed:", errorMessage(error));
      } finally {
        this.scheduleNextHourlyRun();
      }
    }, delayMs);
  }

  refresh({ reason = "manual" } = {}) {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.run(reason).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async run(reason) {
    const startedAt = new Date();
    await this.store.updateStatus({
      running: true,
      lastStartedAt: startedAt.toISOString(),
      lastReason: reason,
      lastError: null,
    });

    try {
      const auth = await resolveTreeholeAuth();
      const cutoff = Math.floor(Date.now() / 1000) - 7 * DAY_SECONDS;
      const posts = [];
      let pendingPosts = [];
      let pagesFetched = 0;
      let oldestTimestamp = Number.POSITIVE_INFINITY;
      let stoppedByCutoff = false;
      let totalCached = this.store.posts.size;

      for (let page = 1; page <= this.maxPages; page += 1) {
        const { list } = await fetchHolePage(auth, {
          page,
          limit: this.pageSize,
        });
        pagesFetched = page;

        if (!list.length) break;

        const normalized = list.map(normalizePost);
        posts.push(...normalized);
        pendingPosts.push(...normalized);
        oldestTimestamp = Math.min(
          oldestTimestamp,
          ...normalized.map((post) => post.timestamp || Number.POSITIVE_INFINITY),
        );

        if (page === 1 || page % 5 === 0) {
          if (pendingPosts.length) {
            const cacheStats = await this.store.upsertPosts(pendingPosts, {
              keepDays: 8,
            });
            totalCached = cacheStats.totalCached;
            pendingPosts = [];
          }

          await this.store.updateStatus({
            running: true,
            lastProgress: {
              pagesFetched,
              postsFetched: posts.length,
              totalCached,
              oldestTimestamp:
                oldestTimestamp === Number.POSITIVE_INFINITY ? null : oldestTimestamp,
            },
          });
        }

        if (oldestTimestamp < cutoff) {
          stoppedByCutoff = true;
          break;
        }

        if (this.pageDelayMs) await wait(this.pageDelayMs);
      }

      if (pendingPosts.length) {
        const cacheStats = await this.store.upsertPosts(pendingPosts, { keepDays: 8 });
        totalCached = cacheStats.totalCached;
      }
      const finishedAt = new Date();
      const stats = {
        pagesFetched,
        postsFetched: posts.length,
        totalCached,
        stoppedByCutoff,
        pageSize: this.pageSize,
        maxPages: this.maxPages,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };

      await this.store.updateStatus({
        running: false,
        lastFinishedAt: finishedAt.toISOString(),
        lastSuccessAt: finishedAt.toISOString(),
        lastError: null,
        lastStats: stats,
        lastProgress: null,
        auth: authPublicInfo(auth),
      });

      return stats;
    } catch (error) {
      await this.store.updateStatus({
        running: false,
        lastFinishedAt: new Date().toISOString(),
        lastError: errorMessage(error),
        lastProgress: null,
      });
      throw error;
    }
  }
}
