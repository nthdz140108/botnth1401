import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getBotId } from "../../utils/env.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { LRUCache } from "lru-cache";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";

const tagSpamState = new LRUCache({ max: 5000, ttl: 10 * 60 * 1000 });

function checkTag(message) {
  const hasMentions = message.data.mentions && Array.isArray(message.data.mentions) && message.data.mentions.length > 0;
  const mentionCount = message.data.mentions ? message.data.mentions.length : 0;
  const isHiddenTag = hasMentions && (message.data.content || "").trim().length === 0;
  return { hasMentions, mentionCount, isHiddenTag };
}

export async function antiTag(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const threadId = message.threadId;

  if (isSelf || isAdminBox || !botIsAdminBox || !groupSettings[threadId]?.removeTags) {
    return false;
  }

  const isUserWhiteList = isInWhiteList(groupSettings, threadId, senderId);
  if (isUserWhiteList) {
    return false;
  }

  let isDeleteTag = false;
  const { hasMentions, mentionCount, isHiddenTag } = checkTag(message);

  if (hasMentions) {
    await api.deleteMessage(message, false).catch(() => {});
    isDeleteTag = true;
    if (mentionCount > 10) {
      await sendMessageWarning(api, message, senderId, senderName, mentionCount, isHiddenTag);
      await blockUser(api, message, threadId, senderId, senderName);
      return true;
    }
    await sendWarningMessage(api, message, senderId, senderName, mentionCount, isHiddenTag);
  }

  if (isDeleteTag) {
    await updateTagCount(api, message, threadId, senderId, senderName, getBotId(), isAdminBox);
  }

  return isDeleteTag;
}

export async function handleAntiTagCommand(api, message, groupSettings) {
  const threadId = message.threadId;
  let isChangeSetting = false;
  const content = removeMention(message);
  const status = content.split(" ")[1]?.toLowerCase();
  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  const newStatus = status === "on" ? true : status === "off" ? false : !groupSettings[threadId].removeTags;
  groupSettings[threadId].removeTags = newStatus;
  isChangeSetting = true;
  const statusText = newStatus ? "bật" : "tắt";
  const caption = `Chức năng chống tag đã được ${statusText}!`;
  await sendMessageStateQuote(api, message, caption, newStatus, 30000);

  return isChangeSetting;
}

async function updateTagCount(api, message, threadId, senderId, senderName, botId, isAdminBox) {
  const key = `${threadId}:${senderId}`;
  const now = Date.now();
  let state = tagSpamState.get(key);
  if (!state || now - state.time >= 60 * 1000) {
    state = { count: 1, time: now };
  } else {
    state.count += 1;
  }
  tagSpamState.set(key, state);

  if (isAdminBox && senderId !== botId) {
    return;
  }

  if (state.count > 2) {
    tagSpamState.delete(key);
    await blockUser(api, message, threadId, senderId, senderName);
  }
}

async function blockUser(api, message, threadId, senderId, senderName) {
  try {
    await api.blockUsers(threadId, [senderId]);
    await api.sendMessage(
      {
        msg: `${senderName} đã bị chặn khỏi nhóm vì tag quá nhiều người!`,
        quote: message,
      },
      threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    console.error("Loi xu ly anti tag:", error.message);
  }
}

async function sendWarningMessage(api, message, senderId, senderName, mentionCount, isHiddenTag) {
  try {
    let caption = `⚠️ Cảnh cáo ${senderName}!\nở đây cấm tag.`;
    if (mentionCount > 10) {
      caption = `⚠️ Cảnh cáo ${senderName}!\nTag quá nhiều người sẽ bị chặn!`;
    }
    await api.sendMessage(
      {
        msg: caption,
        mentions: [
          MessageMention(senderId, senderName.length, "⚠️ Cảnh cáo ".length),
        ],
        quote: message,
        ttl: 300000,
      },
      message.threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    console.error("Loi gui canh bao tag:", error.message);
  }
}

async function sendMessageWarning(api, message, senderId, senderName, mentionCount, isHiddenTag) {
  try {
    const caption = `${senderName} ⚠️Phát hiện hành vi bất thường và đã bị chặn ngay lập tức!!!\n🚨🚨🚨`;
    await api.sendMessage(
      {
        msg: caption,
        mentions: [
          MessageMention(senderId, senderName.length, 0),
        ],
        quote: message,
        ttl: 300000,
      },
      message.threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    console.error("Loi gui canh bao hanh vi bat thuong:", error.message);
  }
}