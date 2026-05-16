import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";
import { TreeholeCrawler } from "./crawler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new HotStore(path.join(__dirname, "..", "data", "hot-cache.json"));
await store.load();

const crawler = new TreeholeCrawler(store, {
  maxPages: Number(process.env.TREEHOLE_SMOKE_PAGES || 1),
  pageDelayMs: 0,
});

const stats = await crawler.refresh({ reason: "smoke" });
const hot = store.hotList({ window: "day", sort: "reply", limit: 5 });
console.log(
  JSON.stringify(
    {
      stats,
      top: hot.map((post) => ({
        pid: post.pid,
        reply: post.reply,
        follow: post.follow,
        timestamp: post.timestamp,
      })),
    },
    null,
    2,
  ),
);
