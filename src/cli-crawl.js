import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";
import { TreeholeCrawler } from "./crawler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const store = new HotStore(path.join(__dirname, "..", "data"));
await store.load();

const crawler = new TreeholeCrawler(store);
const stats = await crawler.refresh({ reason: "cli" });
await store.shutdown();
console.log(JSON.stringify(stats, null, 2));
