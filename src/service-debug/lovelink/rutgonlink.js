import fetch from "node-fetch";
import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuoteData,
  getQuotedText,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

export const des = {
  name: "rutgonlink",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

const SHORTEN_TIMEOUT_MS = 8000;

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withSafeMessageType(message) {
  const fallbackType =
    message?.threadId &&
    message?.data?.uidFrom &&
    String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage;
  const resolvedType = safeThreadType(message, fallbackType);
  return message?.type === resolvedType ? message : { ...message, type: resolvedType };
}

function matchesShortenCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "rutgonlink").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

function extractUrlFromTextOrQuote(argText, message) {
  const directMatch = String(argText || "").match(/https?:\/\/\S+/i);
  if (directMatch) return directMatch[0];
  const firstToken = String(argText || "").trim().split(/\s+/)[0] || "";
  if (firstToken && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(firstToken)) {
    return `https://${firstToken}`;
  }

  const quote = getQuoteData(message);
  if (quote?.attach) {
    try {
      const parsed = typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
      if (typeof parsed?.href === "string" && /^https?:\/\//i.test(parsed.href.trim())) {
        return parsed.href.trim();
      }
    } catch {}
  }

  const quotedText = getQuotedText(message);
  const quotedMatch = String(quotedText || "").match(/https?:\/\/\S+/i);
  return quotedMatch ? quotedMatch[0] : "";
}

export async function shortenUrlMultiProvider(longUrl) {
  let parsedUrl;
  try {
    parsedUrl = new URL(longUrl);
  } catch {
    throw new Error("URL không đúng định dạng (cần bắt đầu bằng http:// hoặc https://)");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Chỉ hỗ trợ rút gọn liên kết http/https");
  }

  const normalizedUrl = parsedUrl.toString();
  const providers = [
    async () => {
      const res = await fetch(
        `https://is.gd/create.php?format=json&url=${encodeURIComponent(normalizedUrl)}`,
        { signal: AbortSignal.timeout(SHORTEN_TIMEOUT_MS) }
      );
      const data = await res.json();
      if (!res.ok || !data?.shorturl || data?.errormessage) {
        throw new Error(data?.errormessage || `is.gd HTTP ${res.status}`);
      }
      return data.shorturl.trim();
    },
    async () => {
      const res = await fetch(
        `https://v.gd/create.php?format=json&url=${encodeURIComponent(normalizedUrl)}`,
        { signal: AbortSignal.timeout(SHORTEN_TIMEOUT_MS) }
      );
      const data = await res.json();
      if (!res.ok || !data?.shorturl || data?.errormessage) {
        throw new Error(data?.errormessage || `v.gd HTTP ${res.status}`);
      }
      return data.shorturl.trim();
    },
    async () => {
      const res = await fetch(
        `https://tinyurl.com/api-create.php?url=${encodeURIComponent(normalizedUrl)}`,
        { signal: AbortSignal.timeout(SHORTEN_TIMEOUT_MS) }
      );
      const text = (await res.text()).trim();
      if (!res.ok || !/^https?:\/\//i.test(text)) {
        throw new Error(`tinyurl HTTP ${res.status}`);
      }
      return text;
    },
  ];

  let lastError = null;
  for (const runProvider of providers) {
    try {
      const shortUrl = await runProvider();
      if (shortUrl) return shortUrl;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("Không thể rút gọn link lúc này");
}

export async function handleRutgonlinkCommand(api, message, aliasCommand = "rutgonlink") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "rutgonlink";

  if (!matchesShortenCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const body = extractCommandBody(msgCtx, currentPrefix, effectiveAlias);
  const urlToShorten = extractUrlFromTextOrQuote(body, msgCtx);

  if (!urlToShorten) {
    const guide =
      `❌ Vui lòng nhập URL hoặc reply tin nhắn chứa link cần rút gọn.\n\n` +
      `👉 Ví dụ: ${currentPrefix}${effectiveAlias} https://www.google.com`;
    return sendMessageStateQuote(api, msgCtx, guide, false, 60000, true);
  }

  try {
    const shortUrl = await shortenUrlMultiProvider(urlToShorten);
    const msg =
      `✅ RÚT GỌN LINK THÀNH CÔNG\n\n` +
      `➤ Link gốc: ${urlToShorten}\n` +
      `➤ Link rút gọn: ${shortUrl}`;
    return sendMessageStateQuote(api, msgCtx, msg, true, 3600000, false);
  } catch (e) {
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Không thể rút gọn link: ${e?.message || "Lỗi kết nối"}`,
      true
    );
  }
}
