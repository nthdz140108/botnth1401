import { removeMention } from "../../utils/format-util.js";
import { sendMessageStateQuote, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";

export async function handleAntiAll(api, message, groupSettings) {
  const threadId = message.threadId;
  const content = removeMention(message);
  const parts = content.split(" ");

  // Khởi tạo groupSettings[threadId] nếu chưa tồn tại
  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  // Danh sách tất cả các chế độ chống
  const antiModes = [
    "antiPhotoVideo",
    "antiVoice",
    "antiFile",
    "antiSpam",
    "removeTags",
    "allowSticker",
    "removeLinks",
    "enableAntiBot",
    "filterBadWords",
    "antiNude",       
    "enableSetup",   
    "antiMention",
    "antiJoinLeave"
  ];

  let newStatus;
  if (parts.length === 1) {
    // Đảo ngược trạng thái của tất cả các chế độ chống
    newStatus = !groupSettings[threadId].antiPhotoVideo; // Dùng một chế độ để xác định trạng thái chung
    antiModes.forEach(mode => {
      groupSettings[threadId][mode] = newStatus;
    });
  } else if (parts[1] === "on") {
    // Bật tất cả các chế độ chống
    newStatus = true;
    antiModes.forEach(mode => {
      groupSettings[threadId][mode] = true;
    });
  } else if (parts[1] === "off") {
    // Tắt tất cả các chế độ chống
    newStatus = false;
    antiModes.forEach(mode => {
      groupSettings[threadId][mode] = false;
    });
  } else {
    const caption = "Cú pháp không hợp lệ. Sử dụng antiall hoặc antiAll on/off";
    await sendMessageWarning(api, message, caption);
    return false;
  }

  const status = newStatus ? "bật" : "tắt";
  const caption = `Tất cả các chế độ anti đã được ${status}!`;
  try {
    await sendMessageStateQuote(api, message, caption, newStatus, 300000);
  } catch (error) {
    console.warn(`[anti-all] fallback plain send after styled send failed: ${error.message}`);
    try {
      await api.sendMessage(
        {
          msg: caption,
          ttl: 300000,
          linkOn: false,
        },
        threadId,
        message.type
      );
    } catch (fallbackError) {
      console.warn(`[anti-all] fallback plain send also failed: ${fallbackError.message}`);
    }
  }

  return true;
}
