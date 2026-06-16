import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import streamJson from "stream-json";
import streamJsonPick from "stream-json/filters/Pick.js";
import streamJsonStreamObject from "stream-json/streamers/StreamObject.js";

const { parser } = streamJson;
const { pick } = streamJsonPick;
const { streamObject } = streamJsonStreamObject;

const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;

const STORE_VERSION = 2;
const DEFAULT_MAX_LOADED_SHARDS = 4;
const DEFAULT_MAX_LOADED_SUMMARY_SHARDS = 8;
const DEFAULT_TOP_CACHE_LIMIT = 5000;
const DEFAULT_DETAIL_CACHE_LIMIT = 300;
const DEFAULT_PERSIST_DEBOUNCE_MS = 4000;
const DEFAULT_PERSIST_INTERVAL_MS = 30000;

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

function mergeValue(existing, incoming) {
  if (incoming === undefined || incoming === null) return existing;
  if (typeof incoming === "string" && incoming === "") return existing;
  if (Array.isArray(incoming) && incoming.length === 0) return existing;
  return incoming;
}

function commentKey(comment) {
  return String(
    comment.cid || comment.id || comment.floor || `${comment.timestamp}:${comment.text}`,
  );
}

function mergeComments(existing = [], incoming = []) {
  const comments = new Map();
  for (const comment of existing) {
    comments.set(commentKey(comment), comment);
  }
  for (const comment of incoming) {
    const key = commentKey(comment);
    comments.set(key, { ...(comments.get(key) || {}), ...comment });
  }
  return [...comments.values()].sort(
    (a, b) =>
      (a.floor || 0) - (b.floor || 0) || (a.timestamp || 0) - (b.timestamp || 0),
  );
}

function mergePost(existing = {}, incoming) {
  const now = new Date().toISOString();
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "comments") continue;
    merged[key] = mergeValue(existing[key], value);
  }
  merged.firstSeenAt = existing.firstSeenAt || incoming.firstSeenAt || now;
  merged.lastSeenAt = incoming.lastSeenAt || now;
  merged.updatedAt = incoming.updatedAt || now;
  if (incoming.comments?.length) {
    merged.comments = mergeComments(existing.comments, incoming.comments);
    merged.commentsFetchedAt = incoming.commentsFetchedAt || now;
  } else if (existing.comments?.length) {
    merged.comments = existing.comments;
  }
  return merged;
}

function summarizePost(post) {
  const { comments, ...summary } = post;
  summary.commentsCached = Array.isArray(comments)
    ? comments.length
    : Number(summary.commentsCached || 0);
  return summary;
}

function normalizeSummaryPost(post) {
  const summary = summarizePost(normalizeCachedPost(post));
  summary.pid = Number(summary.pid);
  summary.timestamp = Number(summary.timestamp || 0);
  summary.reply = Number(summary.reply || 0);
  summary.follow = Number(summary.follow || 0);
  summary.praise = Number(summary.praise || 0);
  summary.commentTotal = Number(summary.commentTotal || summary.reply || 0);
  summary.mediaCount = Number(summary.mediaCount || 0);
  return summary;
}

function clampLimit(limit) {
  return Math.max(1, Math.min(Number(limit) || 100, 300));
}

function clampOffset(offset) {
  return Math.max(0, Math.min(Math.floor(Number(offset) || 0), 200000));
}

function slicePage(list, offset, limit) {
  return list.slice(offset, offset + limit);
}

function rankedCompare(sort) {
  return (a, b) => {
    const metricDelta = sortMetric(b, sort) - sortMetric(a, sort);
    if (metricDelta !== 0) return metricDelta;
    const replyDelta = (b.reply || 0) - (a.reply || 0);
    if (replyDelta !== 0) return replyDelta;
    const followDelta = (b.follow || 0) - (a.follow || 0);
    if (followDelta !== 0) return followDelta;
    return (b.timestamp || 0) - (a.timestamp || 0);
  };
}

function realtimeCompare(a, b) {
  const timeDelta = (b.timestamp || 0) - (a.timestamp || 0);
  if (timeDelta !== 0) return timeDelta;
  return (b.pid || 0) - (a.pid || 0);
}

function pushTop(list, candidate, compare, limit) {
  list.push(candidate);
  const bufferLimit = Math.max(limit * 4, 1000);
  if (list.length > bufferLimit) {
    list.sort(compare);
    list.length = limit;
  }
}

function topListFromPosts(posts, compare, limit) {
  const selected = [];
  for (const post of posts) pushTop(selected, post, compare, limit);
  return selected.sort(compare).slice(0, limit);
}

function buildTopCache(summary, limit) {
  const posts = [...summary.posts.values()];
  return {
    version: STORE_VERSION,
    key: summary.key,
    limit,
    reply: topListFromPosts(posts, rankedCompare("reply"), limit),
    follow: topListFromPosts(posts, rankedCompare("follow"), limit),
    realtime: topListFromPosts(posts, realtimeCompare, limit),
  };
}

async function readTopCacheFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  return {
    version: data.version || STORE_VERSION,
    key: data.key,
    limit: Number(data.limit || 0),
    reply: Array.isArray(data.reply) ? data.reply.map(normalizeSummaryPost) : [],
    follow: Array.isArray(data.follow) ? data.follow.map(normalizeSummaryPost) : [],
    realtime: Array.isArray(data.realtime) ? data.realtime.map(normalizeSummaryPost) : [],
  };
}

function normalizeCachedPost(post) {
  const commentTotal = Number(post.commentTotal || 0);
  const reply = Number(post.reply || 0);
  const cachedComments = Array.isArray(post.comments) ? post.comments.length : 0;

  if (commentTotal >= 1000 && reply > 0 && reply < commentTotal) {
    return {
      ...post,
      commentTotal: Math.max(reply, cachedComments),
    };
  }

  return post;
}

function matchesQuery(post, query) {
  if (!query) return true;
  const text = String(post.text || "").toLowerCase();
  const tags = Array.isArray(post.tags) ? post.tags : [];
  return (
    String(post.pid).includes(query) ||
    text.includes(query) ||
    tags.some((tag) => String(tag).toLowerCase().includes(query))
  );
}

export function shardKeyForTimestamp(timestamp) {
  const ts = Number(timestamp) || 0;
  if (ts <= 0) return "unknown";
  const date = new Date(ts * 1000);
  if (Number.isNaN(date.getTime())) return "unknown";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function compareShardKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function previousShardKey(key) {
  if (!/^\d{4}-\d{2}$/.test(key)) return null;
  const [year, month] = key.split("-").map(Number);
  if (month === 1) return `${year - 1}-12`;
  return `${year}-${String(month - 1).padStart(2, "0")}`;
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
    auth: null,
  };
}

async function atomicWriteJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload));
  await fs.rename(tmp, filePath);
}

async function readJsonStreamed(filePath) {
  // Streamed JSON parse — never materializes the whole file as one string.
  // Each stage in the pipe gets its own error handler: createReadStream's
  // ENOENT is emitted on the file stream itself and would otherwise bypass
  // a single handler on the tail of the pipeline, crashing the process.
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const result = {};
    const fileStream = createReadStream(filePath);
    const parserStream = parser();
    const objectStream = streamObject();

    fileStream.on("error", (error) => settle(reject, error));
    parserStream.on("error", (error) => settle(reject, error));
    objectStream.on("error", (error) => settle(reject, error));

    objectStream.on("data", ({ key, value }) => {
      result[key] = value;
    });
    objectStream.on("end", () => settle(resolve, result));

    fileStream.pipe(parserStream).pipe(objectStream);
  });
}

async function readSummaryFile(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const data = JSON.parse(raw);
  const entries = Array.isArray(data.posts)
    ? data.posts.map((post) => [Number(post.pid), post])
    : Object.entries(data.posts || {}).map(([pid, post]) => [Number(pid), post]);
  return new Map(
    entries
      .filter(([pid]) => Number.isFinite(pid) && pid > 0)
      .map(([pid, post]) => [pid, normalizeSummaryPost({ ...post, pid })]),
  );
}

async function readSummariesFromShardFile(filePath) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const summaries = new Map();
    const fileStream = createReadStream(filePath);
    const parserStream = parser();
    const pickStream = pick({ filter: "posts" });
    const objectStream = streamObject();

    fileStream.on("error", (error) => settle(reject, error));
    parserStream.on("error", (error) => settle(reject, error));
    pickStream.on("error", (error) => settle(reject, error));
    objectStream.on("error", (error) => settle(reject, error));

    objectStream.on("data", ({ key, value }) => {
      const pid = Number(key || value?.pid);
      if (!Number.isFinite(pid) || pid <= 0) return;
      summaries.set(pid, normalizeSummaryPost({ ...value, pid }));
    });
    objectStream.on("end", () => settle(resolve, summaries));

    fileStream.pipe(parserStream).pipe(pickStream).pipe(objectStream);
  });
}

async function readPostFromShardFile(filePath, targetPid) {
  const numericPid = Number(targetPid);
  if (!Number.isFinite(numericPid) || numericPid <= 0) return null;

  const raw = await fs.readFile(filePath, "utf8");
  const pattern = `"${numericPid}":`;
  let searchFrom = 0;

  while (searchFrom < raw.length) {
    const keyIndex = raw.indexOf(pattern, searchFrom);
    if (keyIndex === -1) return null;
    const objectStart = raw.indexOf("{", keyIndex + pattern.length);
    if (objectStart === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = objectStart; index < raw.length; index += 1) {
      const char = raw[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value = JSON.parse(raw.slice(objectStart, index + 1));
            return normalizeCachedPost({ ...value, pid: numericPid });
          } catch {
            break;
          }
        }
      }
    }

    searchFrom = keyIndex + pattern.length;
  }

  return null;
}

class Shard {
  constructor(key) {
    this.key = key;
    this.posts = new Map();
    this.dirty = false;
    this.lastAccessed = Date.now();
  }

  upsert(post) {
    if (!post?.pid) return { isNew: false };
    const pid = Number(post.pid);
    const existing = this.posts.get(pid);
    const merged = mergePost(existing, post);
    this.posts.set(pid, merged);
    this.dirty = true;
    this.lastAccessed = Date.now();
    return { isNew: !existing, post: merged };
  }

  size() {
    return this.posts.size;
  }
}

class SummaryShard {
  constructor(key, posts = new Map()) {
    this.key = key;
    this.posts = posts;
    this.dirty = false;
    this.lastAccessed = Date.now();
  }

  upsert(post) {
    if (!post?.pid) return;
    this.posts.set(Number(post.pid), normalizeSummaryPost(post));
    this.dirty = true;
    this.lastAccessed = Date.now();
  }
}

export class HotStore {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.shardsDir = path.join(dataDir, "shards");
    this.summariesDir = path.join(dataDir, "summaries");
    this.topsDir = path.join(dataDir, "tops");
    this.indexPath = path.join(dataDir, "index.json");
    this.statusPath = path.join(dataDir, "status.json");
    this.legacyCachePath = path.join(dataDir, "hot-cache.json");

    this.maxLoadedShards = options.maxLoadedShards || DEFAULT_MAX_LOADED_SHARDS;
    this.maxLoadedSummaryShards =
      options.maxLoadedSummaryShards || DEFAULT_MAX_LOADED_SUMMARY_SHARDS;
    this.topCacheLimit = options.topCacheLimit || DEFAULT_TOP_CACHE_LIMIT;
    this.detailCacheLimit = options.detailCacheLimit || DEFAULT_DETAIL_CACHE_LIMIT;
    this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
    this.persistIntervalMs = options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;

    this.status = defaultStatus();
    this.shardMeta = new Map(); // shardKey -> { count, minTimestamp, maxTimestamp, updatedAt }
    this.pidIndex = new Map(); // pid -> shardKey
    this.shards = new Map(); // shardKey -> Shard
    this.summaryShards = new Map(); // shardKey -> SummaryShard
    this.summaryLoads = new Map(); // shardKey -> Promise<SummaryShard>
    this.topShards = new Map(); // shardKey -> { reply, follow, realtime }
    this.topLoads = new Map(); // shardKey -> Promise<object>
    this.detailCache = new Map(); // pid -> full post, small LRU for detail clicks
    this.indexDirty = false;
    this.statusDirty = false;

    this.persistTimer = null;
    this.persistIntervalTimer = null;
    this.persistInFlight = null;
  }

  async load() {
    await fs.mkdir(this.shardsDir, { recursive: true });
    await fs.mkdir(this.summariesDir, { recursive: true });
    await fs.mkdir(this.topsDir, { recursive: true });

    let indexLoaded = false;
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const data = JSON.parse(raw);
      this.status = { ...defaultStatus(), ...(data.status || {}) };
      this.status.running = false;
      if (this.status.archive) {
        this.status.archive = { ...this.status.archive, running: false };
      }
      this.shardMeta = new Map(Object.entries(data.shards || {}));
      this.pidIndex = new Map(
        Object.entries(data.pidIndex || {}).map(([pid, key]) => [Number(pid), key]),
      );
      indexLoaded = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    try {
      const raw = await fs.readFile(this.statusPath, "utf8");
      const data = JSON.parse(raw);
      this.status = { ...defaultStatus(), ...(data.status || data || {}) };
      this.status.running = false;
      if (this.status.archive) {
        this.status.archive = { ...this.status.archive, running: false };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (indexLoaded) this.statusDirty = true;
    }

    if (!indexLoaded) {
      // Best-effort: rebuild a minimal index from whatever shard files exist.
      const entries = await fs.readdir(this.shardsDir).catch(() => []);
      for (const file of entries) {
        if (!file.endsWith(".json")) continue;
        const key = file.replace(/\.json$/, "");
        try {
          const data = await readJsonStreamed(path.join(this.shardsDir, file));
          const posts = data.posts || {};
          let count = 0;
          let minTimestamp = Number.POSITIVE_INFINITY;
          let maxTimestamp = 0;
          for (const [pidStr, post] of Object.entries(posts)) {
            const pid = Number(pidStr);
            const ts = Number(post.timestamp || 0);
            this.pidIndex.set(pid, key);
            if (ts && ts < minTimestamp) minTimestamp = ts;
            if (ts > maxTimestamp) maxTimestamp = ts;
            count += 1;
          }
          this.shardMeta.set(key, {
            count,
            minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : null,
            maxTimestamp: maxTimestamp || null,
            updatedAt: new Date().toISOString(),
          });
        } catch (error) {
          console.warn(`[store] skip corrupt shard ${file}:`, error.message);
        }
      }
      this.indexDirty = true;
    }
  }

  // ---- shard management ----

  shardKeyFor(post) {
    return shardKeyForTimestamp(post?.timestamp);
  }

  async ensureShardLoaded(key) {
    const existing = this.shards.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    const shard = new Shard(key);
    const file = path.join(this.shardsDir, `${key}.json`);
    let fileExists = true;
    try {
      await fs.stat(file);
    } catch (error) {
      if (error.code === "ENOENT") {
        fileExists = false;
      } else {
        console.warn(`[store] stat shard ${key} failed:`, error.message);
        fileExists = false;
      }
    }
    if (fileExists) {
      try {
        const data = await readJsonStreamed(file);
        const posts = data.posts || {};
        for (const [pidStr, post] of Object.entries(posts)) {
          shard.posts.set(Number(pidStr), normalizeCachedPost(post));
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`[store] failed to load shard ${key}:`, error.message);
        }
      }
    }

    this.shards.set(key, shard);
    await this.evictIfNeeded();
    return shard;
  }

  async ensureSummaryLoaded(key) {
    const existing = this.summaryShards.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }

    if (this.summaryLoads.has(key)) return this.summaryLoads.get(key);

    const load = this.loadSummaryShard(key).finally(() => {
      this.summaryLoads.delete(key);
    });
    this.summaryLoads.set(key, load);
    return load;
  }

  async ensureTopLoaded(key) {
    const existing = this.topShards.get(key);
    if (existing) return existing;

    if (this.topLoads.has(key)) return this.topLoads.get(key);

    const load = this.loadTopShard(key).finally(() => {
      this.topLoads.delete(key);
    });
    this.topLoads.set(key, load);
    return load;
  }

  async loadTopShard(key) {
    const topFile = path.join(this.topsDir, `${key}.json`);
    const summaryFile = path.join(this.summariesDir, `${key}.json`);
    let topStat = null;
    let summaryStat = null;

    try {
      topStat = await fs.stat(topFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[store] stat top cache ${key} failed:`, error.message);
      }
    }
    try {
      summaryStat = await fs.stat(summaryFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[store] stat summary ${key} failed:`, error.message);
      }
    }

    if (topStat && (!summaryStat || topStat.mtimeMs >= summaryStat.mtimeMs)) {
      try {
        const top = await readTopCacheFile(topFile);
        if (top.limit >= this.topCacheLimit) {
          this.topShards.set(key, top);
          return top;
        }
      } catch (error) {
        console.warn(`[store] failed to load top cache ${key}:`, error.message);
      }
    }

    const summary = await this.ensureSummaryLoaded(key);
    const top = buildTopCache(summary, this.topCacheLimit);
    await this.flushTopCache(top);
    this.topShards.set(key, top);
    return top;
  }

  async warmShardCaches(key) {
    const summary = await this.ensureSummaryLoaded(key);
    this.mergeSummaryStats(summary);
    if (summary.dirty) await this.flushSummary(summary);
    const top = buildTopCache(summary, this.topCacheLimit);
    await this.flushTopCache(top);
    this.topShards.set(key, top);
    return { summaryCount: summary.posts.size, topLimit: top.limit };
  }

  async loadSummaryShard(key) {
    const summaryFile = path.join(this.summariesDir, `${key}.json`);
    const shardFile = path.join(this.shardsDir, `${key}.json`);
    let summaryStat = null;
    let shardStat = null;

    try {
      summaryStat = await fs.stat(summaryFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[store] stat summary ${key} failed:`, error.message);
      }
    }
    try {
      shardStat = await fs.stat(shardFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[store] stat shard ${key} failed:`, error.message);
      }
    }

    let posts = new Map();
    if (summaryStat && (!shardStat || summaryStat.mtimeMs >= shardStat.mtimeMs)) {
      try {
        posts = await readSummaryFile(summaryFile);
      } catch (error) {
        console.warn(`[store] failed to load summary ${key}:`, error.message);
      }
    }

    const summary = new SummaryShard(key, posts);
    if (!posts.size && shardStat) {
      try {
        summary.posts = await readSummariesFromShardFile(shardFile);
        summary.dirty = true;
      } catch (error) {
        if (error.code !== "ENOENT") {
          console.warn(`[store] failed to build summary ${key}:`, error.message);
        }
      }
    }

    this.summaryShards.set(key, summary);
    this.mergeSummaryStats(summary);
    await this.evictSummariesIfNeeded();
    if (summary.dirty) this.schedulePersist();
    return summary;
  }

  async evictIfNeeded() {
    if (this.shards.size <= this.maxLoadedShards) return;

    const currentKey = shardKeyForTimestamp(Math.floor(Date.now() / 1000));
    const previousKey = previousShardKey(currentKey);
    const targetSize = Math.max(this.maxLoadedShards, 3);
    const candidates = [...this.shards.values()]
      .filter((shard) => shard.key !== currentKey && shard.key !== previousKey)
      .sort((a, b) => a.lastAccessed - b.lastAccessed);

    while (this.shards.size > targetSize && candidates.length) {
      const shard = candidates.shift();
      if (shard.dirty) await this.flushShard(shard);
      this.shards.delete(shard.key);
    }
  }

  async evictSummariesIfNeeded() {
    if (this.summaryShards.size <= this.maxLoadedSummaryShards) return;

    const candidates = [...this.summaryShards.values()].sort(
      (a, b) => a.lastAccessed - b.lastAccessed,
    );

    while (this.summaryShards.size > this.maxLoadedSummaryShards && candidates.length) {
      const summary = candidates.shift();
      if (summary.dirty) await this.flushSummary(summary);
      this.summaryShards.delete(summary.key);
    }
  }

  shardMetaSnapshot(shard) {
    let minTimestamp = Number.POSITIVE_INFINITY;
    let maxTimestamp = 0;
    for (const post of shard.posts.values()) {
      const ts = Number(post.timestamp || 0);
      if (ts && ts < minTimestamp) minTimestamp = ts;
      if (ts > maxTimestamp) maxTimestamp = ts;
    }
    return {
      count: shard.posts.size,
      minTimestamp: Number.isFinite(minTimestamp) ? minTimestamp : null,
      maxTimestamp: maxTimestamp || null,
      updatedAt: new Date().toISOString(),
    };
  }

  mergeSummaryStats(summary) {
    let commentsCached = 0;
    let withComments = 0;
    let minTimestamp = Number.POSITIVE_INFINITY;
    let maxTimestamp = 0;

    for (const post of summary.posts.values()) {
      const ts = Number(post.timestamp || 0);
      if (ts && ts < minTimestamp) minTimestamp = ts;
      if (ts > maxTimestamp) maxTimestamp = ts;
      const count = Number(post.commentsCached || 0);
      commentsCached += count;
      if (count > 0) withComments += 1;
    }

    const previous = this.shardMeta.get(summary.key) || {};
    const next = {
      ...previous,
      count: previous.count || summary.posts.size,
      minTimestamp: previous.minTimestamp || (Number.isFinite(minTimestamp) ? minTimestamp : null),
      maxTimestamp: previous.maxTimestamp || maxTimestamp || null,
      commentsCached,
      withComments,
    };

    if (
      previous.commentsCached !== commentsCached ||
      previous.withComments !== withComments ||
      !previous.count
    ) {
      this.shardMeta.set(summary.key, next);
      this.indexDirty = true;
    }
  }

  // ---- persistence ----

  async flushShard(shard) {
    if (!shard.dirty) return;
    const file = path.join(this.shardsDir, `${shard.key}.json`);
    const payload = {
      version: STORE_VERSION,
      key: shard.key,
      posts: Object.fromEntries(shard.posts),
    };
    await atomicWriteJson(file, payload);
    shard.dirty = false;
    this.shardMeta.set(shard.key, this.shardMetaSnapshot(shard));
    this.indexDirty = true;

    let summary = this.summaryShards.get(shard.key);
    if (!summary) {
      summary = new SummaryShard(shard.key);
      this.summaryShards.set(shard.key, summary);
    }
    summary.posts = new Map(
      [...shard.posts.entries()].map(([pid, post]) => [pid, normalizeSummaryPost(post)]),
    );
    summary.dirty = true;
    await this.flushSummary(summary);
  }

  async flushSummary(summary) {
    if (!summary.dirty) return;
    const file = path.join(this.summariesDir, `${summary.key}.json`);
    const payload = {
      version: STORE_VERSION,
      key: summary.key,
      posts: Object.fromEntries(summary.posts),
    };
    await atomicWriteJson(file, payload);
    summary.dirty = false;
    this.mergeSummaryStats(summary);
    const top = buildTopCache(summary, this.topCacheLimit);
    await this.flushTopCache(top);
    this.topShards.set(summary.key, top);
  }

  async flushTopCache(top) {
    const file = path.join(this.topsDir, `${top.key}.json`);
    await atomicWriteJson(file, top);
  }

  async flushIndex() {
    if (!this.indexDirty) return;
    const pidIndexObject = {};
    for (const [pid, key] of this.pidIndex) pidIndexObject[pid] = key;
    const shardsObject = {};
    for (const [key, meta] of this.shardMeta) shardsObject[key] = meta;

    await atomicWriteJson(this.indexPath, {
      version: STORE_VERSION,
      status: this.status,
      shards: shardsObject,
      pidIndex: pidIndexObject,
    });
    this.indexDirty = false;
  }

  async flushStatus() {
    if (!this.statusDirty) return;
    await atomicWriteJson(this.statusPath, {
      version: STORE_VERSION,
      status: this.status,
    });
    this.statusDirty = false;
  }

  async flushAll() {
    for (const shard of this.shards.values()) {
      if (shard.dirty) await this.flushShard(shard);
    }
    for (const summary of this.summaryShards.values()) {
      if (summary.dirty) await this.flushSummary(summary);
    }
    await this.flushIndex();
    await this.flushStatus();
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistInFlight = this.flushAll()
        .catch((error) => {
          console.error("[store] persist failed:", error.message || error);
        })
        .finally(() => {
          this.persistInFlight = null;
        });
    }, this.persistDebounceMs);

    if (!this.persistIntervalTimer && this.persistIntervalMs > 0) {
      this.persistIntervalTimer = setInterval(() => {
        if (this.persistTimer || this.persistInFlight) return;
        this.persistInFlight = this.flushAll()
          .catch((error) => {
            console.error("[store] interval persist failed:", error.message || error);
          })
          .finally(() => {
            this.persistInFlight = null;
          });
      }, this.persistIntervalMs);
      this.persistIntervalTimer.unref?.();
    }
  }

  async shutdown() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.persistIntervalTimer) {
      clearInterval(this.persistIntervalTimer);
      this.persistIntervalTimer = null;
    }
    if (this.persistInFlight) await this.persistInFlight.catch(() => {});
    await this.flushAll();
  }

  // ---- public API ----

  async updateStatus(patch, { persist = true } = {}) {
    this.status = { ...this.status, ...patch };
    this.statusDirty = true;
    if (persist) this.schedulePersist();
  }

  hasPost(pid) {
    return this.pidIndex.has(Number(pid));
  }

  cacheDetailPost(post) {
    const pid = Number(post?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return post;
    if (this.detailCache.has(pid)) this.detailCache.delete(pid);
    this.detailCache.set(pid, post);
    while (this.detailCache.size > this.detailCacheLimit) {
      const oldestPid = this.detailCache.keys().next().value;
      this.detailCache.delete(oldestPid);
    }
    return post;
  }

  async getPost(pid) {
    const numericPid = Number(pid);
    const key = this.pidIndex.get(numericPid);
    if (!key) return null;
    const cached = this.detailCache.get(numericPid);
    if (cached) {
      this.detailCache.delete(numericPid);
      this.detailCache.set(numericPid, cached);
      return cached;
    }
    const loadedShard = this.shards.get(key);
    if (loadedShard) {
      loadedShard.lastAccessed = Date.now();
      const post = loadedShard.posts.get(numericPid) || null;
      if (post) this.cacheDetailPost(post);
      return post;
    }
    const file = path.join(this.shardsDir, `${key}.json`);
    try {
      const post = await readPostFromShardFile(file, numericPid);
      if (post) this.cacheDetailPost(post);
      return post;
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[store] failed to read post ${numericPid}:`, error.message);
      }
      return null;
    }
  }

  async upsertPosts(posts) {
    let newPosts = 0;
    let updatedPosts = 0;
    let commentsCached = 0;
    let indexChanged = false;

    const touched = new Set();
    for (const post of posts) {
      if (!post?.pid) continue;
      const pid = Number(post.pid);
      const key = this.shardKeyFor(post);
      const previousKey = this.pidIndex.get(pid);

      if (previousKey && previousKey !== key) {
        // Post moved across shards (rare — usually timestamp correction). Move it.
        const previousShard = await this.ensureShardLoaded(previousKey);
        previousShard.posts.delete(pid);
        previousShard.dirty = true;
        touched.add(previousShard);
        const previousSummary = this.summaryShards.get(previousKey);
        if (previousSummary) {
          previousSummary.posts.delete(pid);
          previousSummary.dirty = true;
        }
        indexChanged = true;
      }

      const shard = await this.ensureShardLoaded(key);
      const { isNew, post: mergedPost } = shard.upsert(post);
      this.pidIndex.set(pid, key);
      touched.add(shard);
      const summary = this.summaryShards.get(key);
      if (summary) summary.upsert(mergedPost);

      if (isNew) newPosts += 1;
      else updatedPosts += 1;
      if (post.comments?.length) commentsCached += post.comments.length;
      if (isNew || !previousKey) indexChanged = true;
    }

    for (const shard of touched) {
      const previousMeta = this.shardMeta.get(shard.key) || {};
      this.shardMeta.set(shard.key, {
        ...this.shardMetaSnapshot(shard),
        commentsCached: previousMeta.commentsCached,
        withComments: previousMeta.withComments,
      });
    }
    if (indexChanged) this.indexDirty = true;
    this.schedulePersist();

    return {
      totalCached: this.pidIndex.size,
      upserted: posts.length,
      newPosts,
      updatedPosts,
      commentsCached,
    };
  }

  async listMonths() {
    const keys = [...this.shardMeta.keys()]
      .filter((key) => /^\d{4}-\d{2}$/.test(key))
      .sort(compareShardKeys);
    return keys.map((key) => ({
      key,
      count: this.shardMeta.get(key)?.count || 0,
      minTimestamp: this.shardMeta.get(key)?.minTimestamp || null,
      maxTimestamp: this.shardMeta.get(key)?.maxTimestamp || null,
    }));
  }

  shardKeysOverlappingMetaRange(fromSeconds = 0, toSeconds = Number.POSITIVE_INFINITY) {
    const from = Number(fromSeconds) > 0 ? Number(fromSeconds) : 0;
    const to = Number.isFinite(Number(toSeconds)) ? Number(toSeconds) : Number.POSITIVE_INFINITY;
    return [...this.shardMeta.entries()]
      .filter(([key, meta]) => {
        if (!/^\d{4}-\d{2}$/.test(key)) return false;
        const min = Number(meta.minTimestamp || 0);
        const max = Number(meta.maxTimestamp || 0);
        if (!max) return true;
        return max >= from && (!min || min <= to);
      })
      .map(([key]) => key)
      .sort(compareShardKeys);
  }

  async missingFromPresent(presentPids, { fromTimestamp = 0, toTimestamp = Number.POSITIVE_INFINITY } = {}) {
    const keys = this.shardKeysOverlappingMetaRange(fromTimestamp, toTimestamp);
    const missing = [];
    let compared = 0;

    for (const key of keys) {
      const source = await this.ensureSummaryLoaded(key);
      for (const post of source.posts.values()) {
        const ts = Number(post.timestamp || 0);
        if (ts < fromTimestamp || ts > toTimestamp) continue;
        compared += 1;
        if (!presentPids.has(Number(post.pid))) missing.push(post);
      }
    }

    return { missing, compared, monthsCompared: keys.length };
  }

  async summariesForRecords(
    records,
    { limit = 100, offset = 0, query = "", sort = "detected" } = {},
  ) {
    const cappedLimit = clampLimit(limit);
    const cappedOffset = clampOffset(offset);
    const normalizedQuery = query.trim().toLowerCase();
    const recordsByPid = new Map(
      records
        .map((record) => [Number(record.pid), record])
        .filter(([pid]) => Number.isFinite(pid) && pid > 0),
    );
    const pidsByKey = new Map();
    for (const pid of recordsByPid.keys()) {
      const key = this.pidIndex.get(pid);
      if (!key) continue;
      if (!pidsByKey.has(key)) pidsByKey.set(key, []);
      pidsByKey.get(key).push(pid);
    }

    const list = [];
    for (const [key, pids] of pidsByKey) {
      const source = await this.ensureSummaryLoaded(key);
      for (const pid of pids) {
        const post = source.posts.get(pid);
        if (!post) continue;
        if (!matchesQuery(post, normalizedQuery)) continue;
        const record = recordsByPid.get(pid) || {};
        list.push({
          ...post,
          deletedFirstDetectedAt: record.firstDetectedAt || null,
          deletedLastDetectedAt: record.lastDetectedAt || null,
          deletedMissingRuns: Number(record.missingRuns || 0),
        });
      }
    }

    const compare =
      sort === "reply" || sort === "follow"
        ? rankedCompare(sort)
        : sort === "time"
          ? realtimeCompare
          : (a, b) => {
              const detectedDelta =
                Date.parse(b.deletedLastDetectedAt || "") -
                Date.parse(a.deletedLastDetectedAt || "");
              if (detectedDelta) return detectedDelta;
              return realtimeCompare(a, b);
            };

    return slicePage(list.sort(compare), cappedOffset, cappedLimit).map(summarizePost);
  }

  async hotList({
    window = "day",
    sort = "reply",
    limit = 100,
    query = "",
    includeComments = false,
  } = {}) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cutoff = nowSeconds - windowSeconds(window);
    const normalizedQuery = query.trim().toLowerCase();

    const relevantKeys = this.shardKeysOverlappingRange(cutoff, nowSeconds);
    const cappedLimit = clampLimit(limit);
    const compare = rankedCompare(sort);
    const collected = [];
    for (const key of relevantKeys) {
      const source = includeComments
        ? await this.ensureShardLoaded(key)
        : await this.ensureSummaryLoaded(key);
      for (const post of source.posts.values()) {
        if ((post.timestamp || 0) < cutoff) continue;
        if (!matchesQuery(post, normalizedQuery)) continue;
        pushTop(collected, post, compare, cappedLimit);
      }
    }

    const list = collected
      .sort(compare)
      .slice(0, cappedLimit);

    return includeComments ? list : list.map(summarizePost);
  }

  async realtimeList({ limit = 100, offset = 0, query = "", includeComments = false } = {}) {
    const normalizedQuery = query.trim().toLowerCase();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const horizon = nowSeconds - 14 * DAY_SECONDS;
    const relevantKeys = this.shardKeysOverlappingRange(horizon, nowSeconds);

    const cappedLimit = clampLimit(limit);
    const cappedOffset = clampOffset(offset);
    const collectionLimit = cappedOffset + cappedLimit;
    const collected = [];
    for (const key of relevantKeys) {
      const source = includeComments
        ? await this.ensureShardLoaded(key)
        : await this.ensureSummaryLoaded(key);
      for (const post of source.posts.values()) {
        if (!matchesQuery(post, normalizedQuery)) continue;
        pushTop(collected, post, realtimeCompare, collectionLimit);
      }
    }

    const list = collected
      .sort(realtimeCompare)
      .slice(cappedOffset, cappedOffset + cappedLimit);

    return includeComments ? list : list.map(summarizePost);
  }

  async archiveList({
    month,
    sort = "reply",
    limit = 100,
    offset = 0,
    query = "",
    includeComments = false,
  } = {}) {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return [];
    }
    const normalizedQuery = query.trim().toLowerCase();
    const cappedLimit = clampLimit(limit);
    const cappedOffset = clampOffset(offset);
    const collectionLimit = cappedOffset + cappedLimit;
    const compare = rankedCompare(sort);

    if (!includeComments && !normalizedQuery) {
      const top = await this.ensureTopLoaded(month);
      const source = sort === "follow" ? top.follow : top.reply;
      if (collectionLimit <= source.length) {
        return source.slice(cappedOffset, cappedOffset + cappedLimit);
      }
    }

    const source = includeComments
      ? await this.ensureShardLoaded(month)
      : await this.ensureSummaryLoaded(month);
    const collected = [];
    for (const post of source.posts.values()) {
      if (!matchesQuery(post, normalizedQuery)) continue;
      pushTop(collected, post, compare, collectionLimit);
    }
    const list = collected.sort(compare).slice(cappedOffset, cappedOffset + cappedLimit);

    return includeComments ? list : list.map(summarizePost);
  }

  async rangeList({
    startTimestamp,
    endTimestamp,
    sort = "reply",
    limit = 100,
    offset = 0,
    query = "",
    includeComments = false,
  } = {}) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const start = Number(startTimestamp) > 0 ? Math.floor(Number(startTimestamp)) : 0;
    const end =
      Number(endTimestamp) > 0 ? Math.floor(Number(endTimestamp)) : nowSeconds;
    if (start > end) return [];

    const normalizedQuery = query.trim().toLowerCase();
    const keys = this.shardKeysOverlappingRange(start || 1, end);

    const cappedLimit = clampLimit(limit);
    const cappedOffset = clampOffset(offset);
    const collectionLimit = cappedOffset + cappedLimit;
    const compare = rankedCompare(sort);
    const collected = [];

    if (!includeComments && !normalizedQuery && keys.length > 2) {
      for (const key of keys) {
        const top = await this.ensureTopLoaded(key);
        const source = sort === "follow" ? top.follow : top.reply;
        for (const post of source) {
          const ts = Number(post.timestamp || 0);
          if (ts < start || ts > end) continue;
          pushTop(collected, post, compare, collectionLimit);
        }
      }
      return collected.sort(compare).slice(cappedOffset, cappedOffset + cappedLimit);
    }

    for (const key of keys) {
      const source = includeComments
        ? await this.ensureShardLoaded(key)
        : await this.ensureSummaryLoaded(key);
      for (const post of source.posts.values()) {
        const ts = Number(post.timestamp || 0);
        if (ts < start || ts > end) continue;
        if (!matchesQuery(post, normalizedQuery)) continue;
        pushTop(collected, post, compare, collectionLimit);
      }
    }

    const list = collected
      .sort(compare)
      .slice(cappedOffset, cappedOffset + cappedLimit);

    return includeComments ? list : list.map(summarizePost);
  }

  shardKeysOverlappingRange(fromSeconds, toSeconds) {
    const desired = new Set();
    desired.add(shardKeyForTimestamp(toSeconds));
    desired.add(shardKeyForTimestamp(fromSeconds));
    // Walk months between fromSeconds and toSeconds to cover boundary cases.
    let cursor = new Date(fromSeconds * 1000);
    cursor.setUTCDate(1);
    const end = new Date(toSeconds * 1000);
    while (cursor.getTime() / 1000 <= toSeconds) {
      const year = cursor.getUTCFullYear();
      const month = String(cursor.getUTCMonth() + 1).padStart(2, "0");
      desired.add(`${year}-${month}`);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      if (cursor.getTime() > end.getTime() + 2 * DAY_SECONDS * 1000) break;
    }
    return [...desired].filter((key) => this.shardMeta.has(key) || this.shards.has(key));
  }

  stats() {
    const now = Math.floor(Date.now() / 1000);
    let cached = 0;
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    let newestTimestamp = 0;
    let yearCount = 0;

    for (const meta of this.shardMeta.values()) {
      cached += meta.count || 0;
      if (meta.minTimestamp && meta.minTimestamp < oldestTimestamp) {
        oldestTimestamp = meta.minTimestamp;
      }
      if (meta.maxTimestamp && meta.maxTimestamp > newestTimestamp) {
        newestTimestamp = meta.maxTimestamp;
      }
      if (meta.maxTimestamp && meta.maxTimestamp >= now - 365 * DAY_SECONDS) {
        yearCount += meta.count || 0;
      }
    }

    let hourCount = 0;
    let dayCount = 0;
    let weekCount = 0;
    let commentsCached = 0;
    let withComments = 0;

    for (const meta of this.shardMeta.values()) {
      commentsCached += Number(meta.commentsCached || 0);
      withComments += Number(meta.withComments || 0);
    }

    // Stats for recent windows iterate only the shards that overlap; bounded work.
    const currentKey = shardKeyForTimestamp(now);
    const previousKey = previousShardKey(currentKey);
    for (const key of [previousKey, currentKey]) {
      if (!key) continue;
      const shard = this.shards.get(key);
      if (!shard) continue;
      for (const post of shard.posts.values()) {
        const ts = post.timestamp || 0;
        if (ts >= now - HOUR_SECONDS) hourCount += 1;
        if (ts >= now - DAY_SECONDS) dayCount += 1;
        if (ts >= now - 7 * DAY_SECONDS) weekCount += 1;
      }
    }

    return {
      cached,
      commentsCached,
      withComments,
      hour: hourCount,
      day: dayCount,
      week: weekCount,
      year: yearCount,
      shards: this.shardMeta.size,
      loadedShards: this.shards.size,
      newestTimestamp: newestTimestamp || null,
      oldestTimestamp: Number.isFinite(oldestTimestamp) ? oldestTimestamp : null,
    };
  }
}
