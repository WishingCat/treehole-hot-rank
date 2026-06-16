import express from "express";
import crypto from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HotStore } from "./store.js";
import { TreeholeCrawler } from "./crawler.js";
import { DeletedPostTracker } from "./deletedTracker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const startupMode = process.env.TREEHOLE_STARTUP_MODE || "incremental";
const adminCookieName = "treehole_admin";
const adminSessionSecret =
  process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || crypto.randomBytes(32).toString("hex");
const configuredAdminSessionTtlMs = Number(process.env.ADMIN_SESSION_TTL_MS);
const adminSessionTtlMs =
  Number.isFinite(configuredAdminSessionTtlMs) && configuredAdminSessionTtlMs > 0
    ? configuredAdminSessionTtlMs
    : 7 * 24 * 60 * 60 * 1000;
const adminAccounts = parseAdminAccounts();

const store = new HotStore(dataDir, {
  maxLoadedShards: Number(process.env.TREEHOLE_MAX_LOADED_SHARDS) || undefined,
  maxLoadedSummaryShards:
    Number(process.env.TREEHOLE_MAX_LOADED_SUMMARY_SHARDS) || undefined,
  topCacheLimit: Number(process.env.TREEHOLE_TOP_CACHE_LIMIT) || undefined,
});
await store.load();

const crawler = new TreeholeCrawler(store);
const deletedTracker = new DeletedPostTracker(store, dataDir);
await deletedTracker.load();
const app = express();
const allowedWindows = new Set(["hour", "day", "week"]);

app.use(express.json());
app.use(
  express.static(path.join(rootDir, "public"), {
    extensions: ["html"],
  }),
);

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function signPayload(payloadText) {
  return crypto.createHmac("sha256", adminSessionSecret).update(payloadText).digest("base64url");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function addAdminAccount(accounts, username, password) {
  const normalizedUsername = String(username || "").trim();
  const normalizedPassword = String(password || "");
  if (!normalizedUsername || !normalizedPassword) return;
  accounts.set(normalizedUsername, normalizedPassword);
}

function parseDelimitedAdminAccounts(raw, accounts) {
  for (const entry of String(raw || "").split(/[\n;,]/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const equalsIndex = trimmed.indexOf("=");
    const colonIndex = trimmed.indexOf(":");
    const separatorIndex =
      equalsIndex >= 0 && colonIndex >= 0
        ? Math.min(equalsIndex, colonIndex)
        : Math.max(equalsIndex, colonIndex);
    if (separatorIndex <= 0) continue;

    addAdminAccount(
      accounts,
      trimmed.slice(0, separatorIndex),
      trimmed.slice(separatorIndex + 1),
    );
  }
}

function parseAdminAccounts() {
  const accounts = new Map();
  const rawAccounts = process.env.ADMIN_ACCOUNTS || process.env.ADMIN_USERS || "";

  if (rawAccounts.trim().startsWith("{") || rawAccounts.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(rawAccounts);
      if (Array.isArray(parsed)) {
        for (const account of parsed) {
          addAdminAccount(accounts, account?.username, account?.password);
        }
      } else {
        for (const [username, password] of Object.entries(parsed)) {
          addAdminAccount(accounts, username, password);
        }
      }
    } catch (error) {
      console.warn("[auth] ADMIN_ACCOUNTS JSON 解析失败，改用分隔符格式:", error.message);
      parseDelimitedAdminAccounts(rawAccounts, accounts);
    }
  } else {
    parseDelimitedAdminAccounts(rawAccounts, accounts);
  }

  addAdminAccount(accounts, process.env.ADMIN_USERNAME || "", process.env.ADMIN_PASSWORD || "");
  return accounts;
}

function parseTimestampParam(raw, side) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    let seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    if (seconds > 1e12) seconds = Math.floor(seconds / 1000);
    return Math.floor(seconds);
  }
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, yearString, monthString, dayString] = dateOnly;
    const year = Number(yearString);
    const month = Number(monthString) - 1;
    const day = Number(dayString);
    const baseMs = Date.UTC(year, month, day);
    if (Number.isNaN(baseMs)) return null;
    const offsetMs = side === "end" ? 24 * 60 * 60 * 1000 - 1000 : 0;
    return Math.floor((baseMs + offsetMs) / 1000);
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  return null;
}

function parseListLimit(raw, fallback = 100) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 300) : fallback;
}

function parseListOffset(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 200000) : 0;
}

function paginatedResponse(list, offset, limit) {
  const items = Array.isArray(list) ? list : [];
  return {
    list: items.slice(0, limit),
    pagination: {
      offset,
      limit,
      nextOffset: offset + Math.min(items.length, limit),
      hasMore: items.length > limit,
    },
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        const key = index >= 0 ? part.slice(0, index) : part;
        const value = index >= 0 ? part.slice(index + 1) : "";
        try {
          return [key, decodeURIComponent(value)];
        } catch {
          return [key, value];
        }
      }),
  );
}

function createAdminToken(username) {
  const payload = base64UrlJson({
    username,
    exp: Date.now() + adminSessionTtlMs,
  });
  return `${payload}.${signPayload(payload)}`;
}

function readAdminToken(request) {
  return parseCookies(request.headers.cookie || "")[adminCookieName] || "";
}

function isAdminRequest(request) {
  return Boolean(adminSession(request));
}

function adminSession(request) {
  if (!adminAccounts.size) return null;

  const token = readAdminToken(request);
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  if (!constantTimeEqual(signPayload(payload), signature)) return null;

  try {
    const session = parseBase64UrlJson(payload);
    const username = String(session.username || "");
    if (!adminAccounts.has(username)) return null;
    if (Number(session.exp) <= Date.now()) return null;
    return { username };
  } catch {
    return null;
  }
}

function adminCookie(value, maxAgeSeconds) {
  const secure = process.env.ADMIN_COOKIE_SECURE === "1" ? "; Secure" : "";
  return `${adminCookieName}=${encodeURIComponent(
    value,
  )}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearAdminCookie() {
  return adminCookie("", 0);
}

function adminPublicInfo(request) {
  const session = adminSession(request);
  return {
    configured: adminAccounts.size > 0,
    isAdmin: Boolean(session),
    publicAccess: true,
    username: session?.username || null,
  };
}

function statusForRequest(request) {
  const status = JSON.parse(JSON.stringify(store.status || {}));
  if (!isAdminRequest(request) && status.auth) {
    status.auth = {
      source: status.auth.source ? "已配置" : null,
      expiresAt: null,
      subject: null,
    };
  }
  return status;
}

app.get("/api/auth/me", (request, response) => {
  response.json({
    ok: true,
    auth: adminPublicInfo(request),
  });
});

app.post("/api/auth/login", (request, response) => {
  if (!adminAccounts.size) {
    response.status(503).json({
      ok: false,
      error: "管理员登录未配置，请先设置 ADMIN_ACCOUNTS 或 ADMIN_PASSWORD。",
    });
    return;
  }

  const username = String(request.body?.username || "");
  const password = String(request.body?.password || "");
  const expectedPassword = adminAccounts.get(username);
  const passwordOk = expectedPassword && constantTimeEqual(password, expectedPassword);
  if (!passwordOk) {
    response.status(401).json({ ok: false, error: "管理员账号或密码不正确。" });
    return;
  }

  response.setHeader(
    "Set-Cookie",
    adminCookie(createAdminToken(username), Math.floor(adminSessionTtlMs / 1000)),
  );
  response.json({
    ok: true,
    auth: {
      configured: true,
      isAdmin: true,
      username,
    },
  });
});

app.post("/api/auth/logout", (request, response) => {
  response.setHeader("Set-Cookie", clearAdminCookie());
  response.json({
    ok: true,
    auth: {
      ...adminPublicInfo(request),
      username: null,
    },
  });
});

app.get("/api/status", (request, response) => {
  response.json({
    ok: true,
    auth: adminPublicInfo(request),
    status: statusForRequest(request),
    stats: store.stats(),
    config: {
      host,
      startupMode,
      scheduleMode: crawler.scheduleMode,
      intervalMs: crawler.intervalMs,
      nextRunAt: crawler.nextRunAt,
      pageSize: crawler.pageSize,
      maxPages: crawler.maxPages,
      incrementalMaxPages: crawler.incrementalMaxPages,
      backfillIntervalMs: crawler.backfillIntervalMs,
      commentLimitFast: crawler.commentLimitFast,
      commentLimitBackfill: crawler.commentLimitBackfill,
      commentLimitArchive: crawler.commentLimitArchive,
      archiveEnabled: crawler.archiveEnabled,
      archiveDays: crawler.archiveDays,
      archiveMaxPages: crawler.archiveMaxPages,
      archiveSlicePages: crawler.archiveSlicePages,
      archiveIntervalMs: crawler.archiveIntervalMs,
      archiveNextRunAt: crawler.archiveNextRunAt,
      maxLoadedShards: store.maxLoadedShards,
      maxLoadedSummaryShards: store.maxLoadedSummaryShards,
      topCacheLimit: store.topCacheLimit,
      deletedScan: deletedTracker.publicStatus(),
    },
  });
});

app.get("/api/hot", async (request, response, next) => {
  try {
    const requestedWindow =
      typeof request.query.window === "string" ? request.query.window : "day";
    const list = await store.hotList({
      window: allowedWindows.has(requestedWindow) ? requestedWindow : "day",
      sort: request.query.sort === "follow" ? "follow" : "reply",
      limit: request.query.limit || 100,
      query: typeof request.query.query === "string" ? request.query.query : "",
    });
    response.json({
      ok: true,
      list,
      auth: adminPublicInfo(request),
      status: statusForRequest(request),
      stats: store.stats(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/realtime", async (request, response, next) => {
  try {
    const limit = parseListLimit(request.query.limit);
    const offset = parseListOffset(request.query.offset);
    const list = await store.realtimeList({
      limit: limit + 1,
      offset,
      query: typeof request.query.query === "string" ? request.query.query : "",
    });
    const page = paginatedResponse(list, offset, limit);
    response.json({
      ok: true,
      list: page.list,
      pagination: page.pagination,
      auth: adminPublicInfo(request),
      status: statusForRequest(request),
      stats: store.stats(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/months", async (request, response, next) => {
  try {
    const months = await store.listMonths();
    response.json({
      ok: true,
      months,
      auth: adminPublicInfo(request),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/archive", async (request, response, next) => {
  try {
    const month = typeof request.query.month === "string" ? request.query.month : "";
    const startTimestamp = parseTimestampParam(request.query.start, "start");
    const endTimestamp = parseTimestampParam(request.query.end, "end");
    const months = await store.listMonths();
    const sort = request.query.sort === "follow" ? "follow" : "reply";
    const limit = parseListLimit(request.query.limit);
    const offset = parseListOffset(request.query.offset);
    const query = typeof request.query.query === "string" ? request.query.query : "";

    if (startTimestamp || endTimestamp) {
      const list = await store.rangeList({
        startTimestamp: startTimestamp || 0,
        endTimestamp: endTimestamp || Math.floor(Date.now() / 1000),
        sort,
        limit: limit + 1,
        offset,
        query,
      });
      const page = paginatedResponse(list, offset, limit);
      response.json({
        ok: true,
        list: page.list,
        pagination: page.pagination,
        months,
        range: {
          startTimestamp: startTimestamp || null,
          endTimestamp: endTimestamp || null,
        },
        auth: adminPublicInfo(request),
        status: statusForRequest(request),
        stats: store.stats(),
      });
      return;
    }

    if (!/^\d{4}-\d{2}$/.test(month)) {
      response.json({
        ok: true,
        list: [],
        pagination: {
          offset,
          limit,
          nextOffset: offset,
          hasMore: false,
        },
        months,
        requiresMonth: true,
        auth: adminPublicInfo(request),
        status: statusForRequest(request),
        stats: store.stats(),
      });
      return;
    }
    const list = await store.archiveList({
      month,
      sort,
      limit: limit + 1,
      offset,
      query,
    });
    const page = paginatedResponse(list, offset, limit);
    response.json({
      ok: true,
      list: page.list,
      pagination: page.pagination,
      month,
      months,
      auth: adminPublicInfo(request),
      status: statusForRequest(request),
      stats: store.stats(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/deleted", async (request, response, next) => {
  try {
    const sort =
      request.query.sort === "follow" ||
      request.query.sort === "reply" ||
      request.query.sort === "time" ||
      request.query.sort === "detected"
        ? request.query.sort
        : "time";
    const limit = parseListLimit(request.query.limit);
    const offset = parseListOffset(request.query.offset);
    const result = await deletedTracker.list({
      sort,
      limit: limit + 1,
      offset,
      query: typeof request.query.query === "string" ? request.query.query : "",
    });
    const page = paginatedResponse(result.list, offset, limit);
    response.json({
      ok: true,
      list: page.list,
      pagination: page.pagination,
      deleted: result.status,
      auth: adminPublicInfo(request),
      status: statusForRequest(request),
      stats: store.stats(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/post/:pid", async (request, response, next) => {
  try {
    const post = await store.getPost(request.params.pid);
    if (!post) {
      response.status(404).json({ ok: false, error: "帖子未在本地缓存中找到" });
      return;
    }
    response.json({
      ok: true,
      post,
      status: statusForRequest(request),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/refresh", async (request, response) => {
  if (adminAccounts.size && !isAdminRequest(request)) {
    response.status(403).json({
      ok: false,
      error: "需要管理员登录后手动刷新。",
      auth: adminPublicInfo(request),
      status: statusForRequest(request),
    });
    return;
  }

  const run = crawler.refresh({ reason: "manual" });
  if (request.query.wait === "1") {
    try {
      const stats = await run;
      response.json({ ok: true, stats, status: statusForRequest(request) });
    } catch (error) {
      response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        status: statusForRequest(request),
      });
    }
    return;
  }

  response.json({
    ok: true,
    status: statusForRequest(request),
  });
});

app.post("/api/deleted/refresh", async (request, response) => {
  if (adminAccounts.size && !isAdminRequest(request)) {
    response.status(403).json({
      ok: false,
      error: "需要管理员登录后手动刷新被删帖。",
      auth: adminPublicInfo(request),
      deleted: deletedTracker.publicStatus(),
    });
    return;
  }

  const run = deletedTracker.refresh({ reason: "manual" });
  if (request.query.wait === "1") {
    try {
      const stats = await run;
      response.json({ ok: true, stats, deleted: deletedTracker.publicStatus() });
    } catch (error) {
      response.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        deleted: deletedTracker.publicStatus(),
      });
    }
    return;
  }

  response.json({
    ok: true,
    deleted: deletedTracker.publicStatus(),
  });
});

app.use((request, response) => {
  response.sendFile(path.join(rootDir, "public", "index.html"));
});

function displayHost(hostValue) {
  return hostValue === "0.0.0.0" ? "localhost" : hostValue;
}

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
      server.listen(candidatePort, host, () =>
        resolve({ server, host, port: candidatePort }),
      );
    };

    tryListen(startPort, attempts);
  });
}

const { server, host: actualHost, port: actualPort } = await listenWithRetry(port);
console.log(
  `Treehole hot rank is running at http://${displayHost(actualHost)}:${actualPort}`,
);

crawler.refresh({ reason: "startup", mode: startupMode }).catch((error) => {
  console.error("[crawler] startup refresh failed:", error.message || error);
});
crawler.startScheduler();
deletedTracker.startScheduler();

const shutdown = () => {
  crawler.stopScheduler();
  deletedTracker.stopScheduler();
  store
    .shutdown()
    .catch((error) => console.error("[store] shutdown flush failed:", error.message || error))
    .finally(() => server.close(() => process.exit(0)));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
