import { promises as fs } from "node:fs";
import path from "node:path";
import { clearTreeholeAuthCache, resolveTreeholeAuth } from "./auth.js";
import { fetchImageBuffer, imageSourcesForPost } from "./treeholeClient.js";
import { shardKeyForTimestamp } from "./store.js";

const STORE_VERSION = 1;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_MIN_FREE_GB = 5;
const DEFAULT_MAX_QUEUE = 50000;
const DEFAULT_MAX_LOADED_MANIFESTS = 6;
const DEFAULT_PERSIST_DEBOUNCE_MS = 4000;
const DEFAULT_PERSIST_INTERVAL_MS = 30000;
const DEFAULT_DISK_PAUSE_MS = 5 * 60 * 1000;
const DEFAULT_AUTH_COOLDOWN_MS = 60 * 1000;

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

function isAuthError(message) {
  return /HTTP 401|HTTP 403|code=401|code=403|登录态|未登录|token/i.test(String(message || ""));
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
    archivedPosts: 0,
    archivedImages: 0,
    archivedBytes: 0,
    failedPosts: 0,
    skippedQueueFull: 0,
    lastArchivedAt: null,
    lastError: null,
    paused: false,
    pausedReason: null,
  };
}

class Manifest {
  constructor(key, posts = new Map()) {
    this.key = key;
    this.posts = posts; // pid -> { pid, timestamp, images, expected, fetchedAt, errors }
    this.dirty = false;
    this.lastAccessed = Date.now();
  }
}

/**
 * 后台图片归档器：把树洞图片帖里的图片下载并永久保存到本地，
 * 以便和帖子/留言一样长期可看（源站删图也不丢）。
 *
 * 元数据走独立的按月 sidecar（data/media/<YYYY-MM>.json），不触碰
 * 已验证的帖子分片热路径；图片文件存 data/media/files/<YYYY-MM>/<pid>-<idx>.<ext>。
 */
export class MediaArchiver {
  constructor(dataDir, options = {}) {
    this.mediaDir = options.mediaDir || path.join(dataDir, "media");
    this.filesDir = path.join(this.mediaDir, "files");
    this.statusPath = path.join(this.mediaDir, "status.json");

    this.enabled = options.enabled ?? envFlag("TREEHOLE_IMAGE_ARCHIVE_ENABLED", true);
    this.base = options.base || process.env.TREEHOLE_IMAGE_BASE || undefined;
    this.concurrency = Math.max(
      1,
      Math.min(options.concurrency || envNumber("TREEHOLE_IMAGE_CONCURRENCY", DEFAULT_CONCURRENCY), 8),
    );
    this.delayMs = options.delayMs ?? envNumber("TREEHOLE_IMAGE_DELAY_MS", DEFAULT_DELAY_MS);
    this.maxBytes = options.maxBytes || envNumber("TREEHOLE_IMAGE_MAX_BYTES", DEFAULT_MAX_BYTES);
    this.minFreeBytes =
      (options.minFreeGb || envNumber("TREEHOLE_IMAGE_MIN_FREE_GB", DEFAULT_MIN_FREE_GB)) *
      1024 *
      1024 *
      1024;
    this.maxQueue = options.maxQueue || envNumber("TREEHOLE_IMAGE_MAX_QUEUE", DEFAULT_MAX_QUEUE);
    this.maxLoadedManifests =
      options.maxLoadedManifests || envNumber("TREEHOLE_IMAGE_MAX_MANIFESTS", DEFAULT_MAX_LOADED_MANIFESTS);
    this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
    this.persistIntervalMs = options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
    this.diskPauseMs = options.diskPauseMs || DEFAULT_DISK_PAUSE_MS;
    this.authCooldownMs = options.authCooldownMs || DEFAULT_AUTH_COOLDOWN_MS;

    this.status = defaultStatus();
    this.status.enabled = this.enabled;
    this.queue = new Map(); // pid -> { pid, timestamp, imageSources }
    this.manifests = new Map(); // key -> Manifest
    this.manifestLoads = new Map(); // key -> Promise<Manifest>
    this.activeWorkers = 0;
    this.paused = false;
    this.stopped = false;
    this.diskPauseTimer = null;
    this.persistTimer = null;
    this.persistIntervalTimer = null;
    this.persistInFlight = null;
  }

  async load() {
    await fs.mkdir(this.mediaDir, { recursive: true });
    await fs.mkdir(this.filesDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.statusPath, "utf8");
      const data = JSON.parse(raw);
      this.status = { ...defaultStatus(), ...(data.status || {}) };
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn("[media] failed to load status:", error.message);
      }
    }
    this.status.running = false;
    this.status.enabled = this.enabled;
    this.status.paused = false;
    this.status.pausedReason = null;
  }

  start() {
    this.stopped = false;
    if (this.enabled) this.pump();
  }

  manifestPathFor(key) {
    return path.join(this.mediaDir, `${key}.json`);
  }

  async ensureManifest(key) {
    const existing = this.manifests.get(key);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing;
    }
    if (this.manifestLoads.has(key)) return this.manifestLoads.get(key);

    const load = this.loadManifest(key).finally(() => this.manifestLoads.delete(key));
    this.manifestLoads.set(key, load);
    return load;
  }

  async loadManifest(key) {
    const file = this.manifestPathFor(key);
    const posts = new Map();
    try {
      const raw = await fs.readFile(file, "utf8");
      const data = JSON.parse(raw);
      const entries = data.posts || {};
      for (const [pid, entry] of Object.entries(entries)) {
        posts.set(Number(pid), entry);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`[media] failed to load manifest ${key}:`, error.message);
      }
    }
    const manifest = new Manifest(key, posts);
    this.manifests.set(key, manifest);
    await this.evictManifestsIfNeeded();
    return manifest;
  }

  async evictManifestsIfNeeded() {
    if (this.manifests.size <= this.maxLoadedManifests) return;
    const candidates = [...this.manifests.values()].sort((a, b) => a.lastAccessed - b.lastAccessed);
    while (this.manifests.size > this.maxLoadedManifests && candidates.length) {
      const manifest = candidates.shift();
      if (manifest.dirty) await this.flushManifest(manifest);
      this.manifests.delete(manifest.key);
    }
  }

  async flushManifest(manifest) {
    if (!manifest.dirty) return;
    await atomicWriteJson(this.manifestPathFor(manifest.key), {
      version: STORE_VERSION,
      key: manifest.key,
      posts: Object.fromEntries(manifest.posts),
    });
    manifest.dirty = false;
  }

  async flushStatus() {
    await atomicWriteJson(this.statusPath, {
      version: STORE_VERSION,
      status: this.status,
    });
  }

  async flushAll() {
    for (const manifest of this.manifests.values()) {
      if (manifest.dirty) await this.flushManifest(manifest);
    }
    await this.flushStatus();
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistInFlight = this.flushAll()
        .catch((error) => console.error("[media] persist failed:", error.message || error))
        .finally(() => {
          this.persistInFlight = null;
        });
    }, this.persistDebounceMs);
    this.persistTimer.unref?.();

    if (!this.persistIntervalTimer && this.persistIntervalMs > 0) {
      this.persistIntervalTimer = setInterval(() => {
        if (this.persistTimer || this.persistInFlight) return;
        this.persistInFlight = this.flushAll()
          .catch((error) => console.error("[media] interval persist failed:", error.message || error))
          .finally(() => {
            this.persistInFlight = null;
          });
      }, this.persistIntervalMs);
      this.persistIntervalTimer.unref?.();
    }
  }

  // crawler upsert 后调用：把图片帖排入下载队列（跳过已归档者）。
  async enqueueImagePosts(posts, { force = false } = {}) {
    if (!this.enabled || !Array.isArray(posts) || !posts.length) return 0;
    let added = 0;
    for (const post of posts) {
      const pid = Number(post?.pid);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      const sources =
        Array.isArray(post.imageSources) && post.imageSources.length
          ? post.imageSources
          : imageSourcesForPost(post);
      if (!sources.length) continue;
      if (this.queue.has(pid)) continue;
      if (this.queue.size >= this.maxQueue) {
        this.status.skippedQueueFull += 1;
        continue;
      }

      const key = shardKeyForTimestamp(post.timestamp);
      const manifest = await this.ensureManifest(key);
      const entry = manifest.posts.get(pid);
      if (entry && !force) continue;
      if (entry && force && Array.isArray(entry.images) && entry.images.length >= sources.length) {
        continue;
      }

      this.queue.set(pid, { pid, timestamp: Number(post.timestamp || 0), imageSources: sources });
      added += 1;
    }
    if (added) {
      this.status.queued = this.queue.size;
      this.pump();
    }
    return added;
  }

  pump() {
    if (!this.enabled || this.paused || this.stopped) return;
    while (this.activeWorkers < this.concurrency && this.queue.size > 0) {
      this.activeWorkers += 1;
      this.status.running = true;
      this.worker().finally(() => {
        this.activeWorkers -= 1;
        if (this.activeWorkers === 0) {
          this.status.running = false;
          this.schedulePersist();
        }
      });
    }
  }

  takeNext() {
    const iterator = this.queue.entries().next();
    if (iterator.done) return null;
    const [pid, job] = iterator.value;
    this.queue.delete(pid);
    this.status.queued = this.queue.size;
    return job;
  }

  async worker() {
    while (!this.stopped && this.enabled && !this.paused) {
      if (!(await this.ensureDiskSpace())) return;
      const job = this.takeNext();
      if (!job) return;
      try {
        await this.processPost(job);
      } catch (error) {
        const message = errorMessage(error);
        this.status.lastError = message;
        if (isAuthError(message)) {
          // 登录态失效：清缓存、回填队列、冷却后再试，避免空转打接口。
          clearTreeholeAuthCache();
          this.queue.set(job.pid, job);
          this.status.queued = this.queue.size;
          this.pauseFor(this.authCooldownMs, "登录态失效，等待重试");
          return;
        }
      }
      if (this.delayMs) await wait(this.delayMs);
    }
  }

  async processPost(job) {
    const auth = await resolveTreeholeAuth();
    const key = shardKeyForTimestamp(job.timestamp);
    const monthFilesDir = path.join(this.filesDir, key);
    await fs.mkdir(monthFilesDir, { recursive: true });

    const images = [];
    const errors = [];
    let bytes = 0;
    for (const source of job.imageSources) {
      try {
        const result = await fetchImageBuffer(auth, source, {
          base: this.base,
          maxBytes: this.maxBytes,
        });
        const file = `${job.pid}-${source.index}.${result.ext}`;
        await fs.writeFile(path.join(monthFilesDir, file), result.buffer);
        images.push({
          key: source.key,
          index: source.index,
          file,
          ext: result.ext,
          bytes: result.bytes,
          by: source.by,
          ref: source.ref,
        });
        bytes += result.bytes;
      } catch (error) {
        const message = errorMessage(error);
        if (isAuthError(message)) throw error; // 交给 worker 统一处理冷却
        errors.push({ index: source.index, error: message });
      }
      if (this.delayMs && job.imageSources.length > 1) await wait(this.delayMs);
    }

    const manifest = await this.ensureManifest(key);
    manifest.posts.set(job.pid, {
      pid: job.pid,
      timestamp: job.timestamp,
      images,
      expected: job.imageSources.length,
      fetchedAt: new Date().toISOString(),
      errors: errors.length ? errors : undefined,
    });
    manifest.dirty = true;
    manifest.lastAccessed = Date.now();

    if (images.length) {
      this.status.archivedPosts += 1;
      this.status.archivedImages += images.length;
      this.status.archivedBytes += bytes;
      this.status.lastArchivedAt = new Date().toISOString();
    } else {
      this.status.failedPosts += 1;
    }
    this.schedulePersist();
  }

  async ensureDiskSpace() {
    try {
      const stat = await fs.statfs(this.mediaDir);
      const freeBytes = Number(stat.bsize) * Number(stat.bavail);
      if (Number.isFinite(freeBytes) && freeBytes < this.minFreeBytes) {
        this.pauseFor(
          this.diskPauseMs,
          `磁盘可用空间不足（< ${Math.round(this.minFreeBytes / 1024 / 1024 / 1024)} GB）`,
        );
        return false;
      }
    } catch {
      // statfs 不可用时不阻塞下载。
    }
    return true;
  }

  pauseFor(ms, reason) {
    this.paused = true;
    this.status.paused = true;
    this.status.pausedReason = reason;
    this.status.running = false;
    if (this.diskPauseTimer) clearTimeout(this.diskPauseTimer);
    this.diskPauseTimer = setTimeout(() => {
      this.diskPauseTimer = null;
      this.paused = false;
      this.status.paused = false;
      this.status.pausedReason = null;
      this.pump();
    }, ms);
    this.diskPauseTimer.unref?.();
    this.schedulePersist();
  }

  // 详情接口用：返回某帖已归档图片的对外描述（本地 /media URL）。
  async getImages(post) {
    if (!this.enabled || !post) return [];
    const pid = Number(post.pid);
    if (!Number.isFinite(pid) || pid <= 0) return [];
    const key = shardKeyForTimestamp(post.timestamp);
    let manifest;
    try {
      manifest = await this.ensureManifest(key);
    } catch {
      return [];
    }
    const entry = manifest.posts.get(pid);
    if (!entry || !Array.isArray(entry.images)) return [];
    return entry.images
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((image) => ({
        src: `/media/${key}/${image.file}`,
        bytes: image.bytes || 0,
        ext: image.ext || "jpeg",
      }));
  }

  publicStatus() {
    return {
      ...this.status,
      enabled: this.enabled,
      concurrency: this.concurrency,
      queued: this.queue.size,
      paused: this.paused,
    };
  }

  async shutdown() {
    this.stopped = true;
    if (this.diskPauseTimer) clearTimeout(this.diskPauseTimer);
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
}
