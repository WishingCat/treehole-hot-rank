import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";
import { MediaArchiver } from "./mediaArchiver.js";
import { imageSourcesForPost } from "./treeholeClient.js";

// 运维脚本：对本地缓存里的图片帖做 best-effort 图片回填。
// 逐月把图片帖排入归档队列并下载（仍存在的帖可下到，已删的下不到属正常）。
//
// 环境变量：
//   TREEHOLE_TOKEN / TREEHOLE_UUID         登录态（必需）
//   TREEHOLE_MEDIA_SCAN_MONTHS=N           仅处理最近 N 个月（默认全部）
//   TREEHOLE_MEDIA_SCAN_ONLY=2026-06,...   仅处理指定月份（覆盖上面的 N）
//   TREEHOLE_MEDIA_SCAN_FORCE=1            对未抓全的帖重试（已抓全者仍跳过）
//   TREEHOLE_IMAGE_* 同 server 的图片归档配置（并发/间隔/上限等）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const store = new HotStore(dataDir, {
  maxLoadedShards: Number(process.env.TREEHOLE_MAX_LOADED_SHARDS) || undefined,
  maxLoadedSummaryShards:
    Number(process.env.TREEHOLE_MAX_LOADED_SUMMARY_SHARDS) || undefined,
  topCacheLimit: Number(process.env.TREEHOLE_TOP_CACHE_LIMIT) || undefined,
});
await store.load();

const archiver = new MediaArchiver(dataDir, { enabled: true });
await archiver.load();
archiver.start();

const force = !["0", "false", "no", "off", undefined, ""].includes(
  process.env.TREEHOLE_MEDIA_SCAN_FORCE,
);

const allMonths = (await store.listMonths()).map((m) => m.key).sort().reverse();
const only = (process.env.TREEHOLE_MEDIA_SCAN_ONLY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const monthLimit = Number(process.env.TREEHOLE_MEDIA_SCAN_MONTHS) || 0;
let months = only.length ? allMonths.filter((m) => only.includes(m)) : allMonths;
if (!only.length && monthLimit > 0) months = months.slice(0, monthLimit);

console.log(`[media-scan] months to scan: ${months.join(", ") || "(none)"} · force=${force}`);

let grandImagePosts = 0;
let grandEnqueued = 0;

for (const month of months) {
  const summary = await store.ensureSummaryLoaded(month);
  const imagePosts = [];
  for (const post of summary.posts.values()) {
    const sources = imageSourcesForPost(post);
    if (sources.length) imagePosts.push({ ...post, imageSources: sources });
  }
  grandImagePosts += imagePosts.length;
  const enqueued = await archiver.enqueueImagePosts(imagePosts, { force });
  grandEnqueued += enqueued;
  console.log(
    `[media-scan] ${month}: ${imagePosts.length} image posts, ${enqueued} queued for download`,
  );

  // 逐月排空队列，避免一次性堆积过大；遇到暂停（磁盘/登录态）则中止。
  let lastLog = Date.now();
  while (archiver.queue.size > 0 || archiver.activeWorkers > 0) {
    archiver.pump();
    if (archiver.paused) {
      console.warn(`[media-scan] paused: ${archiver.status.pausedReason || "未知原因"}，中止。`);
      await store.shutdown();
      await archiver.shutdown();
      console.log(JSON.stringify(archiver.publicStatus(), null, 2));
      process.exit(1);
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      const s = archiver.status;
      console.log(
        `[media-scan]   …${month} 进度：已存图 ${s.archivedImages} 张 / ${Math.round(
          s.archivedBytes / 1024 / 1024,
        )} MB · 队列 ${archiver.queue.size}`,
      );
    }
    await wait(500);
  }
}

await store.shutdown();
await archiver.shutdown();
console.log(
  `[media-scan] done. image posts seen=${grandImagePosts}, newly queued=${grandEnqueued}`,
);
console.log(JSON.stringify(archiver.publicStatus(), null, 2));
