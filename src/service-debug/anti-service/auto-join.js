import { LRUCache } from "lru-cache";
import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getBotId } from "../../utils/env.js";
import { isAdmin } from "../../utils/role-policy.js";
import { sendMessageStateQuote, sendMessageCompleteRequest } from "../chat-zalo/chat-style/chat-style.js";
import { getGroupInfoData } from "../info-service/group-info.js";
import { getUserInfoData } from "../info-service/user-info.js";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";
import { writeGroupSettings } from "../../utils/io-json.js";
import { scanQRCode } from "../utilities/qr-scan.js";
import { performance } from 'perf_hooks';
import {
  startInteractionCountdown,
  completeInteractionCountdown,
  cancelInteractionCountdown,
} from "../../utils/interaction-countdown.js";
const waitingActionJoinGroup = 30000;
const requestAutoJoinMap = new LRUCache({ max: 500, ttl: waitingActionJoinGroup * 2 });
function normalizeLink(link) {
  if (!link) return null;
  const normalized = link.replace(/[\s\u200B-\u200D\uFEFF]/g, '')
                        .replace(/[^\w\-.:\/]/g, '')
                        .toLowerCase();
  if (normalized.includes('zaloapp.com/qr/g/')) {
    const groupId = normalized.match(/zaloapp\.com\/qr\/g\/([a-z0-9]+)/)?.[1];
    return groupId ? `https://zalo.me/g/${groupId}` : null;
  }
  return normalized;
}
async function processJoinLink(api, message, link, threadId, senderId, senderName) {
   const normalizedLink = normalizeLink(link);
   if (!normalizedLink || !normalizedLink.includes('zalo.me/g/')) {
     return false;
   }
   try {
     await api.joinGroup(normalizedLink);
     await sendMessageStateQuote(api, message, "Đã tham gia nhóm thành công!", true, 180000);
     return true;
   } catch (error) {
     if (error.message.includes("Waiting for approve")) {
       const caption = "Đã gửi yêu cầu tham gia nhóm, đang chờ phê duyệt!";
       await sendMessageCompleteRequest(
         api,
         message,
         { caption },
         180000
       );
     }
     return false;
   }
 }
export async function handleAutoJoin(api, message, groupSettings, botIsAdminBox, isSelf) {
  const startTime = performance.now();
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const threadId = message.threadId;
  if (isSelf ) {
    return false;
  }
  const isUserWhiteList = isInWhiteList(groupSettings, threadId, senderId);
  if (isUserWhiteList) {
    return false;
  }

  if (!groupSettings[threadId]?.autoJoin) {
    return false;
  }

  if (!isAdmin(senderId, threadId)) {
    return false;
  }

  let link = null;
  if (message.data.msgType === "chat.recommended") {
    link = message.data.content?.href;
  } else if (message.data.msgType === "chat.photo") {
    const linkImage = message.data?.content?.href;
    if (linkImage) {
      const result = await scanQRCode(linkImage);
      if (result.success) {
        link = result.data.content;
      }
    }
  } else if (typeof message.data.content === 'string') {
    const content = message.data.content.trim();
    const links = content.match(/(?:https?:\/\/|www\.)[^\s/$.?#].[^\s]*|\b[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?/gi) || [];
    link = links.find(l => l.includes('zalo.me/g/') || l.includes('zaloapp.com/qr/g/'));
  }

  if (link) {
    await processJoinLink(api, message, link, threadId, senderId, senderName);
    return true;
  }

  return false;
}

export const handleAutoJoinCommand = async (api, message, groupSettings) => {
   const { threadId } = message;
   if (!groupSettings[threadId]) groupSettings[threadId] = {};
   const newStatus = !groupSettings[threadId].autoJoin;
   const caption = newStatus ? "Xác nhận bật bằng cách thả reaction ❤️!" : "Chức năng tự động tham gia đã được tắt!";
   if (newStatus) {
     const msgResponse = await sendMessageCompleteRequest(api, message, { caption }, waitingActionJoinGroup);
     const msgId = msgResponse?.message?.msgId?.toString() || "";
     requestAutoJoinMap.set(msgId, { message, groupSettings, timestamp: Date.now(), action: "enable" });
     startInteractionCountdown({
       key: `auto_join_${msgId}`,
       api,
       message: msgResponse,
       messageContext: message,
       seconds: Math.floor(waitingActionJoinGroup / 1000) || 30,
       deleteOnExpire: true,
       onExpire: async () => {
         requestAutoJoinMap.delete(msgId);
       },
     });
   } else {
     groupSettings[threadId].autoJoin = false;
     writeGroupSettings(groupSettings);
     await sendMessageStateQuote(api, message, caption, false, 30000);
   }
   return true;
 };
export async function handleReactionConfirmAutoJoin(api, reaction) {
  const msgId = reaction?.data?.content?.rMsg?.[0]?.gMsgID?.toString?.() || reaction?.messageID || "";
  if (!msgId) return false;
  const data = requestAutoJoinMap.get(msgId);
  if (!data) return false;
    const senderId = reaction.data.uidFrom;
    if (senderId !== data.message.data.uidFrom) return false;
    const rType = reaction.data.content.rType;
    if (rType !== 5) return false;
    const message = data.message;
    const threadId = message.threadId;
    completeInteractionCountdown(`auto_join_${msgId}`);
    requestAutoJoinMap.delete(msgId);
    if (data.action === "enable") {
      const targetSettings = data.groupSettings || data.message.groupSettings || {};
      if (!targetSettings[threadId]) {
        targetSettings[threadId] = {};
      }
      targetSettings[threadId].autoJoin = true;
      writeGroupSettings(targetSettings);
      await sendMessageStateQuote(api, message, "Chức năng tự động tham gia đã được bật!", true, 30000);
      return true;
    }
    return false;
  }