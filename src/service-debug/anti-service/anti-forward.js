import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getBotId } from "../../utils/env.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { getGroupInfoData } from "../info-service/group-info.js";
import { getUserInfoData } from "../info-service/user-info.js";
import { LRUCache } from "lru-cache";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";

const forwardSpamState = new LRUCache({ max: 5000, ttl: 10 * 60 * 1000 });

function isForwardedMessage(message) {
  try {
    const msgType = message.data?.msgType || (message.msgInfo ? JSON.parse(message.msgInfo)?.msgType : null);
    const reference = message.data?.reference ? JSON.parse(message.data.reference?.data || "{}") : {};

    const isForwardType = ["chat.forward"].includes(msgType);
    const isForwardReference = reference.fwLvl > 0;

    return isForwardType || isForwardReference;
  } catch (error) {
    return false;
  }
}

export async function antiForward(
  api,
  message,
  isAdminBox,
  groupSettings,
  botIsAdminBox,
  isSelf
) {
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName;
  const threadId = message.threadId;

  if (message.type !== MessageType.GroupMessage) {
    return false;
  }

  if (
    isSelf ||
    isAdminBox ||
    !botIsAdminBox ||
    !groupSettings[threadId]?.blockForward ||
    !senderId ||
    !senderName
  ) {
    return false;
  }

  return await handleForwardMessage(
    api,
    message,
    groupSettings,
    isAdminBox,
    threadId,
    senderId,
    senderName
  );
}

export async function handleAntiForwardCommand(
  api,
  message,
  groupSettings
) {
  const threadId = message.threadId;
  let isChangeSetting = false;
  const content = removeMention(message);
  const parts = content.split(" ");
  const subcommand = parts[1]?.toLowerCase();

  if (subcommand === "on" || subcommand === "off") {
    if (!groupSettings[threadId]) {
      groupSettings[threadId] = {};
    }
    const newStatus = subcommand === "on" ? true : false;
    groupSettings[threadId].blockForward = newStatus;
    isChangeSetting = true;
    const statusText = newStatus ? "bật" : "tắt";
    const caption = `Chức năng chặn chuyển tiếp đã được ${statusText}!`;
    await sendMessageStateQuote(api, message, caption, newStatus, 300000);
  } else {
    const newStatus = !groupSettings[threadId]?.blockForward;
    if (!groupSettings[threadId]) {
      groupSettings[threadId] = {};
    }
    groupSettings[threadId].blockForward = newStatus;
    isChangeSetting = true;
    const statusText = newStatus ? "bật" : "tắt";
    const caption = `Chức năng chặn chuyển tiếp đã được ${statusText}!`;
    await sendMessageStateQuote(api, message, caption, newStatus, 300000);
  }

  return isChangeSetting;
}

async function handleForwardMessage(
  api,
  message,
  groupSettings,
  isAdminBox,
  threadId,
  senderId,
  senderName
) {
  let isDeleteForward = false;
  const botId = getBotId();
  const isUserWhiteList = isInWhiteList(groupSettings, threadId, senderId);

  if (isUserWhiteList) {
    return isDeleteForward;
  }

  if (isForwardedMessage(message)) {
    const deleteResult = await api.deleteMessage(message, false).catch(() => null);
    if (deleteResult && deleteResult.status === 0) {
      isDeleteForward = true;
    } else {
      await api.sendMessage(
        {
          msg: "Không thể xóa tin nhắn chuyển tiếp!",
          quote: message,
          ttl: 300000,
        },
        threadId,
        MessageType.GroupMessage
      );
      await blockUser(api, message, threadId, senderId, senderName);
      return true;
    }
  }

  if (isDeleteForward && !isUserWhiteList) {
    await updateForwardCount(
      api,
      message,
      threadId,
      senderId,
      senderName,
      botId,
      isAdminBox
    );
  }
  return isDeleteForward;
}

async function updateForwardCount(
  api,
  message,
  threadId,
  senderId,
  senderName,
  botId,
  isAdminBox
) {
  const key = `${threadId}:${senderId}`;
  const now = Date.now();
  let state = forwardSpamState.get(key);
  if (!state || now - state.time >= 60 * 1000) {
    state = { count: 1, time: now };
  } else {
    state.count += 1;
  }
  forwardSpamState.set(key, state);

  if (isAdminBox && senderId !== botId) {
    return;
  }

  if (state.count > 2) {
    forwardSpamState.delete(key);
    await blockUser(api, message, threadId, senderId, senderName);
    return;
  }

  await sendWarningMessage(api, message, senderId, senderName, state.count);
}

async function blockUser(api, message, threadId, senderId, senderName) {
  try {
    await api.blockUsers(threadId, [senderId]);
    await getGroupInfoData(api, threadId);
    await getUserInfoData(api, senderId);
    await api.sendMessage(
      {
        msg: `Người dùng ${senderName} đã bị chặn vì gửi tin nhắn chuyển tiếp quá nhiều lần!`,
        quote: message,
        ttl: 300000,
      },
      threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    console.error("Loi xu ly chuyen tiep:", error.message);
  }
}

async function sendWarningMessage(api, message, senderId, senderName, count) {
  try {
    let caption = `⚠️ Cảnh cáo ${senderName}!\nỞ đây cấm chuyển tiếp tin nhắn`;
    if (count === 2) {
      caption = `⚠️ Cảnh cáo ${senderName}!\nNgừng chuyển tiếp tin nhắn, trước khi mọi chuyện dần tồi tệ hơn!`;
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
    console.error("Loi gui canh bao chuyen tiep:", error.message);
  }
}
