const state = {
  mode: "hot",
  window: "day",
  sort: "follow",
  query: "",
  archiveMonth: "",
  archiveMonths: [],
  archiveStart: "",
  archiveEnd: "",
  deleted: null,
  posts: [],
  pagination: {
    limit: 100,
    nextOffset: 0,
    hasMore: false,
    loadingMore: false,
  },
  status: null,
  stats: null,
  config: null,
  detailPost: null,
  auth: {
    configured: false,
    isAdmin: false,
    username: null,
  },
};

const REALTIME_REFRESH_MS = 10 * 1000;
const HOT_REFRESH_MS = 60 * 60 * 1000;
const ARCHIVE_REFRESH_MS = 60 * 1000;
const STATUS_REFRESH_MS = 10 * 1000;
const LIST_PAGE_SIZE = 100;
let listRefreshTimer = null;
let scheduledListRefreshMs = null;
let listAutoLoading = false;
let statusAutoLoading = false;

const nodes = {
  statusLine: document.querySelector("#statusLine"),
  editionDate: document.querySelector("#editionDate"),
  themeToggle: document.querySelector("#themeToggle"),
  realtimeBtn: document.querySelector("#realtimeBtn"),
  hotBtn: document.querySelector("#hotBtn"),
  archiveBtn: document.querySelector("#archiveBtn"),
  deletedBtn: document.querySelector("#deletedBtn"),
  windowControl: document.querySelector("#windowControl"),
  sortControl: document.querySelector("#sortControl"),
  scopeStatic: document.querySelector("#scopeStatic"),
  sortStatic: document.querySelector("#sortStatic"),
  searchInput: document.querySelector("#searchInput"),
  monthField: document.querySelector("#monthField"),
  monthSelect: document.querySelector("#monthSelect"),
  rangeField: document.querySelector("#rangeField"),
  rangeStart: document.querySelector("#rangeStart"),
  rangeEnd: document.querySelector("#rangeEnd"),
  rangeClear: document.querySelector("#rangeClear"),
  listTitle: document.querySelector("#listTitle"),
  listMeta: document.querySelector("#listMeta"),
  sampleCount: document.querySelector("#sampleCount"),
  postList: document.querySelector("#postList"),
  loadMoreBtn: document.querySelector("#loadMoreBtn"),
  emptyState: document.querySelector("#emptyState"),
  hourCount: document.querySelector("#hourCount"),
  dayCount: document.querySelector("#dayCount"),
  weekCount: document.querySelector("#weekCount"),
  cacheCount: document.querySelector("#cacheCount"),
  commentCount: document.querySelector("#commentCount"),
  pageCount: document.querySelector("#pageCount"),
  lastSuccess: document.querySelector("#lastSuccess"),
  authSource: document.querySelector("#authSource"),
  intervalText: document.querySelector("#intervalText"),
  errorLine: document.querySelector("#errorLine"),
  detailDialog: document.querySelector("#detailDialog"),
  detailClose: document.querySelector("#detailClose"),
  detailContent: document.querySelector("#detailContent"),
  lightbox: document.querySelector("#imageLightbox"),
  lightboxImg: document.querySelector("#lightboxImg"),
  lightboxClose: document.querySelector("#lightboxClose"),
  lightboxPrev: document.querySelector("#lightboxPrev"),
  lightboxNext: document.querySelector("#lightboxNext"),
  lightboxCounter: document.querySelector("#lightboxCounter"),
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
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) return "时间未知";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - numericTimestamp));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function formatInterval(ms) {
  if (!ms) return "未设置";
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = Math.round(ms / 60000);
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时`;
  return `${minutes} 分钟`;
}

function formatSchedule(config) {
  if (config.scheduleMode === "hourly") {
    return config.nextRunAt ? `整点 ${formatDateTime(config.nextRunAt)}` : "每到整点";
  }
  return `每 ${formatInterval(config.intervalMs)} 自动同步`;
}

const SHICHEN = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"];

function shichen(date) {
  return `${SHICHEN[Math.floor(((date.getHours() + 1) % 24) / 2)]}时`;
}

function formatEdition() {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  return `夜话集 · ${ymd} · ${shichen(now)}`;
}

function currentSort() {
  return state.sort;
}

function metricLabel(sort = currentSort()) {
  return sort === "follow" ? "关注数" : "回复数";
}

function windowLabel() {
  if (state.window === "hour") return "小时榜";
  return state.window === "week" ? "周榜" : "日榜";
}

function listTitle() {
  if (state.mode === "realtime") return "实时数据";
  if (state.mode === "deleted") return "被删帖";
  if (state.mode === "archive") {
    if (hasArchiveRange()) {
      return `历史库 · ${rangeLabel()} · ${metricLabel(state.sort)}`;
    }
    return state.archiveMonth
      ? `历史库 · ${formatMonthLabel(state.archiveMonth)} · ${metricLabel(state.sort)}`
      : `历史库 · ${metricLabel(state.sort)}`;
  }
  return `${windowLabel()} · ${metricLabel(state.sort)}`;
}

function hasArchiveRange() {
  return Boolean(state.archiveStart || state.archiveEnd);
}

function rangeLabel() {
  const start = state.archiveStart ? formatDateLabel(state.archiveStart) : "最早";
  const end = state.archiveEnd ? formatDateLabel(state.archiveEnd) : "至今";
  return `${start} ~ ${end}`;
}

function formatDateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return value || "";
  return `${match[1]}/${Number(match[2])}/${Number(match[3])}`;
}

function localDateToUnix(value, endOfDay) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = endOfDay
    ? new Date(year, month, day, 23, 59, 59, 999)
    : new Date(year, month, day, 0, 0, 0, 0);
  const time = date.getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

function formatMonthLabel(key) {
  if (!/^\d{4}-\d{2}$/.test(key || "")) return key || "";
  const [year, month] = key.split("-");
  return `${year} 年 ${Number(month)} 月`;
}

function renderMonthPicker() {
  if (!nodes.monthField || !nodes.monthSelect) return;
  const showPicker = state.mode === "archive";
  nodes.monthField.hidden = !showPicker;
  if (nodes.rangeField) nodes.rangeField.hidden = !showPicker;
  if (!showPicker) return;

  const months = Array.isArray(state.archiveMonths) ? [...state.archiveMonths] : [];
  months.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

  const desired = state.archiveMonth;
  const optionsHtml = ['<option value="">请选择月份</option>']
    .concat(
      months.map(
        (m) =>
          `<option value="${m.key}">${formatMonthLabel(m.key)}（${m.count} 帖）</option>`,
      ),
    )
    .join("");
  if (nodes.monthSelect.innerHTML !== optionsHtml) {
    nodes.monthSelect.innerHTML = optionsHtml;
  }
  nodes.monthSelect.value = desired || "";

  if (nodes.rangeStart && nodes.rangeStart.value !== (state.archiveStart || "")) {
    nodes.rangeStart.value = state.archiveStart || "";
  }
  if (nodes.rangeEnd && nodes.rangeEnd.value !== (state.archiveEnd || "")) {
    nodes.rangeEnd.value = state.archiveEnd || "";
  }
}

function archiveProgressText() {
  const archive = state.status?.archive;
  if (!archive) return "等待归档启动";
  if (archive.completed) return `一年归档已完成 · 最后页 ${archive.lastPageFetched || 0}`;
  if (archive.running) {
    return `一年归档进行中 · 第 ${archive.startPage || archive.nextPage || 1} 页`;
  }
  return `一年归档待继续 · 下一页 ${archive.nextPage || 1}`;
}

function deletedProgressText() {
  const deleted = state.deleted;
  if (!deleted?.lastSuccessAt) {
    return deleted?.running ? "正在进行首次对比" : "等待首次对比";
  }
  const count = deleted.count ?? deleted.lastStats?.deletedCount ?? 0;
  const base = `发现 ${count} 条 · 上次对比 ${formatDateTime(deleted.lastSuccessAt)}`;
  if (deleted.running) {
    const progress = deleted.lastProgress;
    return progress
      ? `正在对比 · 已扫 ${progress.pagesFetched || 0} 页 / ${progress.targetMaxPages || "?"} 页 · ${base}`
      : `正在对比 · ${base}`;
  }
  return base;
}

function resetPagination() {
  state.pagination = {
    limit: LIST_PAGE_SIZE,
    nextOffset: 0,
    hasMore: false,
    loadingMore: false,
  };
}

function applyPagination(pagination, loadedCount) {
  state.pagination = {
    limit: Number(pagination?.limit || LIST_PAGE_SIZE),
    nextOffset: Number(pagination?.nextOffset ?? loadedCount),
    hasMore: Boolean(pagination?.hasMore),
    loadingMore: false,
  };
}

function appendUniquePosts(nextPosts) {
  const existing = new Set(state.posts.map((post) => String(post.pid)));
  for (const post of nextPosts || []) {
    if (existing.has(String(post.pid))) continue;
    state.posts.push(post);
    existing.add(String(post.pid));
  }
}

function currentListRefreshMs() {
  if (state.mode === "realtime") return REALTIME_REFRESH_MS;
  if (state.mode === "deleted") return ARCHIVE_REFRESH_MS;
  if (state.mode === "archive") return ARCHIVE_REFRESH_MS;
  return HOT_REFRESH_MS;
}

function scheduleListRefresh() {
  const nextMs = currentListRefreshMs();
  if (listRefreshTimer && scheduledListRefreshMs === nextMs) return;

  if (listRefreshTimer) window.clearInterval(listRefreshTimer);
  scheduledListRefreshMs = nextMs;
  listRefreshTimer = window.setInterval(loadCurrentListSafely, nextMs);
}

function renderStatus() {
  const status = state.status || {};
  const stats = state.stats || {};
  const config = state.config || {};
  const runningText = status.running ? "正在同步" : "自动同步中";
  const successText = status.lastSuccessAt
    ? `上次成功 ${formatDateTime(status.lastSuccessAt)}`
    : "等待首次成功抓取";

  nodes.statusLine.textContent = `${runningText} · ${successText}`;
  if (nodes.editionDate) nodes.editionDate.textContent = formatEdition();
  nodes.hourCount.textContent = stats.hour ?? 0;
  nodes.dayCount.textContent = stats.day ?? 0;
  nodes.weekCount.textContent = stats.week ?? 0;
  nodes.cacheCount.textContent = stats.cached ?? 0;
  nodes.commentCount.textContent = stats.commentsCached ?? 0;
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

function renderAuth() {
  state.auth = { ...(state.auth || {}), publicAccess: true };
  nodes.realtimeBtn.hidden = false;
  nodes.hotBtn.hidden = false;
  nodes.archiveBtn.hidden = false;
  nodes.deletedBtn.hidden = false;
}

function postText(post) {
  return post.text || "图片帖 / 无文本内容";
}

function renderList() {
  nodes.listTitle.textContent = listTitle();
  nodes.sampleCount.textContent =
    state.mode === "hot" ? `前 ${state.posts.length} 条` : `已载入 ${state.posts.length} 条`;
  nodes.listMeta.textContent =
    state.mode === "realtime"
      ? `按发布时间倒序 · 本地缓存 ${state.stats?.cached || 0} 条 · 最近同步 ${
          state.status?.lastStats?.postsFetched ?? 0
        } 条`
      : state.mode === "deleted"
        ? `按原帖发布时间倒序 · ${deletedProgressText()}`
      : state.mode === "archive"
        ? hasArchiveRange()
          ? `${rangeLabel()} · 本地缓存 ${state.stats?.cached || 0} 条 · ${archiveProgressText()}`
          : state.archiveMonth
            ? `${formatMonthLabel(state.archiveMonth)} · 本地缓存 ${state.stats?.cached || 0} 条 · ${archiveProgressText()}`
            : `请选择月份或日期范围加载历史归档 · 本地缓存 ${state.stats?.cached || 0} 条 · ${archiveProgressText()}`
      : state.status?.lastStats
        ? `样本 ${state.stats?.[state.window] || 0} 条 · 最近同步 ${
            state.status.lastStats.postsFetched
          } 条 · ${state.status.lastStats.mode || "incremental"}`
        : "正在读取缓存";

  nodes.emptyState.hidden = state.posts.length > 0;
  const activeMetric =
    state.mode === "hot" || state.mode === "archive" ? state.sort : null;
  const metricCell = (key, value, label) =>
    `<div class="metric${activeMetric === key ? " is-active" : ""}"><span>${label}</span><strong>${value || 0}</strong></div>`;

  nodes.postList.innerHTML = state.posts
    .map((post, index) => {
      const rank = index + 1;
      const topClass = rank <= 3 ? ` is-top rank-${rank}` : "";
      const tags = (post.tags || [])
        .slice(0, 5)
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join("");
      return `
        <article class="entry is-clickable${topClass}" data-pid="${escapeHtml(post.pid)}" tabindex="0" role="button" aria-label="展开 #${escapeHtml(post.pid)} 详情">
          <div class="rank">${rank}</div>
          <div class="post-main">
            <div class="post-meta">
              <span class="pid">#${escapeHtml(post.pid)}</span>
              <span>${formatAgo(post.timestamp)}</span>
              <span>${formatDateTime(post.timestamp)}</span>
              ${post.mediaCount ? `<span>${post.mediaCount} 图</span>` : ""}
              ${
                state.mode === "deleted" && post.deletedLastDetectedAt
                  ? `<span class="meta-deleted">删于 ${formatDateTime(post.deletedLastDetectedAt)}</span>`
                  : ""
              }
              ${post.commentsCached ? `<span>留言 ${post.commentsCached}</span>` : ""}
            </div>
            <p class="post-text">${escapeHtml(postText(post))}</p>
            ${tags ? `<div class="tags">${tags}</div>` : ""}
          </div>
          <div class="metrics" aria-label="帖子指标">
            ${metricCell("reply", post.reply, "回复")}
            ${metricCell("follow", post.follow, "关注")}
            <div class="metric"><span>赞</span><strong>${post.praise || 0}</strong></div>
          </div>
        </article>
      `;
    })
    .join("");

  if (nodes.loadMoreBtn) {
    const showLoadMore = state.mode !== "hot" && state.pagination.hasMore;
    nodes.loadMoreBtn.hidden = !showLoadMore;
    nodes.loadMoreBtn.disabled = state.pagination.loadingMore;
    nodes.loadMoreBtn.textContent = state.pagination.loadingMore ? "正在展开…" : "继续翻阅";
  }
}

function renderDetail(post) {
  const cachedCommentCount = Array.isArray(post.comments) ? post.comments.length : 0;
  const displayedCommentTotal = Math.max(
    cachedCommentCount,
    Number(post.reply || 0),
    Number(post.commentTotal || 0) >= 1000 ? 0 : Number(post.commentTotal || 0),
  );
  const tags = (post.tags || [])
    .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
    .join("");
  const images = Array.isArray(post.images) ? post.images : [];
  const hasMedia = Number(post.mediaCount || 0) > 0 || post.type === "image";
  const imageGrid = images.length
    ? `<div class="detail-images" data-count="${images.length}">${images
        .map(
          (img, index) =>
            `<button type="button" class="detail-image" data-image-index="${index}" aria-label="放大查看第 ${index + 1} 张图片"><img src="${escapeHtml(
              img.src,
            )}" loading="lazy" decoding="async" alt="树洞图片 ${index + 1}" /></button>`,
        )
        .join("")}</div>`
    : "";
  const mediaPending =
    !images.length && hasMedia && !post.detailLoading
      ? '<p class="media-pending">图片暂未归档（后台持续抓取中）</p>'
      : "";
  const comments = (post.comments || [])
    .map(
      (comment) => `
        <li class="comment-item">
          <div class="comment-meta">
            <span class="comment-floor">#${escapeHtml(comment.floor || "?")}</span>
            <span class="comment-author ${comment.isHoleOwner ? "owner" : ""}">${escapeHtml(
              comment.authorTag || comment.authorLabel || "匿名用户",
            )}</span>
            ${comment.isHoleOwner ? '<span class="owner-badge">洞主</span>' : ""}
            ${comment.replyTo ? `<span>回复 #${escapeHtml(comment.replyTo)}</span>` : ""}
            <span>${formatDateTime(comment.timestamp)}</span>
            ${comment.praise ? `<span>${comment.praise} 赞</span>` : ""}
          </div>
          <p>${escapeHtml(comment.text || "无文本内容")}</p>
        </li>
      `,
    )
    .join("");
  const commentBody = post.detailError
    ? `<p class="empty-comments">读取详情失败：${escapeHtml(post.detailError)}</p>`
    : comments
      ? `<ol class="comment-list">${comments}</ol>`
      : post.detailLoading
        ? '<p class="empty-comments">正在读取已缓存留言…</p>'
        : '<p class="empty-comments">本地暂未缓存到留言内容。</p>';

  nodes.detailContent.innerHTML = `
    <header class="detail-head">
      <p class="eyebrow">树洞夜话</p>
      <h2 id="detailTitle">#${escapeHtml(post.pid)}</h2>
      <p class="detail-time">${formatDateTime(post.timestamp)} · ${formatAgo(post.timestamp)}</p>
    </header>
    <p class="detail-text">${escapeHtml(postText(post))}</p>
    <div class="detail-metrics">
      <div class="metric"><strong>${post.reply || 0}</strong><span>回复</span></div>
      <div class="metric"><strong>${post.follow || 0}</strong><span>关注</span></div>
      <div class="metric"><strong>${post.praise || 0}</strong><span>赞</span></div>
      <div class="metric"><strong>${post.tread || 0}</strong><span>踩</span></div>
    </div>
    ${tags ? `<div class="tags detail-tags">${tags}</div>` : ""}
    ${imageGrid}
    ${mediaPending}
    <section class="comments-section">
      <h3>已缓存留言 ${cachedCommentCount} / ${displayedCommentTotal}</h3>
      ${commentBody}
    </section>
  `;
}

function openDetail(post) {
  state.detailPost = post;
  renderDetail(post);
  nodes.detailDialog.hidden = false;
  document.body.classList.add("reader-open");
}

function closeDetail() {
  closeLightbox();
  nodes.detailDialog.hidden = true;
  document.body.classList.remove("reader-open");
}

// ---- 图片灯箱（放大查看帖内图片）----
let lightboxImages = [];
let lightboxIndex = 0;

function renderLightbox() {
  if (!nodes.lightbox || !lightboxImages.length) return;
  const image = lightboxImages[lightboxIndex];
  if (nodes.lightboxImg) {
    nodes.lightboxImg.src = image.src;
    nodes.lightboxImg.alt = `树洞图片 ${lightboxIndex + 1}`;
  }
  const multi = lightboxImages.length > 1;
  if (nodes.lightboxCounter) {
    nodes.lightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxImages.length}`;
    nodes.lightboxCounter.hidden = !multi;
  }
  if (nodes.lightboxPrev) nodes.lightboxPrev.hidden = !multi;
  if (nodes.lightboxNext) nodes.lightboxNext.hidden = !multi;
}

function openLightbox(images, index) {
  if (!nodes.lightbox || !Array.isArray(images) || !images.length) return;
  lightboxImages = images;
  lightboxIndex = Math.max(0, Math.min(index, images.length - 1));
  renderLightbox();
  nodes.lightbox.hidden = false;
  document.body.classList.add("reader-open");
}

function closeLightbox() {
  if (!nodes.lightbox || nodes.lightbox.hidden) return;
  nodes.lightbox.hidden = true;
  if (nodes.lightboxImg) nodes.lightboxImg.removeAttribute("src");
  if (nodes.detailDialog.hidden) document.body.classList.remove("reader-open");
}

function stepLightbox(delta) {
  if (lightboxImages.length < 2) return;
  lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
  renderLightbox();
}

async function fetchJson(url, options = {}) {
  const { timeoutMs = 30000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      credentials: "same-origin",
      signal: controller.signal,
      ...fetchOptions,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("请求超时，请稍后重试");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    throw new Error("服务器返回了无法解析的数据");
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadAuth() {
  const data = await fetchJson("/api/auth/me");
  state.auth = { ...(data.auth || {}), publicAccess: true };
  renderAuth();
}

async function loadStatus() {
  const data = await fetchJson("/api/status");
  if (data.auth) state.auth = data.auth;
  state.status = data.status;
  state.stats = data.stats;
  state.config = data.config;
  renderAuth();
  renderStatus();
}

async function loadHot() {
  const params = new URLSearchParams({
    window: state.window,
    sort: state.sort,
    limit: String(LIST_PAGE_SIZE),
    query: state.query,
  });
  const data = await fetchJson(`/api/hot?${params.toString()}`);
  state.posts = data.list;
  resetPagination();
  if (data.auth) state.auth = data.auth;
  state.status = data.status;
  state.stats = data.stats;
  renderAuth();
  renderStatus();
  renderList();
}

async function loadRealtime({ append = false } = {}) {
  const offset = append ? state.pagination.nextOffset : 0;
  const params = new URLSearchParams({
    limit: String(LIST_PAGE_SIZE),
    offset: String(offset),
    query: state.query,
  });
  const data = await fetchJson(`/api/realtime?${params.toString()}`);
  if (append) {
    appendUniquePosts(data.list || []);
  } else {
    state.posts = data.list || [];
  }
  applyPagination(data.pagination, state.posts.length);
  if (data.auth) state.auth = data.auth;
  state.status = data.status;
  state.stats = data.stats;
  renderAuth();
  renderStatus();
  renderList();
}

function buildArchiveParams({ offset = 0 } = {}) {
  const params = new URLSearchParams({
    sort: state.sort,
    limit: String(LIST_PAGE_SIZE),
    offset: String(offset),
    query: state.query,
  });
  const startTs = localDateToUnix(state.archiveStart, false);
  const endTs = localDateToUnix(state.archiveEnd, true);
  if (startTs) params.set("start", String(startTs));
  if (endTs) params.set("end", String(endTs));
  if (!startTs && !endTs && state.archiveMonth) params.set("month", state.archiveMonth);
  return params;
}

async function loadArchive({ append = false } = {}) {
  const offset = append ? state.pagination.nextOffset : 0;
  const params = buildArchiveParams({ offset });
  const data = await fetchJson(`/api/archive?${params.toString()}`);
  if (append) {
    appendUniquePosts(data.list || []);
  } else {
    state.posts = data.list || [];
  }
  applyPagination(data.pagination, state.posts.length);
  if (Array.isArray(data.months)) {
    state.archiveMonths = data.months;
    if (!state.archiveMonth && !hasArchiveRange() && data.months.length) {
      // Default to the newest month so users get a useful first paint.
      state.archiveMonth = data.months[data.months.length - 1].key;
      renderMonthPicker();
      const next = await fetchJson(`/api/archive?${buildArchiveParams({ offset: 0 }).toString()}`);
      state.posts = next.list || [];
      applyPagination(next.pagination, state.posts.length);
      if (next.auth) state.auth = next.auth;
      state.status = next.status;
      state.stats = next.stats;
      renderAuth();
      renderStatus();
      renderMonthPicker();
      renderList();
      return;
    }
  }
  if (data.auth) state.auth = data.auth;
  state.status = data.status;
  state.stats = data.stats;
  renderAuth();
  renderStatus();
  renderMonthPicker();
  renderList();
}

async function loadDeleted({ append = false } = {}) {
  const offset = append ? state.pagination.nextOffset : 0;
  const params = new URLSearchParams({
    limit: String(LIST_PAGE_SIZE),
    offset: String(offset),
    query: state.query,
  });
  const data = await fetchJson(`/api/deleted?${params.toString()}`);
  if (append) {
    appendUniquePosts(data.list || []);
  } else {
    state.posts = data.list || [];
  }
  applyPagination(data.pagination, state.posts.length);
  state.deleted = data.deleted || null;
  if (data.auth) state.auth = data.auth;
  state.status = data.status;
  state.stats = data.stats;
  renderAuth();
  renderStatus();
  renderMonthPicker();
  renderList();
}

async function loadCurrentList({ append = false } = {}) {
  try {
    if (state.mode === "realtime") {
      await loadRealtime({ append });
      return;
    }
    if (state.mode === "archive") {
      await loadArchive({ append });
      return;
    }
    if (state.mode === "deleted") {
      await loadDeleted({ append });
      return;
    }
    await loadHot();
  } finally {
    scheduleListRefresh();
  }
}

async function loadMoreCurrentList() {
  if (state.mode === "hot" || state.pagination.loadingMore || !state.pagination.hasMore) return;
  state.pagination.loadingMore = true;
  renderList();
  try {
    await loadCurrentList({ append: true });
  } catch (error) {
    state.pagination.loadingMore = false;
    state.status = {
      ...(state.status || {}),
      lastError: error instanceof Error ? error.message : String(error),
    };
    renderStatus();
    renderList();
  }
}

async function loadCurrentListSafely() {
  if (listAutoLoading) return;
  listAutoLoading = true;
  try {
    await loadCurrentList();
  } catch (error) {
    state.status = {
      ...(state.status || {}),
      lastError: error instanceof Error ? error.message : String(error),
    };
    renderStatus();
  } finally {
    listAutoLoading = false;
  }
}

async function loadStatusSafely() {
  if (statusAutoLoading) return;
  statusAutoLoading = true;
  try {
    await loadStatus();
  } catch (error) {
    state.status = {
      ...(state.status || {}),
      lastError: error instanceof Error ? error.message : String(error),
    };
    renderStatus();
  } finally {
    statusAutoLoading = false;
  }
}

async function loadPost(pid, seedPost = null) {
  const requestedPid = String(pid);
  if (seedPost) {
    openDetail({ ...seedPost, detailLoading: true });
  }
  try {
    const data = await fetchJson(`/api/post/${encodeURIComponent(pid)}`);
    if (
      seedPost &&
      (nodes.detailDialog.hidden || String(state.detailPost?.pid) !== requestedPid)
    ) {
      return;
    }
    openDetail({ ...data.post, images: data.images || [] });
  } catch (error) {
    if (!seedPost) throw error;
    if (nodes.detailDialog.hidden || String(state.detailPost?.pid) !== requestedPid) return;
    openDetail({
      ...seedPost,
      detailLoading: false,
      detailError: error instanceof Error ? error.message : String(error),
    });
  }
}

function setActiveButtons(selector, key, value) {
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("active", button.dataset[key] === value);
  });
}

const SCOPE_STATIC_TEXT = {
  realtime: "近 14 天 · 固定",
  deleted: "近 60 天 · 固定",
};

function updateListModeButtons() {
  document.querySelectorAll("[data-window]").forEach((button) => {
    button.classList.toggle(
      "active",
      state.mode === "hot" && button.dataset.window === state.window,
    );
  });
  nodes.realtimeBtn.classList.toggle("active", state.mode === "realtime");
  nodes.hotBtn.classList.toggle("active", state.mode === "hot");
  nodes.archiveBtn.classList.toggle("active", state.mode === "archive");
  nodes.deletedBtn.classList.toggle("active", state.mode === "deleted");

  // 时间槽：热榜=周期 segmented；历史库=月份/日期；实时/被删帖=固定文案
  const isArchive = state.mode === "archive";
  if (nodes.windowControl) nodes.windowControl.hidden = state.mode !== "hot";
  if (nodes.monthField) nodes.monthField.hidden = !isArchive;
  if (nodes.rangeField) nodes.rangeField.hidden = !isArchive;
  const scopeText = SCOPE_STATIC_TEXT[state.mode] || "";
  if (nodes.scopeStatic) {
    nodes.scopeStatic.textContent = scopeText;
    nodes.scopeStatic.hidden = !scopeText;
  }

  // 排序槽：热榜/历史库=回复/关注；实时/被删帖=固定文案
  const sortable = state.mode === "hot" || state.mode === "archive";
  if (nodes.sortControl) nodes.sortControl.hidden = !sortable;
  if (nodes.sortStatic) nodes.sortStatic.hidden = sortable;
  setActiveButtons("[data-sort]", "sort", state.sort);
}

function enterMode(mode) {
  const changed = state.mode !== mode;
  state.mode = mode;
  updateListModeButtons();
  renderMonthPicker();
  if (changed) {
    state.posts = [];
    resetPagination();
    renderList();
  }
}

document.querySelectorAll("[data-window]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.window = button.dataset.window;
    enterMode("hot");
    await loadCurrentList();
  });
});

nodes.realtimeBtn.addEventListener("click", async () => {
  enterMode("realtime");
  await loadCurrentList();
});

nodes.hotBtn.addEventListener("click", async () => {
  enterMode("hot");
  await loadCurrentList();
});

nodes.archiveBtn.addEventListener("click", async () => {
  enterMode("archive");
  await loadCurrentList();
});

nodes.deletedBtn.addEventListener("click", async () => {
  enterMode("deleted");
  await loadCurrentList();
});

nodes.monthSelect?.addEventListener("change", async (event) => {
  state.archiveMonth = event.target.value || "";
  if (state.archiveMonth) {
    state.archiveStart = "";
    state.archiveEnd = "";
  }
  resetPagination();
  renderMonthPicker();
  await loadCurrentListSafely();
});

function handleRangeInputChange() {
  const startValue = nodes.rangeStart?.value || "";
  const endValue = nodes.rangeEnd?.value || "";
  if (startValue && endValue && startValue > endValue) {
    // Keep the picker visually consistent; let the user fix it.
    return;
  }
  state.archiveStart = startValue;
  state.archiveEnd = endValue;
  if (startValue || endValue) state.archiveMonth = "";
  resetPagination();
  renderMonthPicker();
  loadCurrentListSafely();
}

nodes.rangeStart?.addEventListener("change", handleRangeInputChange);
nodes.rangeEnd?.addEventListener("change", handleRangeInputChange);
nodes.rangeClear?.addEventListener("click", async () => {
  state.archiveStart = "";
  state.archiveEnd = "";
  if (nodes.rangeStart) nodes.rangeStart.value = "";
  if (nodes.rangeEnd) nodes.rangeEnd.value = "";
  resetPagination();
  renderMonthPicker();
  await loadCurrentListSafely();
});

document.querySelectorAll("[data-sort]").forEach((button) => {
  button.addEventListener("click", async () => {
    state.sort = button.dataset.sort;
    resetPagination();
    updateListModeButtons();
    await loadCurrentList();
  });
});

let searchTimer;
nodes.searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    state.query = nodes.searchInput.value;
    resetPagination();
    await loadCurrentList();
  }, 220);
});

nodes.loadMoreBtn?.addEventListener("click", loadMoreCurrentList);

nodes.postList.addEventListener("click", async (event) => {
  if (event.target.closest("a")) return;
  const row = event.target.closest(".entry");
  const seedPost = state.posts.find((post) => String(post.pid) === String(row?.dataset.pid));
  if (row?.dataset.pid) await loadPost(row.dataset.pid, seedPost);
});

nodes.postList.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest(".entry");
  if (!row?.dataset.pid) return;
  event.preventDefault();
  const seedPost = state.posts.find((post) => String(post.pid) === String(row.dataset.pid));
  await loadPost(row.dataset.pid, seedPost);
});

nodes.detailClose.addEventListener("click", closeDetail);
nodes.detailDialog.addEventListener("click", (event) => {
  if (event.target === nodes.detailDialog) closeDetail();
});

// 点击详情里的图片 → 打开灯箱
nodes.detailContent?.addEventListener("click", (event) => {
  const trigger = event.target.closest(".detail-image");
  if (!trigger) return;
  const index = Number(trigger.dataset.imageIndex || 0);
  const images = Array.isArray(state.detailPost?.images) ? state.detailPost.images : [];
  if (images.length) openLightbox(images, index);
});

nodes.lightboxClose?.addEventListener("click", closeLightbox);
nodes.lightbox?.addEventListener("click", (event) => {
  if (event.target === nodes.lightbox) closeLightbox();
});
nodes.lightboxPrev?.addEventListener("click", () => stepLightbox(-1));
nodes.lightboxNext?.addEventListener("click", () => stepLightbox(1));

document.addEventListener("keydown", (event) => {
  if (nodes.lightbox && !nodes.lightbox.hidden) {
    if (event.key === "Escape") closeLightbox();
    else if (event.key === "ArrowLeft") stepLightbox(-1);
    else if (event.key === "ArrowRight") stepLightbox(1);
    return;
  }
  if (event.key === "Escape" && !nodes.detailDialog.hidden) closeDetail();
});

// ---- 昼夜主题切换 ----
const THEME_KEY = "treehole-theme";

function syncThemeToggle(theme) {
  const btn = nodes.themeToggle;
  if (!btn) return;
  const isDay = theme === "day";
  const icon = btn.querySelector(".theme-toggle-icon");
  const label = btn.querySelector(".theme-toggle-label");
  if (icon) icon.textContent = isDay ? "☀" : "☾";
  if (label) label.textContent = isDay ? "昼" : "夜";
  btn.setAttribute("aria-pressed", isDay ? "true" : "false");
}

function applyTheme(theme) {
  const next = theme === "day" ? "day" : "night";
  document.documentElement.dataset.theme = next;
  syncThemeToggle(next);
}

nodes.themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* localStorage 不可用时忽略持久化 */
  }
});

// 头部内联脚本已在首帧前设定主题，这里同步按钮显示
syncThemeToggle(document.documentElement.dataset.theme === "day" ? "day" : "night");

await loadAuth();
await loadStatusSafely();
updateListModeButtons();
await loadCurrentList();
window.setInterval(loadStatusSafely, STATUS_REFRESH_MS);
