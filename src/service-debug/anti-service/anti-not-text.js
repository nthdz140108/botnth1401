import { removeMention } from "../../utils/format-util.js";
import { sendMessageStateQuote, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { isInWhiteList } from "./white-list.js";

export async function handleOnlyText(api, message, groupSettings) {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  if (!groupSettings[threadId]) groupSettings[threadId] = {};
  const content = removeMention(message).trim();
  const parts = content.split(/\s+/).filter(Boolean);
  const option = parts[1]?.toLowerCase();

  if (parts.length === 1) {
    groupSettings[threadId].onlyText = !groupSettings[threadId].onlyText;
  } else if (option === "on") {
    groupSettings[threadId].onlyText = true;
  } else if (option === "off") {
    groupSettings[threadId].onlyText = false;
  } else {
    const caption = `Cú pháp không hợp lệ. Sử dụng ${prefix}onlytext hoặc ${prefix}onlytext [on/off]`;
    await sendMessageWarning(api, message, caption);
    return false;
  }

  const status = groupSettings[threadId].onlyText ? "bật" : "tắt";
  const caption = `Chế độ chỉ cho phép tin nhắn văn bản đã được ${status}!`;
  await sendMessageStateQuote(api, message, caption, groupSettings[threadId].onlyText, 300000);

  return true;
}

export async function antiNotText(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf) {
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;
  const isPlainText = typeof message.data.content === "string";
  if (!botIsAdminBox || isAdminBox || isPlainText || isSelf) return false;
  if (isInWhiteList(groupSettings, threadId, senderId)) return false;

  if (groupSettings[threadId]?.onlyText && message.data.msgType !== "webchat") {
    try {
      await api.deleteMessage(message, false);
      return true;
    } catch (error) {
      console.error("Lỗi khi xóa tin nhắn Không phải văn bản:", error);
      return false;
    }
  }

  return false;
}
