const API_BASE = "https://treehole.pku.edu.cn/chapi";
const WEB_BASE = "https://treehole.pku.edu.cn/ch/web";

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function tagNames(post) {
  const fromInfo = Array.isArray(post.tags_info) ? post.tags_info : [];
  const fromList = Array.isArray(post.tags_list) ? post.tags_list : [];
  return [...fromInfo, ...fromList]
    .map((tag) => tag?.name || tag?.tag_name || tag?.label_name || tag?.title)
    .filter(Boolean);
}

export async function fetchHolePage(auth, { page, limit }) {
  const url = new URL(`${API_BASE}/api/v3/hole/list_comments`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("comment_limit", "0");
  url.searchParams.set("comment_stream", "1");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      uuid: auth.uuid,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`树洞接口 HTTP ${response.status}`);
  }

  const json = await response.json();
  if (json.code !== 20000) {
    throw new Error(json.message || `树洞接口返回 code=${json.code}`);
  }

  const data = json.data || {};
  return {
    list: Array.isArray(data.list) ? data.list : [],
    total: numberValue(data.total),
  };
}

export function normalizePost(raw) {
  const reply = numberValue(raw.reply ?? raw.comment_total);
  const follow = numberValue(raw.likenum);
  const praise = numberValue(raw.praise_num_show ?? raw.praise_num);
  const timestamp = numberValue(raw.timestamp);

  return {
    pid: numberValue(raw.pid),
    text: String(raw.text || ""),
    type: raw.type || "text",
    timestamp,
    reply,
    follow,
    praise,
    tread: numberValue(raw.tread_num),
    hot: numberValue(raw.hot, timestamp),
    isTop: raw.is_top === 1,
    isFolded: raw.fold === 1 || raw.user_fold === 1 || raw.is_fold === 1,
    isFollowedByMe: raw.is_follow === 1,
    tags: tagNames(raw),
    mediaCount: raw.media_ids ? String(raw.media_ids).split(",").filter(Boolean).length : 0,
    kind: numberValue(raw.kind),
    url: `${WEB_BASE}/pc/postDetail?pid=${numberValue(raw.pid)}`,
    updatedAt: new Date().toISOString(),
  };
}
