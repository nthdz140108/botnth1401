import { removeMention } from "../../utils/format-util.js";
import { sendMessageStateQuote, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";

// Bộ cờ bảo vệ không xung đột lẫn nhau (tuyệt đối không bật đồng thời antiText và onlyText)
const COMBINED_ANTI_MODES = Object.freeze([
  "antiPhotoVideo",
  "antiVideo",
  "antiVoice",
  "antiFile",
  "antiGif",
  "antiSpam",
  "removeTags",
  "allowSticker",
  "allowStickerlag",
  "antiStickerEffect",
  "removeLinks",
  "antiPhoneNumber",
  "blockForward",
  "enableAntiBot",
  "filterBadWords",
  "antiNude",
  "enableSetup",
  "antiMention",
  "antiJoinLeave",
  "antiKickBlock",
  "antiUndo",
]);

// Các cờ xung đột chỉ tắt sạch khi gõ !antiall off (không tự bật khi !antiall on)
const EXTRA_DISABLE_ONLY_MODES = Object.freeze([
  "antiText",
  "onlyText",
  "antiLink",
  "antiTag",
  "antiForward",
  "antiSticker",
]);

export async function handleAntiAll(api, message, groupSettings) {
  const threadId = message.threadId;
  const content = removeMention(message).trim();
  const parts = content.split(/\s+/).filter(Boolean);
  const action = parts[1]?.toLowerCase();

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  let newStatus;
  if (parts.length === 1) {
    newStatus = !groupSettings[threadId].antiPhotoVideo;
    COMBINED_ANTI_MODES.forEach((mode) => {
      groupSettings[threadId][mode] = newStatus;
    });
    if (!newStatus) {
      EXTRA_DISABLE_ONLY_MODES.forEach((mode) => {
        if (mode in groupSettings[threadId]) {
          groupSettings[threadId][mode] = false;
        }
      });
    }
  } else if (action === "on") {
    newStatus = true;
    COMBINED_ANTI_MODES.forEach((mode) => {
      groupSettings[threadId][mode] = true;
    });
  } else if (action === "off") {
    newStatus = false;
    COMBINED_ANTI_MODES.forEach((mode) => {
      groupSettings[threadId][mode] = false;
    });
    EXTRA_DISABLE_ONLY_MODES.forEach((mode) => {
      groupSettings[threadId][mode] = false;
    });
  } else {
    const caption = "Cú pháp không hợp lệ. Sử dụng antiall hoặc antiall on/off";
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
