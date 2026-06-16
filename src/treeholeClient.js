const API_BASE = "https://treehole.pku.edu.cn/chapi";
const WEB_BASE = "https://treehole.pku.edu.cn/ch/web";
const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;

// 树洞图片二进制端点（与官方 web 前端一致）：新帖按 media_id 取，老帖按 pid 取。
// 详见 normalizePost 产出的 imageSources。可用 TREEHOLE_IMAGE_BASE 覆盖。
const DEFAULT_IMAGE_BASE = `${API_BASE}/api/v3/media/getMediaBinary`;
const DEFAULT_IMAGE_FETCH_TIMEOUT_MS = 30 * 1000;
const DEFAULT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

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

// 解析一条帖子的图片来源，镜像官方 web 前端逻辑：
// - type=image 且有 media_ids：每个 media_id 一张图，按 id 取（新帖）。
// - type=image 但无 media_ids：单张首图，按 pid 取（老帖，isOld）。
// 返回 [{ key, index, by:"id"|"pid", ref }]，key 在帖内唯一、可作文件名片段。
function imageSourcesFor(type, pid, ids) {
  const isImagePost = type === "image";
  if (!isImagePost && (!ids || ids.length === 0)) return [];
  if (ids && ids.length) {
    return ids.map((ref, index) => ({
      key: String(ref),
      index,
      by: "id",
      ref: String(ref),
    }));
  }
  if (!isImagePost) return [];
  const numericPid = numberValue(pid);
  if (!numericPid) return [];
  return [{ key: `p${numericPid}`, index: 0, by: "pid", ref: String(numericPid) }];
}

// 给已归一化 / 已缓存的帖子（含 type / pid / mediaIds）解析图片来源。
// 供 normalizePost 与 media-scan 回填共用。
export function imageSourcesForPost(post) {
  if (!post) return [];
  let ids = [];
  if (Array.isArray(post.mediaIds)) ids = post.mediaIds.map(String).filter(Boolean);
  else if (typeof post.mediaIds === "string") ids = post.mediaIds.split(",").filter(Boolean);
  else if (Array.isArray(post.media_ids)) ids = post.media_ids.map(String).filter(Boolean);
  else if (typeof post.media_ids === "string") ids = post.media_ids.split(",").filter(Boolean);
  return imageSourcesFor(post.type || "text", post.pid, ids);
}

// 把一个图片来源拼成可下载的真实 URL。
export function imageFetchUrl(source, base = process.env.TREEHOLE_IMAGE_BASE || DEFAULT_IMAGE_BASE) {
  const url = new URL(base);
  url.searchParams.set(source.by === "pid" ? "pid" : "id", String(source.ref));
  return url.toString();
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

function extensionForImage(contentType, buffer) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpeg";
  // 回退到魔数嗅探，避免依赖 content-type。
  if (buffer && buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return "gif";
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
    if (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "webp";
    }
  }
  return null;
}

// 下载一张树洞图片到内存 Buffer。复用现有鉴权/超时风格；
// 校验响应确为图片、且不超过上限，否则抛错（由归档器记录并跳过）。
export async function fetchImageBuffer(auth, source, options = {}) {
  const base = options.base || process.env.TREEHOLE_IMAGE_BASE || DEFAULT_IMAGE_BASE;
  const timeoutMs = envNumber("TREEHOLE_IMAGE_FETCH_TIMEOUT_MS", DEFAULT_IMAGE_FETCH_TIMEOUT_MS);
  const maxBytes =
    Number(options.maxBytes) > 0
      ? Number(options.maxBytes)
      : envNumber("TREEHOLE_IMAGE_MAX_BYTES", DEFAULT_IMAGE_MAX_BYTES);
  const url = imageFetchUrl(source, base);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        uuid: auth.uuid,
      },
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`图片下载超时 ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`图片接口 HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (/json|text\/html/i.test(contentType)) {
    // 树洞用 200 + JSON 信封表达“图片无法找到”等错误。
    let message = "图片不可用";
    try {
      const body = await response.json();
      message = body?.message || message;
    } catch {
      /* 忽略解析失败 */
    }
    throw new Error(message);
  }

  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength && declaredLength > maxBytes) {
    throw new Error(`图片过大 ${declaredLength} > ${maxBytes}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new Error("图片为空");
  }
  if (buffer.length > maxBytes) {
    throw new Error(`图片过大 ${buffer.length} > ${maxBytes}`);
  }

  const ext = extensionForImage(contentType, buffer);
  if (!ext) {
    throw new Error(`非图片内容（content-type=${contentType || "未知"}）`);
  }

  return { buffer, ext, bytes: buffer.length, contentType, url };
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
  const imageSources = imageSourcesForPost({ type: raw.type || "text", pid, mediaIds: ids });

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
    mediaCount: imageSources.length || ids.length,
    imageSources,
    kind: numberValue(raw.kind),
    comments,
    commentsFetchedAt: comments.length ? now : null,
    url: `${WEB_BASE}/pc/postDetail?pid=${pid}`,
    updatedAt: now,
  };
}
