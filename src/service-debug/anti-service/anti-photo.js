import { LRUCache } from "lru-cache";
import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getGroupInfoData } from "../../service-debug/info-service/group-info.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import * as cv from "../../utils/canvas/index.js";
import { sendMessageStateQuote, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";

const WARNING_RESET_TIME = 1800000; // 30 minutes
const userWarnings = new LRUCache({ max: 3000, ttl: WARNING_RESET_TIME * 4 });
const kickedUsers = new Set();

export async function handleAntiPhotoVideo(api, message, groupSettings) {
  const threadId = message.threadId;
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  const content = removeMention(message).trim();
  const parts = content.split(/\s+/).filter(Boolean);
  const option = parts[1]?.toLowerCase();

  if (parts.length === 1) {
    groupSettings[threadId].antiPhotoVideo = !groupSettings[threadId].antiPhotoVideo;
  } else if (option === "on") {
    groupSettings[threadId].antiPhotoVideo = true;
  } else if (option === "off") {
    groupSettings[threadId].antiPhotoVideo = false;
  } else {
    const caption = "Cú pháp không hợp lệ. Sử dụng antiphoto hoặc antiphoto on/off";
    await sendMessageWarning(api, message, caption);
    return false;
  }

  const status = groupSettings[threadId].antiPhotoVideo ? "bật" : "tắt";
  const caption = `Chế độ chống gửi ảnh đã được ${status}!`;
  await sendMessageStateQuote(api, message, caption, groupSettings[threadId].antiPhotoVideo, 300000);

  return true;
}

export async function enforceAntiPhotoVideo(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf) {
  const threadId = message.threadId;
  const msgType = message.data.msgType;
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const userKey = `${threadId}:${senderId}`;

  if (!botIsAdminBox || isAdminBox || isSelf || kickedUsers.has(userKey) || isInWhiteList(groupSettings, threadId, senderId)) return false;

  if (groupSettings[threadId]?.antiPhotoVideo && msgType === "chat.photo") {
    try {
      await api.deleteMessage(message, false);

      const warningResult = await handleWarning(
        api,
        message,
        threadId,
        senderId,
        senderName
      );

      if (warningResult.shouldBlock) {
        await handleViolationDetected(
          api,
          message,
          threadId,
          senderId,
          senderName
        );
      }
      return true;
    } catch (error) {
      console.error("Lỗi khi xóa tin nhắn ảnh:", error);
      return false;
    }
  }

  return false;
}

async function handleWarning(
  api,
  message,
  threadId,
  senderId,
  senderName
) {
  const userKey = `${threadId}:${senderId}`;
  if (!userWarnings.has(userKey)) {
    userWarnings.set(userKey, {
      count: 0,
      lastWarningTime: Date.now(),
    });
  }

  const warning = userWarnings.get(userKey);
  const currentTime = Date.now();

  const warningReductions = Math.floor(
    (currentTime - warning.lastWarningTime) / WARNING_RESET_TIME
  );
  if (warningReductions > 0) {
    warning.count = Math.max(0, warning.count - warningReductions);
  }

  warning.count++;
  warning.lastWarningTime = currentTime;

  if (warning.count < 5) {
    let caption = `⚠️ Cảnh cáo ${senderName}!\nAi cho mày gửi ảnh ở đây!!!`;
    if (warning.count === 3) {
      caption = `⚠️ Cảnh cáo ${senderName}!\nTao xút Mày ra khỏi box bây giờ!`;
    }
    await api.sendMessage(
      {
        msg: caption,
        mentions: [
          MessageMention(senderId, senderName.length, "⚠️ Cảnh cáo ".length),
        ],
        ttl: 8000,
      },
      threadId,
      MessageType.GroupMessage
    );
    return { shouldBlock: false };
  } else {
    userWarnings.delete(userKey);
    return { shouldBlock: true };
  }
}

async function handleViolationDetected(
  api,
  message,
  threadId,
  senderId,
  senderName
) {
  const userKey = `${threadId}:${senderId}`;
  kickedUsers.add(userKey);
  try {
    await api.blockUsers(threadId, [senderId]);
  } catch (error) {
    console.error("Lỗi khi xử lý kick vi phạm:", error);
  } finally {
    setTimeout(() => {
      kickedUsers.delete(userKey);
    }, 5000).unref?.();
  }
}
