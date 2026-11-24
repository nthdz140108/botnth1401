const sessions = new Map();
const countdownCancels = new Map();
const PREFIX_TIMEOUT = 60 * 1000;
export const qrLoginAwaitingPrefix = sessions;

export const QR_LOGIN_STATES = Object.freeze({
  initializing: "initializing",
  waiting_scan: "waiting_scan",
  waiting_confirm: "waiting_confirm",
  awaiting_prefix: "awaiting_prefix",
  provisioning: "provisioning",
  starting: "starting",
  running: "running",
  failed: "failed",
  cancelled: "cancelled",
});

export function createQrLoginSession({ requesterUid, threadId, quotedMessageId, workspaceUid, allowedRequesterUids = [] }) {
  const sessionId = `${workspaceUid}:${requesterUid}:${Date.now()}`;
  const session = {
    sessionId,
    workspaceUid,
    requesterUid,
    allowedRequesterUids: [...new Set([requesterUid, ...allowedRequesterUids].filter(Boolean).map(String))],
    threadId,
    quotedMessageId: String(quotedMessageId || ""),
    state: QR_LOGIN_STATES.initializing,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

export function updateQrLoginSession(sessionId, patch) {
  const current = sessions.get(sessionId);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: Date.now() };
  sessions.set(sessionId, next);
  return next;
}

export function getQrLoginSession(sessionId) {
  return sessions.get(sessionId) || null;
}

export function removeQrLoginSession(sessionId) {
  sessions.delete(sessionId);
}

export function findAwaitingPrefixByBotUid(botUid) {
  for (const session of sessions.values()) {
    if (session.workspaceUid === botUid && session.state === QR_LOGIN_STATES.awaiting_prefix) {
      return session;
    }
  }
  return null;
}

export function setAwaitingPrefix(botUid, requesterUid, threadId, messageGlobalId, allowedRequesterUids = []) {
  const session = createQrLoginSession({
    requesterUid,
    threadId,
    quotedMessageId: messageGlobalId,
    workspaceUid: botUid,
    allowedRequesterUids,
  });
  session.state = QR_LOGIN_STATES.awaiting_prefix;
  session.updatedAt = Date.now();
  sessions.set(session.sessionId, session);
  return session;
}

export function getAwaitingPrefix(botUid) {
  return findAwaitingPrefixByBotUid(botUid);
}

export function extractQrLoginMessageId(response) {
  const message = Array.isArray(response?.message) ? response.message[0] : response?.message;
  const candidates = [
    response?.globalMsgId,
    response?.msgId,
    response?.data?.globalMsgId,
    response?.data?.msgId,
    message?.globalMsgId,
    message?.msgId,
    message?.data?.globalMsgId,
    message?.data?.msgId,
  ];
  const messageId = candidates.find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
  return messageId === undefined ? "" : String(messageId);
}

export function extractQrLoginQuotedMessageId(quote) {
  return extractQrLoginMessageId(quote);
}

export function findAwaitingPrefixByMessageId(messageGlobalId, requesterUid, threadId) {
  const quotedMessageId = String(messageGlobalId || "");
  const senderId = String(requesterUid || "");
  const targetThreadId = String(threadId || "");

  for (const session of sessions.values()) {
    if (
      session.state === QR_LOGIN_STATES.awaiting_prefix
      && (!session.quotedMessageId || session.quotedMessageId === quotedMessageId)
      && (session.allowedRequesterUids || [session.requesterUid])
        .some((allowedUid) => String(allowedUid) === senderId)
      && (!targetThreadId || String(session.threadId) === targetThreadId)
    ) {
      return session;
    }
  }
  return null;
}

import { completeInteractionCountdown } from "./interaction-countdown.js";

export function clearAwaitingPrefix(botUid) {
  clearPrefixCountdown(botUid);
  completeInteractionCountdown(`qr_prefix_${botUid}`);
  for (const [sessionId, session] of sessions.entries()) {
    if (session.workspaceUid === botUid) sessions.delete(sessionId);
  }
}

export function setPrefixCountdown(botUid, cancel) {
  clearPrefixCountdown(botUid);
  if (typeof cancel === "function") countdownCancels.set(String(botUid), cancel);
}

export function clearPrefixCountdown(botUid) {
  const key = String(botUid);
  const cancel = countdownCancels.get(key);
  if (cancel) cancel();
  countdownCancels.delete(key);
  completeInteractionCountdown(`qr_prefix_${botUid}`);
}

export const ALLOWED_PREFIX_SYMBOLS = "!?.#\$%&*-_+/";
export const VALID_PREFIX_REGEX = /^[!?./#\$%&*_\-+]{1,3}$/;

export function isValidPrefix(prefix) {
  if (typeof prefix !== "string") return false;
  const trimmed = prefix.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  return VALID_PREFIX_REGEX.test(trimmed);
}

export function extractPrefixFromReply(message) {
  if (!message || typeof message !== "object") {
    return { valid: false, prefix: null, reason: "empty_or_mention_only", error: "Tin nhắn không hợp lệ" };
  }

  let rawContent = "";
  if (typeof message?.data?.content === "object" && message?.data?.content !== null) {
    rawContent = message.data.content.title || message.data.content.text || message.data.content.msg || "";
  } else {
    rawContent = String(message?.data?.content || message?.content || "");
  }

  const mentions = Array.isArray(message?.data?.mentions)
    ? message.data.mentions
    : (Array.isArray(message?.mentions) ? message.mentions : []);

  let text = rawContent;
  if (mentions.length > 0 && typeof text === "string") {
    const validMentions = mentions
      .filter((m) => m && typeof m.pos === "number" && typeof m.len === "number" && m.pos >= 0 && m.len > 0)
      .sort((a, b) => b.pos - a.pos);

    for (const mention of validMentions) {
      if (mention.pos < text.length) {
        const end = Math.min(text.length, mention.pos + mention.len);
        text = text.slice(0, mention.pos) + text.slice(end);
      }
    }
  }

  const trimmed = text.trim();

  if (!trimmed || trimmed.length === 0) {
    return {
      valid: false,
      prefix: null,
      reason: "empty_or_mention_only",
      error: "Prefix không được rỗng hoặc chỉ chứa mention",
    };
  }

  if (/\s/.test(trimmed)) {
    return {
      valid: false,
      prefix: null,
      reason: "contains_whitespace",
      error: "Prefix không được chứa khoảng trắng",
    };
  }

  if (trimmed.length > 3) {
    return {
      valid: false,
      prefix: null,
      reason: "too_long",
      error: "Prefix tối đa 3 ký tự",
    };
  }

  if (!VALID_PREFIX_REGEX.test(trimmed)) {
    return {
      valid: false,
      prefix: null,
      reason: "invalid_characters",
      error: "Prefix chỉ chấp nhận các ký hiệu lệnh (!, ?, ., /, #, $, %, &, *, -, _, +)",
    };
  }

  return {
    valid: true,
    prefix: trimmed,
    reason: null,
    error: null,
  };
}

export function isExpired(entry) {
  if (!entry) return true;
  return Date.now() - entry.updatedAt > PREFIX_TIMEOUT;
}

export function cleanupExpired() {
  for (const [sessionId, session] of sessions.entries()) {
    if (isExpired(session)) sessions.delete(sessionId);
  }
}

