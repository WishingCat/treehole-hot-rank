import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";
import { DeletedPostTracker } from "./deletedTracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");

const store = new HotStore(dataDir, {
  maxLoadedShards: Number(process.env.TREEHOLE_MAX_LOADED_SHARDS) || undefined,
  maxLoadedSummaryShards:
    Number(process.env.TREEHOLE_MAX_LOADED_SUMMARY_SHARDS) || undefined,
  topCacheLimit: Number(process.env.TREEHOLE_TOP_CACHE_LIMIT) || undefined,
});
await store.load();

const tracker = new DeletedPostTracker(store, dataDir);
await tracker.load();

const stats = await tracker.refresh({ reason: "cli" });
await store.shutdown();
console.log(JSON.stringify(stats, null, 2));
