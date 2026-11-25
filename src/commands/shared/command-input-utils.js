import { MessageType } from "../../api-zalo/models/Message.js";
import { removeMention } from "../../utils/format-util.js";

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function safeThreadType(message, fallback = MessageType.GroupMessage) {
  if (message?.type !== undefined && message?.type !== null) {
    return message.type;
  }
  return fallback;
}

export function getRawMessageText(message) {
  const raw = message?.data?.content;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw.title === "string") return raw.title;
  return "";
}

export function extractCommandBody(message, prefix = "", aliasCommand = "") {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return "";

  const normalizedPrefix = String(prefix ?? "");
  const normalizedAlias = String(aliasCommand ?? "").trim();

  if (normalizedAlias) {
    const aliasTokens = normalizedAlias.split(/\s+/).map(escapeRegExp).join("\\s+");
    const pattern = new RegExp(
      `^\\s*${escapeRegExp(normalizedPrefix)}\\s*${aliasTokens}(?:[\\s_]+|$)`,
      "i"
    );
    if (pattern.test(cleaned)) {
      return cleaned.replace(pattern, "").trim();
    }
  }

  if (normalizedPrefix) {
    const fallbackPattern = new RegExp(
      `^\\s*${escapeRegExp(normalizedPrefix)}\\s*\\S+(?:[\\s_]+|$)`,
      "i"
    );
    if (fallbackPattern.test(cleaned)) {
      return cleaned.replace(fallbackPattern, "").trim();
    }
  }

  const parts = cleaned.trim().split(/\s+/);
  return parts.slice(1).join(" ").trim();
}

export function extractCleanArgs(message, prefix = "", aliasCommand = "") {
  const body = extractCommandBody(message, prefix, aliasCommand);
  if (!body) return [];
  return body.split(/\s+/).filter(Boolean);
}

export function getQuoteData(message) {
  return message?.data?.quote || message?.quote || message?.data?.reply || null;
}

export function getQuotedUid(message) {
  const quote = getQuoteData(message);
  if (!quote || typeof quote !== "object") return "";
  const candidate = quote.uidFrom ?? quote.ownerId ?? quote.senderId ?? quote.fromD ?? "";
  return String(candidate || "").trim();
}

export function getQuotedText(message) {
  const quote = getQuoteData(message);
  if (!quote || typeof quote !== "object") return "";
  if (typeof quote.msg === "string" && quote.msg.trim()) return quote.msg.trim();
  if (typeof quote.content === "string" && quote.content.trim()) return quote.content.trim();
  if (quote.attach) {
    try {
      const parsed = typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
      if (typeof parsed?.title === "string" && parsed.title.trim()) return parsed.title.trim();
      if (typeof parsed?.description === "string" && parsed.description.trim()) return parsed.description.trim();
    } catch {}
  }
  return "";
}

export function resolveTargetUsers(message, rawArgs = []) {
  const seen = new Set();
  const targets = [];
  const pushUid = (uid) => {
    const normalized = String(uid ?? "").trim().split("_")[0];
    if (!normalized || !/^\d+$/.test(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    targets.push(normalized);
  };

  const mentions = Array.isArray(message?.data?.mentions) ? message.data.mentions : [];
  for (const mention of mentions) {
    pushUid(mention?.uid ?? mention?.id);
  }

  const quotedUid = getQuotedUid(message);
  if (quotedUid) {
    pushUid(quotedUid);
  }

  const tokens = Array.isArray(rawArgs)
    ? rawArgs
    : typeof rawArgs === "string"
      ? rawArgs.trim().split(/\s+/)
      : [];
  for (const token of tokens) {
    const cleaned = String(token ?? "").trim().replace(/^@+/, "");
    if (/^\d{6,24}$/.test(cleaned)) {
      pushUid(cleaned);
    }
  }

  return targets;
}
