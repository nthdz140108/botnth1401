import { LRUCache } from "lru-cache";
import { MessageMention } from "../../api-zalo/models/index.js";
import {
  sendMessageState,
  sendMessageStateQuote,
} from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { getBotId } from "../../utils/env.js";
import { isInWhiteList } from "./white-list.js";

const CACHE_DURATION = 10000;
const ULTRA_SHORT_BOT_TTL_MS = 15000;
const SUSPICIOUS_BOT_TTL_MAX_MS = 600000;
const BOT_FREQUENCY_WINDOW_MS = 25000;
// Standard Zalo human disappearing message presets (15m, 30m, 1h, 24h, 7d)
const HUMAN_ZALO_TTL_PRESETS = new Set([
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
]);
const groupInfoCache = new LRUCache({ max: 1000, ttl: CACHE_DURATION });
const botTtlTracker = new LRUCache({ max: 5000, ttl: BOT_FREQUENCY_WINDOW_MS * 2 });

async function getGroupInfoData(api, threadId) {
  if (!threadId) {
    await sendMessageState(api, threadId, "Loi: threadId khong hop le!", "warning", 60000);
    return null;
  }

  const now = Date.now();
  const cachedData = groupInfoCache.get(threadId);
  if (cachedData && now - cachedData.timestamp < CACHE_DURATION) {
    return cachedData.data;
  }

  try {
    if (typeof api.getGroupInfo !== "function") {
      throw new Error("api.getGroupInfo khong ton tai");
    }
    const groupInfoResponse = await api.getGroupInfo(threadId);
    const gridInfo = groupInfoResponse?.gridInfoMap?.[threadId];
    if (!gridInfo) {
      throw new Error(`Khong tim thay thong tin nhom ${threadId}`);
    }

    const processedInfo = {
      creatorId: gridInfo.creatorId === undefined || gridInfo.creatorId === null
        ? null
        : String(gridInfo.creatorId),
      adminIds: (gridInfo.adminIds || gridInfo.admins || []).map(String),
    };
    if (processedInfo.creatorId && !processedInfo.adminIds.includes(processedInfo.creatorId)) {
      processedInfo.adminIds.push(processedInfo.creatorId);
    }

    groupInfoCache.set(threadId, {
      data: processedInfo,
      timestamp: now,
    });
    return processedInfo;
  } catch (error) {
    console.warn("Khong the lay thong tin nhom:", error);
    await sendMessageState(
      api,
      threadId,
      "Loi: Khong the lay danh sach quan tri vien nhom!",
      "warning",
      60000
    );
    return null;
  }
}

export async function antiBotCheck(
  api,
  message,
  groupSettings,
  isAdminBox = false,
  isSelf = false,
  botIsAdminBox = undefined
) {
  if (!message?.data || !message.threadId || !groupSettings || typeof groupSettings !== "object") {
    return false;
  }

  const threadId = message.threadId;
  const senderName = message.data.dName || "Nguoi dung khong xac dinh";
  const senderId = String(message.data.uidFrom || "");
  const ttl = message.data.ttl;
  const isWebchat = message.data.msgType === "webchat";

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = { enableAntiBot: false };
  }
  if (!groupSettings[threadId].enableAntiBot) {
    return false;
  }

  const rawBotUid = api?.getOwnId?.() || api?.getBotId?.() || api?.appContext?.uid || getBotId();
  const botUid = rawBotUid && rawBotUid !== -1 ? String(rawBotUid) : "";
  if (
    !senderId
    || senderId === botUid
    || isSelf
    || isAdminBox
    || botIsAdminBox === false
    || isInWhiteList(groupSettings, threadId, senderId)
  ) {
    return false;
  }

  if (typeof ttl !== "number" || ttl <= 0 || HUMAN_ZALO_TTL_PRESETS.has(ttl) || ttl >= SUSPICIOUS_BOT_TTL_MAX_MS) {
    return false;
  }

  // Ultra-short TTL (<= 15s) is a direct bot signature; longer custom TTL (15s..10m) requires repeated frequency
  const scopedKey = `${threadId}:${senderId}`;
  const now = Date.now();
  const prevHits = (botTtlTracker.get(scopedKey) || []).filter((t) => now - t <= BOT_FREQUENCY_WINDOW_MS);
  prevHits.push(now);
  botTtlTracker.set(scopedKey, prevHits);

  if (ttl > ULTRA_SHORT_BOT_TTL_MS && prevHits.length < 2) {
    return false;
  }

  const groupInfo = await getGroupInfoData(api, threadId);
  if (!groupInfo || groupInfo.adminIds.includes(senderId)) {
    return false;
  }

  const effectiveBotIsAdmin =
    typeof botIsAdminBox === "boolean"
      ? botIsAdminBox
      : Boolean(botUid && groupInfo.adminIds.includes(botUid));

  if (!effectiveBotIsAdmin) {
    return false;
  }

  botTtlTracker.delete(scopedKey);

  const messagePayload = {
    mentions: [MessageMention(senderId, senderName.length, 0)],
    ttl: 60000,
  };
  if (!isWebchat) {
    messagePayload.quote = message;
  }

  try {
    await sendMessageState(
      api,
      threadId,
      `${senderName} khong duoc phep dung bot trong nhom nay.`,
      "warning",
      60000,
      messagePayload
    );
    await api.blockUsers(threadId, [senderId]);
    return true;
  } catch (error) {
    await sendMessageState(
      api,
      threadId,
      `Loi khi chan ${senderName}: ${error.message}`,
      "error",
      60000
    );
    return false;
  }
}

export async function handleAntiBotCommand(api, message, groupSettings) {
  if (!message?.threadId || !groupSettings || typeof groupSettings !== "object") {
    return false;
  }

  const threadId = message.threadId;
  if (!groupSettings[threadId]) {
    groupSettings[threadId] = { enableAntiBot: false };
  }

  const content = removeMention(message).trim();
  const command = content.split(/\s+/)[1]?.toLowerCase();
  let newStatus;

  if (!command) {
    newStatus = !groupSettings[threadId].enableAntiBot;
  } else if (command === "on") {
    newStatus = true;
  } else if (command === "off") {
    newStatus = false;
  } else {
    await sendMessageStateQuote(
      api,
      message,
      "Cu phap khong hop le. Su dung antibot hoac antibot on/off.",
      false,
      300000
    );
    return false;
  }

  groupSettings[threadId].enableAntiBot = newStatus;
  const statusText = newStatus ? "bat" : "tat";
  await sendMessageStateQuote(
    api,
    message,
    `Chuc nang chong bot da duoc ${statusText}!`,
    newStatus,
    300000
  );
  return true;
}
