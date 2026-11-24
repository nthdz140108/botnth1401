import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { LRUCache } from "lru-cache";
import { sendMessageStateQuote, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";

const WARNING_RESET_TIME = 1800000; // 30 minutes
const userWarnings = new LRUCache({ max: 5000, ttl: WARNING_RESET_TIME * 4 });
const kickedUsers = new LRUCache({ max: 2000, ttl: 10000 });

export async function handleAntiVoice(api, message, groupSettings) {
  const threadId = message.threadId;
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  const content = removeMention(message);
  const parts = content.split(" ");

  if (parts.length === 1) {
    groupSettings[threadId].antiVoice = !groupSettings[threadId].antiVoice;
  } else if (parts[1] === "on") {
    groupSettings[threadId].antiVoice = true;
  } else if (parts[1] === "off") {
    groupSettings[threadId].antiVoice = false;
  } else {
    const caption = "Cú pháp không hợp lệ. Sử dụng antivoice hoặc antivoice on/off";
    await sendMessageWarning(api, message, caption);
    return false;
  }

  const status = groupSettings[threadId].antiVoice ? "bật" : "tắt";
  const caption = `Chế độ chống tin nhắn thoại đã được ${status}!`;
  await sendMessageStateQuote(api, message, caption, groupSettings[threadId].antiVoice, 300000);

  return true;
}

export async function enforceAntiVoice(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf) {
  const threadId = message.threadId;
  const msgType = message.data.msgType;
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;

  if (!botIsAdminBox || isAdminBox || isSelf || kickedUsers.has(senderId) || isInWhiteList(groupSettings, threadId, senderId)) return false;

  if (groupSettings[threadId]?.antiVoice && msgType === "chat.voice") {
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
      console.error("Lỗi khi xóa tin nhắn thoại:", error);
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
  if (!userWarnings.has(senderId)) {
    userWarnings.set(senderId, {
      count: 0,
      lastWarningTime: Date.now(),
    });
  }

  const warning = userWarnings.get(senderId);
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
    let caption = `⚠️ Cảnh cáo ${senderName}!\nAi cho mày gửi voice ở đây!!!`;
    if (warning.count === 3) {
      caption = `⚠️ Cảnh cáo ${senderName}!\n Tao xút Mày ra khỏi box bây giờ!`;
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
    userWarnings.delete(senderId);
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
  kickedUsers.set(senderId, true);
  try {
    await api.blockUsers(threadId, [senderId]);
  } catch (error) {
    console.error("Lỗi khi xử lý kick vi phạm:", error);
  } finally {
    const timer = setTimeout(() => {
      kickedUsers.delete(senderId);
    }, 5000);
    timer.unref?.();
  }
}
