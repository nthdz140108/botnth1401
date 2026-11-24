import { appContext } from "../../api-zalo/context.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { removeMention } from "../../utils/format-util.js";
import { sendMessageStateQuote } from "../../service-debug/chat-zalo/chat-style/chat-style.js";

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

export async function handleAutoReplyMentionsMessageCommand(api, message, aliasCommand, groupSettings) {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const content = removeMention(message).trim().toLowerCase();
  const query = content.replace(`${prefix}${aliasCommand}`, "").trim();
  const args = query.split(/\s+/).filter(Boolean);
  const command = args[0];

  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  if (command === "on") groupSettings[threadId].ifMentioned = true;
  else if (command === "off") groupSettings[threadId].ifMentioned = false;
  else groupSettings[threadId].ifMentioned = !groupSettings[threadId].ifMentioned;

  const status = groupSettings[threadId].ifMentioned;
  await sendMessageStateQuote(
    api,
    message,
    `Chuc nang Reply Tag da duoc ${status ? "bat" : "tat"}!`,
    status,
    30000,
  );
  return true;
}

export async function handleCalls(api, message, groupSettings, senderId, senderName, isSelf) {
  if (isSelf) return false;
  const threadId = message.threadId;
  if (!groupSettings[threadId]?.ifMentioned) return false;

  const mentions = getMentions(message);
  if (!mentions.length) return false;

  const botId = normalizeId(appContext.uid);
  if (!mentions.some((mention) => normalizeId(mention.uid) === botId)) return false;

  try {
    await api.sendMessage(
      {
        msg: `Xin chao ${senderName}\n\nBot share by HHH\n\nThanks.`,
        mentions: [{ uid: senderId, pos: "Xin chao ".length, len: senderName.length }],
        quote: message,
        ttl: 3600000,
      },
      threadId,
      message.type,
    );
    return true;
  } catch (error) {
    console.error("Loi khi gui phan hoi mention:", error);
    await api.sendMessage(
      { msg: "Loi khi phan hoi.", quote: message },
      threadId,
      message.type,
    );
    return true;
  }
}
