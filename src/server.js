import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";
import { TreeholeCrawler } from "./crawler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3000);

const store = new HotStore(path.join(rootDir, "data", "hot-cache.json"));
await store.load();

const crawler = new TreeholeCrawler(store);
const app = express();
const allowedWindows = new Set(["hour", "day", "week"]);

app.use(express.json());
app.use(
  express.static(path.join(rootDir, "public"), {
    extensions: ["html"],
  }),
);

app.get("/api/status", (request, response) => {
  response.json({
    ok: true,
    status: store.status,
    stats: store.stats(),
    config: {
      scheduleMode: crawler.scheduleMode,
      intervalMs: crawler.intervalMs,
      nextRunAt: crawler.nextRunAt,
      pageSize: crawler.pageSize,
      maxPages: crawler.maxPages,
    },
  });
});

app.get("/api/hot", (request, response) => {
  const requestedWindow =
    typeof request.query.window === "string" ? request.query.window : "day";
  const list = store.hotList({
    window: allowedWindows.has(requestedWindow) ? requestedWindow : "day",
    sort: request.query.sort === "follow" ? "follow" : "reply",
    limit: request.query.limit || 100,
    query: typeof request.query.query === "string" ? request.query.query : "",
  });
  response.json({
    ok: true,
    list,
    status: store.status,
    stats: store.stats(),
  });
});

app.post("/api/refresh", async (request, response) => {
  const run = crawler.refresh({ reason: "manual" });
  if (request.query.wait === "1") {
    try {
      const stats = await run;
      response.json({ ok: true, stats, status: store.status });
    } catch (error) {
      response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: store.status,
      });
    }
    return;
  }

  response.json({
    ok: true,
    status: store.status,
  });
});

app.use((request, response) => {
  response.sendFile(path.join(rootDir, "public", "index.html"));
});

function listenWithRetry(startPort, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryListen = (candidatePort, remaining) => {
      const server = createServer(app);
      server.once("error", (error) => {
        if (error.code === "EADDRINUSE" && remaining > 0) {
          tryListen(candidatePort + 1, remaining - 1);
          return;
        }
        reject(error);
      });
      server.listen(candidatePort, () => resolve({ server, port: candidatePort }));
    };

    tryListen(startPort, attempts);
  });
}

const { server, port: actualPort } = await listenWithRetry(port);
console.log(`Treehole hot rank is running at http://localhost:${actualPort}`);

crawler.refresh({ reason: "startup" }).catch((error) => {
  console.error("[crawler] startup refresh failed:", error.message || error);
});
crawler.startScheduler();

const shutdown = () => {
  crawler.stopScheduler();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
