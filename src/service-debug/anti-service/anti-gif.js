import { LRUCache } from "lru-cache";
import { removeMention } from "../../utils/format-util.js";
import { sendMessageStateQuote, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { MessageMention, MessageType } from "../../api-zalo/models/index.js";
import { getGroupInfoData } from "../info-service/group-info.js";
import { getUserInfoData } from "../info-service/user-info.js";
import { createBlockSpamLinkImage } from "../../utils/canvas/event-image.js";
import { clearImagePath } from "../../utils/canvas/index.js";
import { isInWhiteList } from "./white-list.js";

const gifWarnings = new LRUCache({ max: 3000, ttl: 20 * 60 * 1000 });
const gifCooldown = new LRUCache({ max: 3000, ttl: 10 * 1000 });

function isGifMessage(message) {
  const msgType = String(message?.data?.msgType || "");
  const content = message?.data?.content;
  if (msgType === "chat.gif") return true;
  if (content && typeof content === "object") {
    if (content.action === "recommend.gif") return true;
    const href = String(content.href || content.normalUrl || content.thumb || "");
    if (/\.gif(\?|$)/i.test(href)) return true;
  }
  return false;
}

export async function handleAntiGif(api, message, groupSettings) {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const content = removeMention(message).trim();
  const parts = content.split(/\s+/).filter(Boolean);

  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  const option = parts[1]?.toLowerCase();
  if (!option) {
    groupSettings[threadId].antiGif = !groupSettings[threadId].antiGif;
  } else if (option === "on") {
    groupSettings[threadId].antiGif = true;
  } else if (option === "off") {
    groupSettings[threadId].antiGif = false;
  } else {
    await sendMessageWarning(api, message, `❌ Sai cú pháp. Dùng: ${prefix}antigif [on/off]`);
    return false;
  }

  const status = groupSettings[threadId].antiGif ? "bật" : "tắt";
  await sendMessageStateQuote(
    api,
    message,
    `Chức năng chống gửi GIF đã ${status}!`,
    groupSettings[threadId].antiGif,
    300000
  );
  return true;
}

export async function antiAllEffectGif(
  api,
  message,
  isAdminBox,
  groupSettings,
  botIsAdminBox,
  isSelf
) {
  const senderId = message?.data?.uidFrom;
  const senderName = message?.data?.dName || "Thành viên";
  const threadId = message?.threadId;

  if (
    !senderId ||
    !threadId ||
    isSelf ||
    isAdminBox ||
    !botIsAdminBox ||
    !groupSettings?.[threadId]?.antiGif ||
    isInWhiteList(groupSettings, threadId, senderId)
  ) {
    return false;
  }

  if (!isGifMessage(message)) {
    return false;
  }

  const key = `${threadId}:${senderId}`;
  const currentTime = Date.now();
  const lastCooldown = gifCooldown.get(key) || 0;
  if (currentTime - lastCooldown < 800) {
    await api.deleteMessage(message, false).catch(() => {});
    return true;
  }
  gifCooldown.set(key, currentTime);

  const threshold = Number(groupSettings[threadId]?.rules?.rule_giflag?.threshold) || 3;

  try {
    const result = await api.deleteMessage(message, false);
    if (result && result.status !== undefined && result.status !== 0) {
      await blockGifViolator(api, message, threadId, senderId, senderName);
      return true;
    }

    await updateAllGifWarnings(api, message, threadId, senderId, senderName, threshold);
    return true;
  } catch {
    return false;
  }
}

async function blockGifViolator(api, message, threadId, senderId, senderName) {
  try {
    await api.blockUsers(threadId, [senderId]);
    const groupInfo = await getGroupInfoData(api, threadId).catch(() => null);
    const userInfo = await getUserInfoData(api, senderId).catch(() => null);
    let imagePath = null;
    if (groupInfo && userInfo) {
      imagePath = await createBlockSpamLinkImage(
        userInfo,
        groupInfo.name,
        groupInfo.groupType,
        userInfo.gender
      ).catch(() => null);
    }

    await api.sendMessage(
      {
        msg: `🚫 Thành viên [ ${senderName} ] đã bị chặn vì gửi GIF khi nhóm đang bật chống GIF!`,
        attachments: imagePath ? [imagePath] : [],
        quote: message,
        ttl: 300000,
      },
      threadId,
      MessageType.GroupMessage
    );

    if (imagePath) {
      await clearImagePath(imagePath).catch(() => {});
    }
  } catch {}
}

async function updateAllGifWarnings(api, message, threadId, senderId, senderName, threshold) {
  const key = `${threadId}:${senderId}`;
  const currentTime = Date.now();
  const prev = gifWarnings.get(key) || [];
  const active = prev.filter((time) => currentTime - time < 20 * 60 * 1000);
  active.push(currentTime);

  if (active.length >= threshold) {
    gifWarnings.delete(key);
    await blockGifViolator(api, message, threadId, senderId, senderName);
    return;
  }

  gifWarnings.set(key, active);
  const caption = active.length === threshold - 1
    ? `⚠️ Cảnh cáo ${senderName}!\nNgừng gửi GIF ngay trước khi bị chặn khỏi nhóm!`
    : `⚠️ Cảnh cáo ${senderName}!\nNhóm hiện đang cấm gửi ảnh động GIF!`;

  await api.sendMessage(
    {
      msg: caption,
      mentions: [MessageMention(senderId, senderName.length, "⚠️ Cảnh cáo ".length)],
      quote: message,
      ttl: 300000,
    },
    threadId,
    MessageType.GroupMessage
  ).catch(() => {});
}
