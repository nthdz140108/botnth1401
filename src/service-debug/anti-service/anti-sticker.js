import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getBotId } from "../../utils/env.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { createBlockSpamLinkImage } from "../../utils/canvas/event-image.js";
import { clearImagePath } from "../../utils/canvas/index.js";
import { getGroupInfoData } from "../info-service/group-info.js";
import { getUserInfoData } from "../info-service/user-info.js";
import { LRUCache } from "lru-cache";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";

const stickerWarnings = new LRUCache({ max: 5000, ttl: 25 * 60 * 1000 });

export async function antiAllEffectSticker(
  api,
  message,
  isAdminBox,
  groupSettings,
  botIsAdminBox,
  isSelf
) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const threadId = message.threadId;
  const content = message.data.content;

  if (
    isSelf ||
    isAdminBox ||
    !botIsAdminBox ||
    !groupSettings[threadId]?.allowSticker ||
    isInWhiteList(groupSettings, threadId, senderId)
  ) {
    return false;
  }

  if (!content || typeof content !== "object") {
    return false;
  }

  const stickerId = content.id;
  const cateId = content.catId;
  if (!stickerId || !cateId) {
    return false;
  }

  const threshold = groupSettings[threadId]?.rules?.rule_stklag?.threshold || 3;
  let isDeleteSticker = false;

  try {
    const result = await api.deleteMessage(message, false);
    
    if (!result || result.status !== 0) {
      await api.sendMessage(
        {
          msg: `Nhờn với bố mày à ;!`,
          quote: message,
          ttl: 300000,
        },
        threadId,
        MessageType.GroupMessage
      );
      await blockAllUser(api, message, threadId, senderId, senderName);
      return true;
    }

    isDeleteSticker = true;
    await updateAllStickerWarnings(
      api,
      message,
      threadId,
      senderId,
      senderName,
      threshold
    );
  } catch (error) {
    console.error(`Lỗi khi xóa sticker: ${error.message}`);
    return false;
  }

  return isDeleteSticker;
}

export async function handleAntiAllEffectStickerCommand(api, message, groupSettings) {
  const threadId = message.threadId;
  let isChangeSetting = false;
  const content = removeMention(message);
  const status = content.trim().split(/\s+/)[1]?.toLowerCase();
  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  const newStatus =
    status === "on"
      ? true
      : status === "off"
        ? false
        : !groupSettings[threadId].allowSticker;
  groupSettings[threadId].allowSticker = newStatus;
  isChangeSetting = true;
  const statusText = newStatus ? "bật" : "tắt";
  let caption = `Chức năng xóa sticker đã được ${statusText}!`;

  if (newStatus && typeof api?.getGroupInfo === "function") {
    try {
      const res = await api.getGroupInfo(threadId);
      const gridInfo = res?.gridInfoMap?.[threadId];
      const botUid = String(api?.getOwnId?.() || api?.getBotId?.() || getBotId() || "");
      if (gridInfo && botUid && botUid !== "-1") {
        const admins = [gridInfo.creatorId, ...(gridInfo.adminIds || gridInfo.admins || [])].filter(Boolean).map(String);
        if (!admins.includes(botUid)) {
          caption += "\n⚠️ Lưu ý: Hãy cấp Key Bạc/Vàng cho Bot để Bot có quyền xóa sticker.";
        }
      }
    } catch {}
  }

  await sendMessageStateQuote(api, message, caption, newStatus, 300000);
  return isChangeSetting;
}

async function blockAllUser(api, message, threadId, senderId, senderName) {
  try {
    await api.blockUsers(threadId, [senderId]);
    const groupInfo = await getGroupInfoData(api, threadId);
    const userInfo = await getUserInfoData(api, senderId);
    const imagePath = await createBlockSpamLinkImage(
      userInfo,
      groupInfo.name,
      groupInfo.groupType,
      userInfo.gender
    );

    await api.sendMessage(
      {
        msg: `Đã chặn ${senderName} vì gửi sticker!`,
        attachments: imagePath ? [imagePath] : [],
        quote: message,
        ttl: 300000,
      },
      threadId,
      MessageType.GroupMessage
    );

    await clearImagePath(imagePath);
  } catch (error) {
    // Handle error silently
  }
}

async function updateAllStickerWarnings(
  api,
  message,
  threadId,
  senderId,
  senderName,
  threshold
) {
  const currentTime = Date.now();
  const key = `${threadId}:${senderId}`;
  const recent = (stickerWarnings.get(key) || []).filter(
    (time) => currentTime - time < 20 * 60 * 1000
  );
  recent.push(currentTime);
  stickerWarnings.set(key, recent);

  const warnCount = recent.length;

  if (warnCount >= threshold) {
    try {
      await blockAllUser(api, message, threadId, senderId, senderName);
      stickerWarnings.delete(key);
    } catch (error) {
      // Handle error silently
    }
  } else {
    let caption = `⚠️ Cảnh cáo ${senderName}!\nỞ đây Đại Ca tao cấm gửi sticker`;
    if (warnCount === threshold - 1) {
      caption = `⚠️ Cảnh cáo ${senderName}!\nNgừng gửi sticker, trước khi bị kick!`;
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
      threadId,
      MessageType.GroupMessage
    );
  }
}