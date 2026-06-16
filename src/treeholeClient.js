const API_BASE = "https://treehole.pku.edu.cn/chapi";
const WEB_BASE = "https://treehole.pku.edu.cn/ch/web";
const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalNumberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tagNames(post) {
  const fromInfo = Array.isArray(post.tags_info) ? post.tags_info : [];
  const fromList = Array.isArray(post.tags_list) ? post.tags_list : [];
  return [...fromInfo, ...fromList]
    .map((tag) => tag?.name || tag?.tag_name || tag?.label_name || tag?.title)
    .filter(Boolean);
}

function textValue(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function mediaIds(post) {
  if (Array.isArray(post.media_ids)) return post.media_ids.map(String).filter(Boolean);
  if (typeof post.media_ids === "string") return post.media_ids.split(",").filter(Boolean);
  if (Array.isArray(post.media)) return post.media.map((media) => media?.id || media?.media_id).filter(Boolean);
  return [];
}

const COMMENT_ARRAY_KEYS = new Set([
  "comments",
  "comment",
  "comment_list",
  "comments_list",
  "comment_stream",
  "reply_list",
  "replies",
  "floors",
  "floor_list",
]);

function rawCommentArrays(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 3) return [];
  const arrays = [];
  for (const [key, child] of Object.entries(value)) {
    if (COMMENT_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      arrays.push(child);
      continue;
    }
    if (
      child &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      (key === "data" || key === "comment_data" || key === "comments_data")
    ) {
      arrays.push(...rawCommentArrays(child, depth + 1));
    }
  }
  return arrays;
}

function normalizeComment(raw, index) {
  const timestamp = numberValue(raw.timestamp ?? raw.create_time ?? raw.created_at);
  const authorTag = textValue(
    raw.name_tag ??
      raw.author_tag ??
      raw.user_tag ??
      raw.sender_tag ??
      raw.identity_info?.name ??
      raw.identity_info?.title,
  );
  const isHoleOwner =
    raw.is_lz === 1 ||
    raw.is_lz === true ||
    raw.is_author === 1 ||
    raw.is_author === true ||
    raw.is_owner === 1 ||
    raw.is_owner === true;
  return {
    cid: raw.cid || raw.comment_id || raw.id || null,
    floor: numberValue(raw.floor ?? raw.floor_num ?? raw.index, index + 1),
    text: textValue(raw.text ?? raw.content ?? raw.comment ?? raw.message),
    timestamp,
    praise: numberValue(raw.praise_num_show ?? raw.praise_num ?? raw.likenum),
    replyTo: raw.reply_to || raw.replyTo || raw.comment_id || null,
    authorTag,
    authorLabel: isHoleOwner ? "洞主" : authorTag || "匿名用户",
    isHoleOwner,
    identityShow: numberValue(raw.identity_show),
    identityType: textValue(raw.identity_type),
    isFolded: raw.fold === 1 || raw.user_fold === 1 || raw.is_fold === 1,
  };
}

function normalizeComments(rawPost) {
  return rawCommentArrays(rawPost)
    .flatMap((comments) => comments.map(normalizeComment))
    .filter((comment) => comment.text || comment.cid || comment.timestamp);
}

export async function fetchHolePage(auth, { page, limit, commentLimit = 0 }) {
  const url = new URL(`${API_BASE}/api/v3/hole/list_comments`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("comment_limit", String(commentLimit));
  url.searchParams.set("comment_stream", "1");

  const json = await fetchTreeholeJson(auth, url);
  if (json.code !== 20000) {
    throw new Error(json.message || `树洞接口返回 code=${json.code}`);
  }

  const data = json.data || {};
  return {
    list: Array.isArray(data.list) ? data.list : [],
    total: numberValue(data.total),
  };
}

async function fetchTreeholeJson(auth, url) {
  const timeoutMs = envNumber("TREEHOLE_FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        uuid: auth.uuid,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`树洞接口超时 ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`树洞接口 HTTP ${response.status}`);
  }

  return response.json();
}

export async function fetchHolePresence(auth, pid) {
  const url = new URL(`${API_BASE}/api/v3/hole/get`);
  url.searchParams.set("pid", String(pid));

  const json = await fetchTreeholeJson(auth, url);
  if (json.code === 20000) return { exists: true, deleted: false };
  if (json.code === 41001) {
    return {
      exists: false,
      deleted: true,
      message: json.message || "树洞不存在",
    };
  }
  throw new Error(json.message || `树洞接口返回 code=${json.code}`);
}

export function normalizePost(raw) {
  const comments = normalizeComments(raw);
  const reply =
    optionalNumberValue(raw.reply) ??
    optionalNumberValue(raw.comment_count) ??
    optionalNumberValue(raw.reply_count) ??
    optionalNumberValue(raw.comment_total) ??
    comments.length;
  const follow = numberValue(raw.likenum);
  const praise = numberValue(raw.praise_num_show ?? raw.praise_num);
  const timestamp = numberValue(raw.timestamp);
  const ids = mediaIds(raw);
  const now = new Date().toISOString();
  const pid = numberValue(raw.pid);

  return {
    pid,
    text: textValue(raw.text),
    type: raw.type || "text",
    timestamp,
    reply,
    commentTotal: Math.max(reply, comments.length),
    follow,
    praise,
    tread: numberValue(raw.tread_num),
    hot: numberValue(raw.hot, timestamp),
    isTop: raw.is_top === 1,
    isFolded: raw.fold === 1 || raw.user_fold === 1 || raw.is_fold === 1,
    isFollowedByMe: raw.is_follow === 1,
    tags: tagNames(raw),
    mediaIds: ids,
    mediaCount: ids.length,
    kind: numberValue(raw.kind),
    comments,
    commentsFetchedAt: comments.length ? now : null,
    url: `${WEB_BASE}/pc/postDetail?pid=${pid}`,
    updatedAt: now,
  };
}
