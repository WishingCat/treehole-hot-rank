import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new HotStore(path.join(__dirname, "..", "data"), {
  maxLoadedSummaryShards: Number(process.env.TREEHOLE_MAX_LOADED_SUMMARY_SHARDS) || 12,
});

await store.load();
const months = await store.listMonths();
let warmed = 0;

for (const month of months) {
  await store.warmShardCaches(month.key);
  warmed += 1;
  console.log(`[warm-summaries] ${month.key} (${warmed}/${months.length})`);
}

await store.shutdown();
console.log(`[warm-summaries] done · months=${warmed}`);
