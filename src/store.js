import { promises as fs } from "node:fs";
import path from "node:path";

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

function windowSeconds(window) {
  if (window === "hour") return HOUR_SECONDS;
  if (window === "week") return 7 * DAY_SECONDS;
  return DAY_SECONDS;
}

function sortMetric(post, sort) {
  if (sort === "follow") return post.follow || 0;
  if (sort === "praise") return post.praise || 0;
  return post.reply || 0;
}

export class HotStore {
  constructor(cacheFile) {
    this.cacheFile = cacheFile;
    this.posts = new Map();
    this.status = {
      running: false,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastReason: null,
      lastStats: null,
      auth: null,
    };
  }

  async load() {
    try {
      const raw = await fs.readFile(this.cacheFile, "utf8");
      const data = JSON.parse(raw);
      this.posts = new Map(
        Object.entries(data.posts || {}).map(([pid, post]) => [Number(pid), post]),
      );
      this.status = { ...this.status, ...(data.status || {}) };
      this.status.running = false;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async persist() {
    await fs.mkdir(path.dirname(this.cacheFile), { recursive: true });
    const payload = {
      status: this.status,
      posts: Object.fromEntries(this.posts),
    };
    const tmpFile = `${this.cacheFile}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(payload, null, 2));
    await fs.rename(tmpFile, this.cacheFile);
  }

  async updateStatus(patch) {
    this.status = { ...this.status, ...patch };
    await this.persist();
  }

  async upsertPosts(posts, { keepDays = 8 } = {}) {
    for (const post of posts) {
      if (!post.pid) continue;
      this.posts.set(post.pid, { ...(this.posts.get(post.pid) || {}), ...post });
    }

    const keepAfter = Math.floor(Date.now() / 1000) - keepDays * DAY_SECONDS;
    for (const [pid, post] of this.posts) {
      if ((post.timestamp || 0) < keepAfter) this.posts.delete(pid);
    }

    await this.persist();
    return {
      totalCached: this.posts.size,
      upserted: posts.length,
    };
  }

  hotList({ window = "day", sort = "reply", limit = 100, query = "" } = {}) {
    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds(window);
    const normalizedQuery = query.trim().toLowerCase();

    return [...this.posts.values()]
      .filter((post) => (post.timestamp || 0) >= cutoff)
      .filter((post) => {
        if (!normalizedQuery) return true;
        return (
          String(post.pid).includes(normalizedQuery) ||
          post.text.toLowerCase().includes(normalizedQuery) ||
          post.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery))
        );
      })
      .sort((a, b) => {
        const metricDelta = sortMetric(b, sort) - sortMetric(a, sort);
        if (metricDelta !== 0) return metricDelta;
        const replyDelta = (b.reply || 0) - (a.reply || 0);
        if (replyDelta !== 0) return replyDelta;
        const followDelta = (b.follow || 0) - (a.follow || 0);
        if (followDelta !== 0) return followDelta;
        return (b.timestamp || 0) - (a.timestamp || 0);
      })
      .slice(0, Math.max(1, Math.min(Number(limit) || 100, 300)));
  }

  stats() {
    const now = Math.floor(Date.now() / 1000);
    const posts = [...this.posts.values()];
    return {
      cached: posts.length,
      hour: posts.filter((post) => (post.timestamp || 0) >= now - HOUR_SECONDS)
        .length,
      day: posts.filter((post) => (post.timestamp || 0) >= now - DAY_SECONDS).length,
      week: posts.filter((post) => (post.timestamp || 0) >= now - 7 * DAY_SECONDS)
        .length,
      newestTimestamp: posts.reduce(
        (max, post) => Math.max(max, post.timestamp || 0),
        0,
      ),
      oldestTimestamp: posts.reduce((min, post) => {
        const timestamp = post.timestamp || 0;
        return timestamp && timestamp < min ? timestamp : min;
      }, Number.POSITIVE_INFINITY),
    };
  }
}
