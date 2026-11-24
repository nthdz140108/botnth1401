import { LRUCache } from "lru-cache";
import { MessageMention } from "../../api-zalo/models/index.js";
import {
  sendMessageState,
  sendMessageStateQuote,
} from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { isInWhiteList } from "./white-list.js";

const CACHE_DURATION = 10000;
const MAX_BOT_TTL_MS = 3600000;
const groupInfoCache = new LRUCache({ max: 1000, ttl: CACHE_DURATION });

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
  isSelf = false
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

  const botUid = String(api.appContext?.uid || "");
  if (
    !senderId
    || senderId === botUid
    || isSelf
    || isAdminBox
    || isInWhiteList(groupSettings, threadId, senderId)
  ) {
    return false;
  }

  if (typeof ttl !== "number" || ttl <= 1000 || ttl >= MAX_BOT_TTL_MS) {
    return false;
  }

  const groupInfo = await getGroupInfoData(api, threadId);
  if (!groupInfo || groupInfo.adminIds.includes(senderId)) {
    return false;
  }

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
