const state = {
  window: "day",
  sort: "follow",
  query: "",
  posts: [],
  status: null,
  stats: null,
  config: null,
};

const nodes = {
  statusLine: document.querySelector("#statusLine"),
  refreshBtn: document.querySelector("#refreshBtn"),
  searchInput: document.querySelector("#searchInput"),
  listTitle: document.querySelector("#listTitle"),
  listMeta: document.querySelector("#listMeta"),
  sampleCount: document.querySelector("#sampleCount"),
  postList: document.querySelector("#postList"),
  emptyState: document.querySelector("#emptyState"),
  hourCount: document.querySelector("#hourCount"),
  dayCount: document.querySelector("#dayCount"),
  weekCount: document.querySelector("#weekCount"),
  cacheCount: document.querySelector("#cacheCount"),
  pageCount: document.querySelector("#pageCount"),
  lastSuccess: document.querySelector("#lastSuccess"),
  authSource: document.querySelector("#authSource"),
  intervalText: document.querySelector("#intervalText"),
  errorLine: document.querySelector("#errorLine"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(value) {
  if (!value) return "尚无记录";
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatAgo(timestamp) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatInterval(ms) {
  if (!ms) return "未设置";
  const minutes = Math.round(ms / 60000);
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时`;
  return `${minutes} 分钟`;
}

function formatSchedule(config) {
  if (config.scheduleMode === "hourly") {
    return config.nextRunAt ? `整点 ${formatDateTime(config.nextRunAt)}` : "每到整点";
  }
  return `每 ${formatInterval(config.intervalMs)}`;
}

function metricLabel() {
  return state.sort === "follow" ? "关注数" : "回复数";
}

function windowLabel() {
  if (state.window === "hour") return "小时榜";
  return state.window === "week" ? "周榜" : "日榜";
}

function renderStatus() {
  const status = state.status || {};
  const stats = state.stats || {};
  const config = state.config || {};
  const runningText = status.running ? "正在抓取" : "空闲";
  const successText = status.lastSuccessAt
    ? `上次成功 ${formatDateTime(status.lastSuccessAt)}`
    : "等待首次成功抓取";

  nodes.statusLine.textContent = `${runningText} · ${successText}`;
  nodes.refreshBtn.disabled = Boolean(status.running);
  nodes.refreshBtn.textContent = status.running ? "抓取中" : "刷新抓取";
  nodes.hourCount.textContent = stats.hour ?? 0;
  nodes.dayCount.textContent = stats.day ?? 0;
  nodes.weekCount.textContent = stats.week ?? 0;
  nodes.cacheCount.textContent = stats.cached ?? 0;
  nodes.pageCount.textContent =
    status.lastProgress?.pagesFetched ?? status.lastStats?.pagesFetched ?? 0;
  nodes.lastSuccess.textContent = formatDateTime(status.lastSuccessAt);
  nodes.authSource.textContent = status.auth?.source || "未确认";
  nodes.intervalText.textContent = formatSchedule(config);

  if (status.lastError) {
    nodes.errorLine.hidden = false;
    nodes.errorLine.textContent = status.lastError;
  } else {
    nodes.errorLine.hidden = true;
    nodes.errorLine.textContent = "";
  }
}

function renderList() {
  nodes.listTitle.textContent = `${windowLabel()} · ${metricLabel()}`;
  nodes.sampleCount.textContent = `${state.posts.length} 条`;
  nodes.listMeta.textContent = state.status?.lastStats
    ? `样本 ${state.stats?.[state.window] || 0} 条 · 最近抓取 ${
        state.status.lastStats.postsFetched
      } 条`
    : "正在读取缓存";

  nodes.emptyState.hidden = state.posts.length > 0;
  nodes.postList.innerHTML = state.posts
    .map((post, index) => {
      const rank = index + 1;
      const tags = (post.tags || [])
        .slice(0, 5)
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join("");
      return `
        <article class="post-row">
          <div class="rank ${rank <= 3 ? "top" : ""}">${rank}</div>
          <div class="post-main">
            <div class="post-meta">
              <a class="pid-link" href="${escapeHtml(post.url)}" target="_blank" rel="noreferrer">#${
                post.pid
              }</a>
              <span>${formatAgo(post.timestamp)}</span>
              <span>${formatDateTime(post.timestamp)}</span>
              ${post.mediaCount ? `<span>${post.mediaCount} 张图片</span>` : ""}
            </div>
            <p class="post-text">${escapeHtml(post.text || "图片帖 / 无文本内容")}</p>
            ${tags ? `<div class="tags">${tags}</div>` : ""}
          </div>
          <div class="metrics" aria-label="帖子指标">
            <div class="metric"><strong>${post.reply || 0}</strong><span>回复</span></div>
            <div class="metric"><strong>${post.follow || 0}</strong><span>关注</span></div>
            <div class="metric"><strong>${post.praise || 0}</strong><span>赞</span></div>
          </div>
        </article>
      `;
    })
    .join("");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function loadStatus() {
  const data = await fetchJson("/api/status");
  state.status = data.status;
  state.stats = data.stats;
  state.config = data.config;
  renderStatus();
}

async function loadHot() {
  const params = new URLSearchParams({
    window: state.window,
    sort: state.sort,
    limit: "100",
    query: state.query,
  });
  const data = await fetchJson(`/api/hot?${params.toString()}`);
  state.posts = data.list;
  state.status = data.status;
  state.stats = data.stats;
  renderStatus();
  renderList();
}

async function refreshNow() {
  nodes.refreshBtn.disabled = true;
  nodes.refreshBtn.textContent = "抓取中";
  await fetchJson("/api/refresh", { method: "POST" });
  await loadStatus();
}

function setActiveButtons(selector, key, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("active", button.dataset[key] === value);
  });
}

document.querySelectorAll("[data-window]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.window = button.dataset.window;
    setActiveButtons("[data-window]", "window", state.window);
    await loadHot();
  });
});

document.querySelectorAll("[data-sort]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.sort = button.dataset.sort;
    setActiveButtons("[data-sort]", "sort", state.sort);
    await loadHot();
  });
});

let searchTimer;
nodes.searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    state.query = nodes.searchInput.value;
    await loadHot();
  }, 220);
});

nodes.refreshBtn.addEventListener("click", async () => {
  try {
    await refreshNow();
  } catch (error) {
    state.status = {
      ...(state.status || {}),
      running: false,
      lastError: error instanceof Error ? error.message : String(error),
    };
    renderStatus();
  }
});

await loadStatus();
await loadHot();
window.setInterval(loadStatus, 15000);
window.setInterval(loadHot, 30000);
