import { LRUCache } from "lru-cache";
import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { sendMessageStateQuote, sendMessageState, sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { getBotId } from "../../utils/env.js";
import { isInWhiteList } from "./white-list.js";

const CACHE_DURATION = 10000;
const tagBehaviorMap = new LRUCache({ max: 5000, ttl: 60000 });
const checkDelete = new LRUCache({ max: 2000, ttl: 25000 });
const groupInfoCache = new LRUCache({ max: 1000, ttl: CACHE_DURATION });
const getShortUid = (uid) => String(uid).slice(0, 12);
async function getGroupInfoData(api, threadId) {
  if (!threadId) {
    await sendMessageState(api, threadId, "Lỗi: threadId không hợp lệ!", "warning", 60000);
    return null;
  }
  const now = Date.now();
  const cachedData = groupInfoCache.get(threadId);
  if (cachedData && (now - cachedData.timestamp) < CACHE_DURATION) {
    return cachedData.data;
  }
  try {
    if (!api.getGroupInfo) {
      throw new Error("api.getGroupInfo không tồn tại");
    }
    const groupInfoResponse = await api.getGroupInfo(threadId);
    if (!groupInfoResponse || !groupInfoResponse.gridInfoMap || !groupInfoResponse.gridInfoMap[threadId]) {
      throw new Error(`Không tìm thấy gridInfoMap hoặc threadId ${threadId}`);
    }
    const gridInfo = groupInfoResponse.gridInfoMap[threadId];
    const processedInfo = {
      creatorId: String(gridInfo.creatorId) || null,
      adminIds: (gridInfo.adminIds || gridInfo.admins || []).map(String) 
    };
    if (processedInfo.creatorId && !processedInfo.adminIds.includes(processedInfo.creatorId)) {
      processedInfo.adminIds.push(processedInfo.creatorId);
    }
    groupInfoCache.set(threadId, {
      data: processedInfo,
      timestamp: now
    });
    return processedInfo;
  } catch (error) {
    console.warn("Không thể lấy thông tin nhóm:", error);
    await sendMessageState(api, threadId, "Lỗi: Không thể lấy danh sách quản trị viên nhóm!", "warning", 60000);
    return {};
  }
}
function checkTagBehavior(senderId, mentionsCount, threadId) {
  const now = Date.now();
  const scopedKey = `${threadId}:${senderId}`;
  if (!tagBehaviorMap.has(scopedKey)) {
    tagBehaviorMap.set(scopedKey, {
      count: 1,
      timestamps: [now],
      threadId: threadId
    });
    return false;
  }
  const userData = tagBehaviorMap.get(scopedKey);
  const tenSecondsAgo = now - 30000; 
  userData.timestamps = userData.timestamps.filter(time => time > tenSecondsAgo);
  userData.timestamps.push(now);
  userData.count = userData.timestamps.length;
  if (userData.count >= 2 && mentionsCount > 3) {
    tagBehaviorMap.delete(scopedKey); 
    return true;
  }
  return false;
}
export async function handleSetupAntiCommand(api, message, groupSettings) {
  const threadId = message.threadId;
  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {
      enableSetup: false,
      antiMention: false
    };
  }
  const content = removeMention(message).trim();
  const parts = content.split(/\s+/).filter(Boolean);
  const action = parts[1]?.toLowerCase();

  let newStatus;
  if (!action) {
    newStatus = !groupSettings[threadId].enableSetup;
  } else if (action === "on") {
    newStatus = true;
  } else if (action === "off") {
    newStatus = false;
  } else {
    await sendMessageWarning(api, message, "Cú pháp không hợp lệ. Sử dụng antisetup hoặc antisetup [on/off]");
    return false;
  }

  groupSettings[threadId].enableSetup = newStatus;
  groupSettings[threadId].antiMention = newStatus;
  const statusText = newStatus ? "bật" : "tắt";
  const caption = `Chức năng bảo vệ đã được ${statusText}!`;
  await sendMessageStateQuote(api, message, caption, newStatus, 300000);
  return true;
}
export async function superCheckBox(api, message, isSelf, botIsAdminBox, isAdminBox, groupSettings) {
  const threadId = message.threadId;
  const senderName = message.data.dName || "Thành viên";
  const senderId = String(message.data.uidFrom); 
  const mentionsCount = message.data?.mentions?.length || 0;
  const ttl = message.data?.ttl;
  const isWebchat = message.data?.msgType === 'webchat';
  const isChatDelete = message.data?.msgType === 'chat.delete';
  if (isChatDelete && groupSettings[threadId]?.enableSetup) {
    if (!threadId) {
      await sendMessageState(api, threadId, "Lỗi: threadId không hợp lệ!", "warning", 60000);
      return false;
    }
    const groupInfo = await getGroupInfoData(api, threadId);
    const creatorId = String(groupInfo?.creatorId); 
    const adminIds = groupInfo?.adminIds || [];
    if (!groupInfo || !adminIds.length) {
      await sendMessageState(api, threadId, "Lỗi: Không thể lấy danh sách quản trị viên nhóm!", "warning", 60000);
      return false;
    }
    const resolvedBotUid = api?.getOwnId?.() || api?.getBotId?.() || getBotId();
    const uid = resolvedBotUid && resolvedBotUid !== -1 ? String(resolvedBotUid) : "";
    if (!uid) {
      await sendMessageState(api, threadId, "Lỗi: Không thể lấy UID của bot!", "warning", 60000);
      return false;
    }
    if (uid !== creatorId) {
      return false;
    }
    if (getShortUid(senderId) === getShortUid(creatorId)) {
      return false;
    }
    const content = message.data?.content;
    const targetId = Array.isArray(content) && content[0]?.uidFrom ? String(content[0].uidFrom) : null;
    if (!targetId) {
      return false;
    }
    if (getShortUid(senderId) === getShortUid(targetId)) {
      return false;
    }
    const spammerKey = `${threadId}:${senderId}`;
    if (checkDelete.has(spammerKey)) {
      return false;
    }
    const shortAdminIds = adminIds.map(getShortUid);
    const isSenderAdmin = shortAdminIds.includes(getShortUid(senderId));
    const isTargetAdmin = shortAdminIds.includes(getShortUid(targetId));
    if (isSenderAdmin && isTargetAdmin) {
      checkDelete.set(spammerKey, true);
      const caption = `[ ${senderName} ]\nAnh nhắc em!!!`;
      const messagePayload = {
        mentions: [MessageMention(senderId, senderName.length, 2)],
        ttl: 8600000
      };
      if (!isWebchat) {
        messagePayload.quote = message;
      }

      try {
        await sendMessageState(api, threadId, caption, "warning", 8600000, messagePayload);
        await api.blockUsers(threadId, [senderId]);
        const timer = setTimeout(() => checkDelete.delete(spammerKey), 20000);
        timer.unref?.();
        return true;
      } catch (error) {
        checkDelete.delete(spammerKey);
        return false;
      }
    } else {
      return false;
    }
  }
  if (isSelf || isAdminBox || !botIsAdminBox || !groupSettings[threadId]?.enableSetup || isInWhiteList(groupSettings, threadId, senderId)) {
    return false;
  }
  if (typeof ttl === 'number' && ttl > 0 && ttl < 6000) {
    const caption = `${senderName} Phát hiện hành vi bất thường, tiến hành loại trừ..!`;
    const messagePayload = {
      mentions: [MessageMention(senderId, senderName.length, 0)],
      ttl: 60000
    };
    if (!isWebchat) {
      messagePayload.quote = message;
    }
    await sendMessageState(api, threadId, caption, "warning", 60000, messagePayload);
    try {
      await api.blockUsers(threadId, [senderId]);
      return true;
    } catch (error) {
      return false;
    }
  }
  if (groupSettings[threadId]?.enableSetup && groupSettings[threadId]?.antiMention && mentionsCount > 0) {
    const isSpammingTags = checkTagBehavior(senderId, mentionsCount, threadId);
    if (mentionsCount >= 10 || isSpammingTags) {
      const caption = `${senderName} Tag nhiều thế cu, cút đi!`;
      const messagePayload = {
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 60000
      };
      if (!isWebchat) {
        messagePayload.quote = message;
      }

      await sendMessageState(api, threadId, caption, "warning", 60000, messagePayload);
      try {
        await api.blockUsers(threadId, [senderId]);
        return true;
      } catch (error) {
        return false;
      }
    }
  }

  return false;
}