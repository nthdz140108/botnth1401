import { LRUCache } from "lru-cache";

export const stickerCache = new LRUCache({
  max: 2000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

export function isValidMediaUrl(url) {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function extractUrlFromStickerDetail(detail) {
  if (!detail) return { mediaUrl: null, thumbUrl: null };
  const d = Array.isArray(detail) ? detail[0] : detail;
  if (!d || typeof d !== "object") return { mediaUrl: null, thumbUrl: null };

  const candidateMediaKeys = [
    "animationUrl",
    "spriteUrl",
    "url",
    "staticUrl",
    "mediaUrl",
    "href",
    "normalUrl",
  ];
  const candidateThumbKeys = [
    "thumb",
    "thumbUrl",
    "previewUrl",
    "staticUrl",
  ];

  let mediaUrl = null;
  let thumbUrl = null;

  for (const k of candidateMediaKeys) {
    if (isValidMediaUrl(d[k])) {
      mediaUrl = d[k];
      break;
    }
  }

  for (const k of candidateThumbKeys) {
    if (isValidMediaUrl(d[k])) {
      thumbUrl = d[k];
      break;
    }
  }

  // Support nested stickers array if present (e.g., sticker pack response)
  if (!mediaUrl && Array.isArray(d.stickers) && d.stickers.length > 0) {
    return extractUrlFromStickerDetail(d.stickers[0]);
  }
  if (!mediaUrl && d.data && typeof d.data === "object") {
    return extractUrlFromStickerDetail(d.data);
  }

  return { mediaUrl, thumbUrl };
}

export async function resolveStickerMedia(api, stickerId) {
  if (!stickerId) return { mediaUrl: null, thumbUrl: null, isDynamic: false };

  const cacheKey = String(stickerId);
  const cached = stickerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  if (typeof api?.getStickersDetail !== "function") {
    return { mediaUrl: null, thumbUrl: null, isDynamic: false };
  }

  try {
    const res = await api.getStickersDetail(stickerId);
    const { mediaUrl, thumbUrl } = extractUrlFromStickerDetail(res);
    const isDynamic = Boolean(
      mediaUrl && (/\.webp(\?|$)/i.test(mediaUrl) || /\.gif(\?|$)/i.test(mediaUrl))
    );
    const resolved = { mediaUrl, thumbUrl, isDynamic };
    if (mediaUrl || thumbUrl) {
      stickerCache.set(cacheKey, resolved);
    }
    return resolved;
  } catch (err) {
    console.warn(`[anti-nude] Không lấy được sticker detail cho ID ${stickerId}:`, err?.message || err);
    return { mediaUrl: null, thumbUrl: null, isDynamic: false };
  }
}

export function parseMessageContent(content) {
  if (!content) return {};
  if (typeof content === "object") return content;
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return { text: trimmed };
      }
    }
    if (/^https?:\/\/\S+/i.test(trimmed)) {
      return { href: trimmed };
    }
    return { text: trimmed };
  }
  return {};
}

export async function extractMediaCandidate(api, message) {
  const data = message?.data || {};
  const rawMsgType = data.msgType ?? message?.msgType;
  const msgType = typeof rawMsgType === "number" ? String(rawMsgType) : String(rawMsgType || "");
  const content = parseMessageContent(data.content);

  // Check if params has nested payload (common in Zalo video/photo/file)
  let paramsObj = {};
  if (typeof content.params === "string" && content.params.trim().startsWith("{")) {
    try {
      paramsObj = JSON.parse(content.params);
    } catch {}
  } else if (content.params && typeof content.params === "object") {
    paramsObj = content.params;
  }

  const isSticker =
    msgType === "chat.sticker" ||
    msgType === "36" ||
    Boolean(content.id || content.catId || content.stickerId);

  const isGif =
    msgType === "chat.gif" ||
    msgType === "49" ||
    content.action === "recommend.gif" ||
    /\.gif(\?|$)/i.test(String(content.href || content.normalUrl || ""));

  const isVideo =
    msgType === "chat.video.msg" ||
    msgType === "44" ||
    /\.mp4(\?|$)/i.test(String(content.href || content.normalUrl || paramsObj.href || ""));

  const isPhoto =
    msgType === "chat.photo" ||
    msgType === "32" ||
    msgType === "chat.picture" ||
    /\.(jpe?g|png|bmp)(\?|$)/i.test(String(content.href || content.normalUrl || ""));

  let mediaType = "unknown";
  let mediaUrl = null;
  let thumbUrl = null;
  let isDynamic = false;
  let stickerId = null;

  if (isSticker) {
    mediaType = "sticker";
    stickerId = content.id || content.stickerId;

    // Check if sticker already has direct media URLs in payload
    const directCandidateKeys = ["animationUrl", "spriteUrl", "url", "staticUrl", "href", "mediaUrl"];
    for (const k of directCandidateKeys) {
      if (isValidMediaUrl(content[k])) {
        mediaUrl = content[k];
        break;
      }
    }
    const directThumbKeys = ["thumb", "thumbUrl", "previewUrl", "staticUrl"];
    for (const k of directThumbKeys) {
      if (isValidMediaUrl(content[k])) {
        thumbUrl = content[k];
        break;
      }
    }

    if (!mediaUrl && stickerId) {
      const resolved = await resolveStickerMedia(api, stickerId);
      mediaUrl = resolved.mediaUrl;
      thumbUrl = thumbUrl || resolved.thumbUrl;
      isDynamic = resolved.isDynamic;
    } else {
      isDynamic = Boolean(mediaUrl && (/\.webp(\?|$)/i.test(mediaUrl) || /\.gif(\?|$)/i.test(mediaUrl)));
    }
  } else if (isGif) {
    mediaType = "gif";
    isDynamic = true;
    mediaUrl = [content.href, content.normalUrl, content.url, paramsObj.href, paramsObj.url]
      .find(isValidMediaUrl) || null;
    thumbUrl = [content.thumb, content.thumbUrl, content.previewUrl]
      .find(isValidMediaUrl) || null;
  } else if (isVideo) {
    mediaType = "video";
    isDynamic = true;
    mediaUrl = [content.href, content.normalUrl, content.url, content.videoUrl, paramsObj.href, paramsObj.url]
      .find(isValidMediaUrl) || null;
    thumbUrl = [content.thumb, content.thumbUrl, paramsObj.thumb, paramsObj.thumbUrl]
      .find(isValidMediaUrl) || null;
  } else if (isPhoto) {
    mediaType = "photo";
    isDynamic = false;
    mediaUrl = [content.href, content.hdUrl, content.oriUrl, content.normalUrl, content.url, content.rawUrl, paramsObj.href, paramsObj.url]
      .find(isValidMediaUrl) || null;
    thumbUrl = [content.thumb, content.thumbUrl, content.previewUrl, paramsObj.thumb]
      .find(isValidMediaUrl) || null;
  } else {
    // Generic fallback: check if any valid URL in content looks like media
    const anyUrl = [content.href, content.normalUrl, content.url, paramsObj.href]
      .find(isValidMediaUrl);
    if (anyUrl) {
      if (/\.(mp4|mov|webm)(\?|$)/i.test(anyUrl)) {
        mediaType = "video";
        isDynamic = true;
      } else if (/\.gif(\?|$)/i.test(anyUrl)) {
        mediaType = "gif";
        isDynamic = true;
      } else if (/\.webp(\?|$)/i.test(anyUrl)) {
        mediaType = "sticker";
        isDynamic = true;
      } else {
        mediaType = "photo";
        isDynamic = false;
      }
      mediaUrl = anyUrl;
      thumbUrl = [content.thumb, content.thumbUrl].find(isValidMediaUrl) || null;
    }
  }

  const hasMedia = Boolean(mediaUrl || (thumbUrl && isValidMediaUrl(thumbUrl)));

  return {
    hasMedia,
    mediaType,
    mediaUrl,
    thumbUrl,
    isDynamic,
    stickerId,
  };
}
