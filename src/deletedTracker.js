import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveTreeholeAuth } from "./auth.js";
import { fetchHolePage, fetchHolePresence } from "./treeholeClient.js";

const STORE_VERSION = 1;
const DAY_SECONDS = 24 * 60 * 60;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 6000;
const DEFAULT_PAGE_DELAY_MS = 150;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_SCHEDULE_HOUR = 4;
const DEFAULT_LOOKBACK_DAYS = 60;
const DEFAULT_IGNORE_RECENT_SECONDS = 10 * 60;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MS = 2000;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFlag(name, fallback = true) {
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

async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, filePath);
}

function defaultStatus() {
  return {
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastReason: null,
    lastStats: null,
    lastProgress: null,
    nextRunAt: null,
  };
}

function nextDailyDate(hour, minute = 0, now = new Date()) {
  const next = new Date(now.getTime());
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

export class DeletedPostTracker {
  constructor(store, dataDir, options = {}) {
    this.store = store;
    this.filePath = options.filePath || path.join(dataDir, "deleted-posts.json");
    this.enabled = options.enabled ?? envFlag("TREEHOLE_DELETED_SCAN_ENABLED", true);
    this.pageSize = options.pageSize || envNumber("TREEHOLE_DELETED_PAGE_SIZE", DEFAULT_PAGE_SIZE);
    this.maxPages = options.maxPages || envNumber("TREEHOLE_DELETED_MAX_PAGES", DEFAULT_MAX_PAGES);
    this.pageDelayMs =
      options.pageDelayMs || envNumber("TREEHOLE_DELETED_PAGE_DELAY_MS", DEFAULT_PAGE_DELAY_MS);
    this.concurrency = Math.max(
      1,
      Math.min(
        options.concurrency || envNumber("TREEHOLE_DELETED_CONCURRENCY", DEFAULT_CONCURRENCY),
        100,
      ),
    );
    this.pageConcurrency = Math.max(
      1,
      Math.min(
        options.pageConcurrency ||
          envNumber("TREEHOLE_DELETED_PAGE_CONCURRENCY", Math.min(this.concurrency, 8)),
        30,
      ),
    );
    this.scheduleHour =
      options.scheduleHour ?? envNumber("TREEHOLE_DELETED_SCAN_HOUR", DEFAULT_SCHEDULE_HOUR);
    this.lookbackDays =
      options.lookbackDays || envNumber("TREEHOLE_DELETED_LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS);
    this.verifyDetail = options.verifyDetail ?? envFlag("TREEHOLE_DELETED_VERIFY_DETAIL", true);
    this.ignoreRecentSeconds =
      options.ignoreRecentSeconds ||
      envNumber("TREEHOLE_DELETED_IGNORE_RECENT_SECONDS", DEFAULT_IGNORE_RECENT_SECONDS);
    this.retryCount = options.retryCount || envNumber("TREEHOLE_DELETED_RETRY_COUNT", DEFAULT_RETRY_COUNT);
    this.retryDelayMs =
      options.retryDelayMs || envNumber("TREEHOLE_DELETED_RETRY_DELAY_MS", DEFAULT_RETRY_DELAY_MS);

    this.status = defaultStatus();
    this.records = new Map();
    this.timer = null;
    this.activeRun = null;
    this.schedulerActive = false;
    this.fileMtimeMs = 0;
  }

  async load({ resetRunning = true } = {}) {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const data = JSON.parse(raw);
      this.status = { ...defaultStatus(), ...(data.status || {}) };
      if (resetRunning) this.status.running = false;
      this.records = new Map(
        (Array.isArray(data.records) ? data.records : []).map((record) => [
          Number(record.pid),
          {
            pid: Number(record.pid),
            firstDetectedAt: record.firstDetectedAt || null,
            lastDetectedAt: record.lastDetectedAt || null,
            missingRuns: Number(record.missingRuns || 0),
            timestamp: Number(record.timestamp || 0),
          },
        ]),
      );
      const stat = await fs.stat(this.filePath).catch(() => null);
      this.fileMtimeMs = stat?.mtimeMs || Date.now();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.status = defaultStatus();
      this.records = new Map();
      this.fileMtimeMs = 0;
    }
  }

  async reloadIfChanged() {
    if (this.activeRun) return;
    const stat = await fs.stat(this.filePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) return;
    if (this.fileMtimeMs && stat.mtimeMs <= this.fileMtimeMs + 1) return;
    await this.load({ resetRunning: false });
  }

  publicStatus() {
    return {
      ...this.status,
      count: this.records.size,
      enabled: this.enabled,
      scheduleHour: this.scheduleHour,
      concurrency: this.concurrency,
      pageConcurrency: this.pageConcurrency,
      lookbackDays: this.lookbackDays,
      verifyDetail: this.verifyDetail,
    };
  }

  async save() {
    await atomicWriteJson(this.filePath, {
      version: STORE_VERSION,
      status: this.status,
      records: [...this.records.values()].sort(
        (a, b) =>
          Date.parse(b.lastDetectedAt || "") - Date.parse(a.lastDetectedAt || "") ||
          Number(b.pid) - Number(a.pid),
      ),
    });
    const stat = await fs.stat(this.filePath).catch(() => null);
    this.fileMtimeMs = stat?.mtimeMs || Date.now();
  }

  startScheduler() {
    if (!this.enabled || this.schedulerActive) return;
    this.schedulerActive = true;
    this.scheduleNextRun();
  }

  stopScheduler() {
    this.schedulerActive = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.status.nextRunAt = null;
  }

  scheduleNextRun() {
    if (!this.schedulerActive || !this.enabled) return;
    if (this.timer) clearTimeout(this.timer);

    const next = nextDailyDate(this.scheduleHour);
    this.status.nextRunAt = next.toISOString();
    const delayMs = Math.max(1000, next.getTime() - Date.now());
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.refresh({ reason: "schedule" });
      } catch (error) {
        console.error("[deleted] scheduled scan failed:", errorMessage(error));
      } finally {
        this.scheduleNextRun();
      }
    }, delayMs);
    this.timer.unref?.();
  }

  refresh({ reason = "manual" } = {}) {
    if (this.activeRun) return this.activeRun;
    this.activeRun = this.run(reason).finally(() => {
      this.activeRun = null;
    });
    return this.activeRun;
  }

  async fetchPageWithRetry(auth, page) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        return await fetchHolePage(auth, {
          page,
          limit: this.pageSize,
          commentLimit: 0,
        });
      } catch (error) {
        lastError = error;
        if (attempt >= this.retryCount) break;
        await wait(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  async fetchPresenceWithRetry(auth, pid) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        return await fetchHolePresence(auth, pid);
      } catch (error) {
        lastError = error;
        if (attempt >= this.retryCount) break;
        await wait(this.retryDelayMs * (attempt + 1));
      }
    }
    throw lastError;
  }

  async confirmDeleted(auth, missing, previousRecords = new Map()) {
    if (!missing.length) {
      return { confirmed: [], checked: 0, presentAfterConfirm: 0 };
    }

    const confirmed = [];
    let checked = 0;
    let presentAfterConfirm = 0;

    for (let index = 0; index < missing.length; index += this.concurrency) {
      const batch = missing.slice(index, index + this.concurrency);
      const results = await Promise.all(
        batch.map(async (post) => ({
          post,
          presence: await this.fetchPresenceWithRetry(auth, post.pid),
        })),
      );

      const detectedAt = new Date().toISOString();
      let changedRecords = false;
      for (const { post, presence } of results) {
        checked += 1;
        if (presence.deleted) {
          confirmed.push(post);
          const pid = Number(post.pid);
          const existing = previousRecords.get(pid) || this.records.get(pid);
          this.records.set(pid, {
            pid,
            firstDetectedAt: existing?.firstDetectedAt || detectedAt,
            lastDetectedAt: detectedAt,
            missingRuns: Number(existing?.missingRuns || 0) + 1,
            timestamp: Number(post.timestamp || 0),
          });
          changedRecords = true;
        } else {
          presentAfterConfirm += 1;
        }
      }

      if (changedRecords || checked % 200 === 0 || checked === missing.length) {
        this.status.lastProgress = {
          ...(this.status.lastProgress || {}),
          confirming: true,
          confirmCandidates: missing.length,
          confirmChecked: checked,
          confirmedDeleted: confirmed.length,
          presentAfterConfirm,
        };
        await this.save();
      }
    }

    return { confirmed, checked, presentAfterConfirm };
  }

  async run(reason) {
    const startedAt = new Date();
    this.status = {
      ...this.status,
      running: true,
      lastStartedAt: startedAt.toISOString(),
      lastReason: reason,
      lastError: null,
      lastProgress: null,
    };
    await this.save();

    const previousRecords = this.records;

    try {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const lookbackSeconds = this.lookbackDays * DAY_SECONDS;
      const lookbackFromTimestamp = nowSeconds - lookbackSeconds;
      const storeStats = this.store.stats();
      const oldestCachedTimestamp = Number(storeStats.oldestTimestamp || 0);
      const compareFromTimestamp = Math.max(lookbackFromTimestamp, oldestCachedTimestamp || 0);
      const auth = await resolveTreeholeAuth();
      const presentPids = new Set();
      let pagesFetched = 0;
      let postsFetched = 0;
      let oldestTimestamp = Number.POSITIVE_INFINITY;
      let stoppedByEmpty = false;
      let stoppedByLookbackBoundary = false;
      let reachedMaxPages = false;
      let totalFromApi = null;
      let lastProgressPage = 0;

      for (let page = 1; page <= this.maxPages; ) {
        const batchStart = page;
        const batchEnd = Math.min(this.maxPages, batchStart + this.pageConcurrency - 1);
        const batch = await Promise.all(
          Array.from({ length: batchEnd - batchStart + 1 }, async (_, index) => {
            const batchPage = batchStart + index;
            return {
              page: batchPage,
              result: await this.fetchPageWithRetry(auth, batchPage),
            };
          }),
        );

        for (const { page: fetchedPage, result } of batch) {
          const { list, total } = result;
          pagesFetched = Math.max(pagesFetched, fetchedPage);
          if (Number.isFinite(total) && total > 0 && totalFromApi === null) {
            totalFromApi = total;
          }

          if (!list.length) {
            stoppedByEmpty = true;
            break;
          }

          for (const raw of list) {
            const pid = Number(raw?.pid);
            if (Number.isFinite(pid) && pid > 0) presentPids.add(pid);
            const ts = Number(raw?.timestamp || 0);
            if (ts && ts < oldestTimestamp) oldestTimestamp = ts;
          }
          postsFetched += list.length;

          if (compareFromTimestamp && oldestTimestamp <= compareFromTimestamp) {
            stoppedByLookbackBoundary = true;
            break;
          }
        }

        if (
          pagesFetched - lastProgressPage >= 20 ||
          pagesFetched >= this.maxPages ||
          stoppedByEmpty ||
          stoppedByLookbackBoundary
        ) {
          this.status.lastProgress = {
            pagesFetched,
            postsFetched,
            presentCount: presentPids.size,
            targetMaxPages: this.maxPages,
            pageConcurrency: this.pageConcurrency,
            confirmConcurrency: this.concurrency,
            lookbackDays: this.lookbackDays,
            oldestFetchedTimestamp:
              oldestTimestamp === Number.POSITIVE_INFINITY ? null : oldestTimestamp,
            oldestCachedTimestamp: oldestCachedTimestamp || null,
            compareFromTimestamp,
          };
          lastProgressPage = pagesFetched;
          await this.save();
        }

        if (stoppedByEmpty || stoppedByLookbackBoundary) break;
        page = batchEnd + 1;
        if (this.pageDelayMs) await wait(this.pageDelayMs);
      }

      reachedMaxPages =
        pagesFetched >= this.maxPages && !stoppedByEmpty && !stoppedByLookbackBoundary;
      const coverageFromTimestamp =
        reachedMaxPages && oldestTimestamp !== Number.POSITIVE_INFINITY
          ? Math.max(oldestTimestamp, compareFromTimestamp)
          : compareFromTimestamp;
      const compareUntilTimestamp = nowSeconds - this.ignoreRecentSeconds;
      const { missing, compared, monthsCompared } = await this.store.missingFromPresent(
        presentPids,
        {
          fromTimestamp: coverageFromTimestamp,
          toTimestamp: compareUntilTimestamp,
        },
      );
      const previouslyConfirmed = [];
      const candidatesToConfirm = [];
      for (const post of missing) {
        if (previousRecords.has(Number(post.pid))) {
          previouslyConfirmed.push(post);
        } else {
          candidatesToConfirm.push(post);
        }
      }
      this.records = new Map(
        [...previousRecords.entries()].filter(([, record]) => {
          const ts = Number(record.timestamp || 0);
          return ts >= coverageFromTimestamp && ts <= compareUntilTimestamp;
        }),
      );
      this.status.lastProgress = {
        ...(this.status.lastProgress || {}),
        confirming: true,
        missingCandidates: missing.length,
        alreadyConfirmed: previouslyConfirmed.length,
        confirmCandidates: candidatesToConfirm.length,
        confirmChecked: 0,
        confirmedDeleted: 0,
        presentAfterConfirm: 0,
        detailVerified: this.verifyDetail,
      };
      await this.save();
      let newlyConfirmedMissing = candidatesToConfirm;
      let confirmedChecked = 0;
      let presentAfterConfirm = 0;
      if (this.verifyDetail) {
        const confirmedResult = await this.confirmDeleted(
          auth,
          candidatesToConfirm,
          previousRecords,
        );
        newlyConfirmedMissing = confirmedResult.confirmed;
        confirmedChecked = confirmedResult.checked;
        presentAfterConfirm = confirmedResult.presentAfterConfirm;
      }
      const confirmedMissing = [...previouslyConfirmed, ...newlyConfirmedMissing];

      const finishedAt = new Date();
      const records = new Map();
      let newDeleted = 0;

      for (const post of confirmedMissing) {
        const pid = Number(post.pid);
        const existing = previousRecords.get(pid);
        if (!existing) newDeleted += 1;
        records.set(pid, {
          pid,
          firstDetectedAt: existing?.firstDetectedAt || finishedAt.toISOString(),
          lastDetectedAt: finishedAt.toISOString(),
          missingRuns: Number(existing?.missingRuns || 0) + 1,
          timestamp: Number(post.timestamp || 0),
        });
      }

      const resolvedCount = [...previousRecords.keys()].filter((pid) => !records.has(pid)).length;
      this.records = records;
      const stats = {
        pagesFetched,
        postsFetched,
        presentCount: presentPids.size,
        cachedCompared: compared,
        monthsCompared,
        deletedCount: records.size,
        missingCandidates: missing.length,
        alreadyConfirmed: previouslyConfirmed.length,
        confirmCandidates: candidatesToConfirm.length,
        confirmedChecked,
        presentAfterConfirm,
        detailVerified: this.verifyDetail,
        newDeleted,
        resolvedCount,
        totalFromApi,
        pageSize: this.pageSize,
        maxPages: this.maxPages,
        pageConcurrency: this.pageConcurrency,
        confirmConcurrency: this.concurrency,
        lookbackDays: this.lookbackDays,
        lookbackFromTimestamp,
        oldestCachedTimestamp: oldestCachedTimestamp || null,
        compareFromTimestamp,
        coverageFromTimestamp,
        compareUntilTimestamp,
        stoppedByEmpty,
        stoppedByLookbackBoundary,
        reachedMaxPages,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      };

      this.status = {
        ...this.status,
        running: false,
        lastFinishedAt: finishedAt.toISOString(),
        lastSuccessAt: finishedAt.toISOString(),
        lastError: null,
        lastStats: stats,
        lastProgress: null,
      };
      await this.save();
      return stats;
    } catch (error) {
      const finishedAt = new Date();
      this.status = {
        ...this.status,
        running: false,
        lastFinishedAt: finishedAt.toISOString(),
        lastError: errorMessage(error),
      };
      await this.save();
      throw error;
    }
  }

  async list({ limit = 100, offset = 0, query = "", sort = "detected" } = {}) {
    await this.reloadIfChanged();
    const records = [...this.records.values()];
    const list = await this.store.summariesForRecords(records, { limit, offset, query, sort });
    return {
      list,
      status: this.publicStatus(),
    };
  }
}
