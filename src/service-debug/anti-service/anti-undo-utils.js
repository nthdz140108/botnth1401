function normalizeId(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

export function extractPhotoUrl(content) {
  if (!content) return null;

  if (typeof content === "string") {
    const trimmed = content.trim();
    if (/^https?:\/\/\S+/i.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        return extractPhotoUrl(parsed);
      } catch {}
    }
    return null;
  }

  if (typeof content !== "object") return null;

  const urlKeys = [
    "href",
    "hdUrl",
    "oriUrl",
    "normalUrl",
    "url",
    "rawUrl",
    "thumbUrl",
    "thumb",
    "previewUrl",
    "attachUrl",
    "originUrl",
  ];

  for (const key of urlKeys) {
    const val = content[key];
    if (typeof val === "string" && /^https?:\/\/\S+/i.test(val.trim())) {
      return val.trim();
    }
  }

  if (typeof content.params === "string" && content.params.trim().startsWith("{")) {
    try {
      const parsedParams = JSON.parse(content.params);
      const urlFromParams = extractPhotoUrl(parsedParams);
      if (urlFromParams) return urlFromParams;
    } catch {}
  }

  return null;
}

export function findUndoOriginalMessage(cache, undoEvent) {
  let contentObj = undoEvent?.data?.content ?? undoEvent?.content;
  if (typeof contentObj === "string" && contentObj.trim().startsWith("{")) {
    try {
      contentObj = JSON.parse(contentObj);
    } catch {}
  }

  // Tra cứu ưu tiên bằng ID của tin nhắn gốc trong content của sự kiện thu hồi
  const contentCandidateIds = (contentObj && typeof contentObj === "object") ? [
    normalizeId(contentObj.cliMsgId),
    normalizeId(contentObj.msgId),
    normalizeId(contentObj.globalMsgId),
    normalizeId(contentObj.id),
  ].filter(Boolean) : (typeof contentObj === "string" && !contentObj.includes(" ") ? [normalizeId(contentObj)] : []);

  // Chỉ fallback sang các trường ngoài khi content không chứa ID tin gốc
  const fallbackCandidateIds = [
    normalizeId(undoEvent?.data?.cliMsgId),
    normalizeId(undoEvent?.data?.msgId),
    normalizeId(undoEvent?.data?.globalMsgId),
    normalizeId(undoEvent?.cliMsgId),
    normalizeId(undoEvent?.msgId),
    normalizeId(undoEvent?.globalMsgId),
  ].filter(Boolean);

  const candidateIds = contentCandidateIds.length > 0 ? contentCandidateIds : fallbackCandidateIds;

  if (candidateIds.length === 0) {
    return { message: null, reason: "missing-cli-msg-id" };
  }

  let originalMessage = null;

  // 1. Tra cứu trực tiếp trên MessageCacheStore instance (getByMsgId có O(1) in-memory index)
  if (cache && typeof cache.getByMsgId === "function") {
    for (const id of candidateIds) {
      const entry = cache.getByMsgId(id);
      if (entry) {
        originalMessage = entry;
        break;
      }
    }
  }

  // 2. Tra cứu trực tiếp theo key nếu cache là object/Map
  if (!originalMessage && cache) {
    for (const id of candidateIds) {
      if (typeof cache.get === "function") {
        const entry = cache.get(id);
        if (entry) {
          originalMessage = entry;
          break;
        }
      } else if (cache[id]) {
        originalMessage = cache[id];
        break;
      }
    }
  }

  // 3. Dự phòng cho non-store cache (quét entries chỉ khi không phải MessageCacheStore)
  if (!originalMessage && cache && typeof cache.getByMsgId !== "function") {
    const entries = typeof cache.values === "function"
      ? Array.from(cache.values())
      : Object.values(cache);

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const entryCli = normalizeId(entry.cliMsgId);
      const entryMsg = normalizeId(entry.msgId);
      const entryGlobal = normalizeId(entry.globalMsgId);
      if (
        candidateIds.includes(entryCli) ||
        candidateIds.includes(entryMsg) ||
        candidateIds.includes(entryGlobal)
      ) {
        originalMessage = entry;
        break;
      }
    }
  }

  if (!originalMessage) {
    return { message: null, reason: "cache-miss" };
  }

  if (originalMessage.isUndo) {
    return { message: null, reason: "already-restored" };
  }

  // Chỉ chấp nhận bản ghi đúng nhóm và đúng người gửi
  const eventThreadId = normalizeId(undoEvent?.data?.idTo || undoEvent?.threadId || undoEvent?.idTo);
  const cachedThreadId = normalizeId(originalMessage.threadId || originalMessage.idTo);
  if (!eventThreadId || !cachedThreadId || cachedThreadId !== eventThreadId) {
    return { message: null, reason: "thread-mismatch" };
  }

  const eventSenderId = normalizeId(undoEvent?.data?.uidFrom || undoEvent?.uidFrom || undoEvent?.senderId);
  const cachedSenderId = normalizeId(originalMessage.uidFrom || originalMessage.senderId);
  if (!eventSenderId || !cachedSenderId || cachedSenderId !== eventSenderId) {
    return { message: null, reason: "sender-mismatch" };
  }

  return { message: originalMessage, reason: null };
}
