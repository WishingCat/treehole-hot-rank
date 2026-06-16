import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import streamJson from "stream-json";
import streamJsonPick from "stream-json/filters/Pick.js";
import streamJsonStreamObject from "stream-json/streamers/StreamObject.js";

import { shardKeyForTimestamp } from "./store.js";

const { parser } = streamJson;
const { pick } = streamJsonPick;
const { streamObject } = streamJsonStreamObject;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const shardsDir = path.join(dataDir, "shards");
const indexPath = path.join(dataDir, "index.json");

const SHARD_FLUSH_THRESHOLD = Number(process.env.MIGRATE_SHARD_FLUSH || 25000);

function parseArgs(argv) {
  const args = { sources: [], dryRun: false };
  for (const value of argv) {
    if (value === "--dry-run") args.dryRun = true;
    else if (value.startsWith("--source=")) args.sources.push(value.slice(9));
    else if (!value.startsWith("--")) args.sources.push(value);
  }
  return args;
}

async function findLegacyFiles(explicit) {
  if (explicit.length) return explicit.map((p) => path.resolve(rootDir, p));
  const entries = await fs.readdir(dataDir).catch(() => []);
  const candidates = entries
    .filter(
      (name) =>
        name === "hot-cache.json" ||
        /^hot-cache\.broken\.\d+\.json$/.test(name),
    )
    .map((name) => path.join(dataDir, name));
  const sized = await Promise.all(
    candidates.map(async (file) => ({ file, size: (await fs.stat(file)).size })),
  );
  sized.sort((a, b) => b.size - a.size);
  return sized.map((entry) => entry.file);
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
  const map = new Map();
  for (const c of existing) map.set(commentKey(c), c);
  for (const c of incoming) {
    const k = commentKey(c);
    map.set(k, { ...(map.get(k) || {}), ...c });
  }
  return [...map.values()].sort(
    (a, b) => (a.floor || 0) - (b.floor || 0) || (a.timestamp || 0) - (b.timestamp || 0),
  );
}

function mergePost(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "comments") continue;
    merged[key] = mergeValue(existing[key], value);
  }
  if (incoming.comments?.length || existing.comments?.length) {
    merged.comments = mergeComments(existing.comments || [], incoming.comments || []);
  }
  return merged;
}

async function readShardFile(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const data = JSON.parse(raw);
    return new Map(
      Object.entries(data.posts || {}).map(([pid, post]) => [Number(pid), post]),
    );
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[migrate] could not read existing shard ${file}:`, error.message);
    }
    return new Map();
  }
}

async function writeShardFile(file, posts) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({
      version: 2,
      key: path.basename(file, ".json"),
      posts: Object.fromEntries(posts),
    }),
  );
  await fs.rename(tmp, file);
}

class StreamingBuckets {
  constructor({ dryRun }) {
    this.dryRun = dryRun;
    this.buckets = new Map(); // key -> Map(pid -> post) (in-memory pending)
    this.shardCounts = new Map(); // key -> on-disk size estimate
    this.touched = new Set();
    this.pidShardMap = new Map(); // pid -> key (final shard assignment)
    this.totalPosts = 0;
    this.skipped = 0;
  }

  ensureBucket(key) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  async add(post) {
    if (!post?.pid) {
      this.skipped += 1;
      return;
    }
    const key = shardKeyForTimestamp(post.timestamp);
    if (key === "unknown") {
      this.skipped += 1;
      return;
    }
    const bucket = this.ensureBucket(key);
    bucket.set(Number(post.pid), post);
    this.pidShardMap.set(Number(post.pid), key);
    this.touched.add(key);
    this.totalPosts += 1;

    if (bucket.size >= SHARD_FLUSH_THRESHOLD) {
      await this.flushBucket(key);
    }
  }

  async flushBucket(key) {
    const pending = this.buckets.get(key);
    if (!pending || pending.size === 0) return;
    const file = path.join(shardsDir, `${key}.json`);
    if (this.dryRun) {
      console.log(`[migrate] dry-run flush ${key} (+${pending.size})`);
      this.buckets.set(key, new Map());
      return;
    }
    const onDisk = await readShardFile(file);
    for (const [pid, post] of pending) {
      onDisk.set(pid, mergePost(onDisk.get(pid), post));
    }
    await writeShardFile(file, onDisk);
    this.shardCounts.set(key, onDisk.size);
    this.buckets.set(key, new Map());
    console.log(`[migrate]   flushed ${key} (${onDisk.size} total)`);
  }

  async flushAll() {
    for (const key of [...this.buckets.keys()]) {
      await this.flushBucket(key);
    }
  }
}

async function streamFile(file, buckets) {
  console.log(`[migrate] streaming ${file}`);
  let count = 0;
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file)
      .pipe(parser())
      .pipe(pick({ filter: "posts" }))
      .pipe(streamObject());

    stream.on("data", async ({ value }) => {
      stream.pause();
      try {
        await buckets.add(value);
        count += 1;
        if (count % 20000 === 0) {
          console.log(`[migrate]   processed ${count} posts`);
        }
      } catch (error) {
        stream.destroy(error);
        return;
      }
      stream.resume();
    });
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  console.log(`[migrate] ${file} -> ${count} posts streamed`);
}

async function buildIndex(buckets) {
  const pidIndex = {};
  for (const [pid, key] of buckets.pidShardMap) pidIndex[pid] = key;

  const shardsSummary = {};
  for (const key of buckets.touched) {
    const file = path.join(shardsDir, `${key}.json`);
    try {
      const posts = await readShardFile(file);
      let minTs = Number.POSITIVE_INFINITY;
      let maxTs = 0;
      for (const [, post] of posts) {
        const ts = Number(post.timestamp || 0);
        if (ts && ts < minTs) minTs = ts;
        if (ts > maxTs) maxTs = ts;
      }
      shardsSummary[key] = {
        count: posts.size,
        minTimestamp: Number.isFinite(minTs) ? minTs : null,
        maxTimestamp: maxTs || null,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.warn(`[migrate] summary skip ${key}:`, error.message);
    }
  }

  return { version: 2, shards: shardsSummary, pidIndex };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = await findLegacyFiles(args.sources);
  if (!sources.length) {
    console.log("[migrate] no legacy hot-cache files found, nothing to do.");
    return;
  }

  await fs.mkdir(shardsDir, { recursive: true });
  const buckets = new StreamingBuckets({ dryRun: args.dryRun });

  for (const file of sources) {
    await streamFile(file, buckets);
  }
  await buckets.flushAll();

  const indexPayload = await buildIndex(buckets);

  // Preserve existing status from a current index.json if present.
  try {
    const existing = JSON.parse(await fs.readFile(indexPath, "utf8"));
    if (existing?.status) indexPayload.status = existing.status;
  } catch {
    /* no existing index */
  }

  if (args.dryRun) {
    console.log(`[migrate] dry-run skip write ${indexPath}`);
  } else {
    const tmp = `${indexPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(indexPayload));
    await fs.rename(tmp, indexPath);
    console.log(`[migrate] wrote ${indexPath}`);
  }

  console.log(
    `[migrate] done · pids=${Object.keys(indexPayload.pidIndex).length} · shards=${Object.keys(indexPayload.shards).length} · skipped=${buckets.skipped}`,
  );
}

main().catch((error) => {
  console.error("[migrate] fatal:", error.stack || error.message || error);
  process.exitCode = 1;
});
