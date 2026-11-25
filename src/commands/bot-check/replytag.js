import { LRUCache } from "lru-cache";
import { appContext } from "../../api-zalo/context.js";
import { getBotId } from "../../utils/env.js";
import { writeGroupSettings } from "../../utils/io-json.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { sendMessageStateQuote } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { extractCommandBody, safeThreadType } from "../shared/command-input-utils.js";

const REPLY_TAG_COOLDOWN_MS = 15 * 1000;
const DEFAULT_REPLY_TAG_TEXT = "Dạ bot đang hoạt động, bạn cần hỗ trợ gì ạ?";
const replyTagCooldown = new LRUCache({ max: 2000, ttl: REPLY_TAG_COOLDOWN_MS });

function getMentions(message) {
  const mentions = message?.data?.mentions;
  if (Array.isArray(mentions)) return mentions;
  if (mentions && typeof mentions === "object") {
    return Object.values(mentions).filter((item) => item && typeof item === "object" && item.uid);
  }
  return [];
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

export function resetReplyTagCooldown() {
  replyTagCooldown.clear();
}

export async function handleAutoReplyMentionsMessageCommand(api, message, aliasCommand, groupSettings) {
  const prefix = getGlobalPrefix() || "!";
  const threadId = message?.threadId;
  if (!threadId || !groupSettings) return false;

  const effectiveAlias = aliasCommand || "replytag";
  const body = extractCommandBody(message, prefix, effectiveAlias);
  const tokens = body ? body.split(/\s+/).filter(Boolean) : [];
  const subCommand = (tokens[0] || "").toLowerCase();

  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  if (subCommand === "set") {
    const customText = body.replace(/^set\b\s*/i, "").trim();
    if (!customText) {
      const currentReply = groupSettings[threadId].replyTagText || DEFAULT_REPLY_TAG_TEXT;
      await sendMessageStateQuote(
        api,
        message,
        `📝 Nội dung phản hồi khi tag hiện tại:\n"${currentReply}"\n💡 Đặt nội dung mới: ${prefix}${effectiveAlias} set <nội dung>`,
        true,
        30000,
      );
      return true;
    }

    if (customText.toLowerCase() === "reset" || customText.toLowerCase() === "default") {
      delete groupSettings[threadId].replyTagText;
      writeGroupSettings(groupSettings);
      await sendMessageStateQuote(
        api,
        message,
        `Đã khôi phục nội dung phản hồi tag về mặc định:\n"${DEFAULT_REPLY_TAG_TEXT}"`,
        true,
        30000,
      );
      return true;
    }

    const normalizedText = customText.slice(0, 1000);
    groupSettings[threadId].replyTagText = normalizedText;
    groupSettings[threadId].ifMentioned = true;
    writeGroupSettings(groupSettings);
    await sendMessageStateQuote(
      api,
      message,
      `Đã bật và cập nhật nội dung phản hồi khi được tag:\n"${normalizedText}"`,
      true,
      30000,
    );
    return true;
  }

  if (subCommand === "reset" || subCommand === "default") {
    delete groupSettings[threadId].replyTagText;
    writeGroupSettings(groupSettings);
    await sendMessageStateQuote(
      api,
      message,
      `Đã khôi phục nội dung phản hồi tag về mặc định:\n"${DEFAULT_REPLY_TAG_TEXT}"`,
      true,
      30000,
    );
    return true;
  }

  if (subCommand === "on") {
    groupSettings[threadId].ifMentioned = true;
  } else if (subCommand === "off") {
    groupSettings[threadId].ifMentioned = false;
  } else if (!subCommand) {
    groupSettings[threadId].ifMentioned = !groupSettings[threadId].ifMentioned;
  } else {
    await sendMessageStateQuote(
      api,
      message,
      `⚠️ Cú pháp: ${prefix}${effectiveAlias} [on | off | set <nội dung> | reset]`,
      true,
      30000,
      false,
    );
    return true;
  }

  writeGroupSettings(groupSettings);
  const status = Boolean(groupSettings[threadId].ifMentioned);
  await sendMessageStateQuote(
    api,
    message,
    `Chức năng tự động phản hồi khi tag bot đã được ${status ? "bật" : "tắt"}!`,
    status,
    30000,
  );
  return true;
}

export async function handleCalls(api, message, groupSettings, senderId, senderName, isSelf) {
  if (isSelf || message?.isSelf) return false;
  const threadId = message?.threadId;
  if (!threadId || !groupSettings?.[threadId]?.ifMentioned) return false;

  const prefix = getGlobalPrefix() || "!";
  const rawContent = typeof message?.data?.content === "string" ? message.data.content.trim() : "";
  if (prefix && rawContent.toLowerCase().startsWith(prefix.toLowerCase())) return false;

  const mentions = getMentions(message);
  if (!mentions.length) return false;

  const botCandidates = new Set(
    [api?.getBotId?.(), api?.getOwnId?.(), appContext.uid, getBotId()]
      .map(normalizeId)
      .filter((id) => id && id !== "-1"),
  );
  if (botCandidates.size === 0) return false;
  if (!mentions.some((mention) => botCandidates.has(normalizeId(mention.uid)))) return false;

  const effectiveSenderId = normalizeId(senderId || message?.data?.uidFrom);
  const cooldownKey = `${threadId}:${effectiveSenderId || "anon"}`;
  const now = Date.now();
  const lastRepliedAt = replyTagCooldown.get(cooldownKey) || 0;
  if (now - lastRepliedAt < REPLY_TAG_COOLDOWN_MS) {
    return true;
  }
  replyTagCooldown.set(cooldownKey, now);

  const customText = typeof groupSettings[threadId]?.replyTagText === "string"
    ? groupSettings[threadId].replyTagText.trim()
    : "";
  const displaySender = String(senderName || message?.data?.dName || "").trim();

  let replyMsg = customText || DEFAULT_REPLY_TAG_TEXT;
  let replyMentions = [];

  if (customText) {
    if (/\{name\}/i.test(customText) && displaySender) {
      const match = customText.match(/\{name\}/i);
      const pos = match ? match.index : 0;
      replyMsg = customText.replace(/\{name\}/gi, displaySender);
      if (effectiveSenderId) {
        replyMentions = [{ uid: effectiveSenderId, pos, len: displaySender.length }];
      }
    }
  } else if (displaySender && effectiveSenderId) {
    const greeting = `Chào ${displaySender}, `;
    replyMsg = `${greeting}dạ bot đang hoạt động, bạn cần hỗ trợ gì ạ?`;
    replyMentions = [{ uid: effectiveSenderId, pos: "Chào ".length, len: displaySender.length }];
  }

  const threadType = safeThreadType(message);
  try {
    await api.sendMessage(
      {
        msg: replyMsg,
        ...(replyMentions.length > 0 ? { mentions: replyMentions } : {}),
        quote: message,
        ttl: 3600000,
      },
      threadId,
      threadType,
    );
    return true;
  } catch (error) {
    try {
      await api.sendMessage(
        {
          msg: replyMsg,
          ttl: 3600000,
        },
        threadId,
        threadType,
      );
      return true;
    } catch (fallbackErr) {
      console.error("Lỗi khi gửi phản hồi mention:", fallbackErr?.message || error?.message || error);
      return false;
    }
  }
}
