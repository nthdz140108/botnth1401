import fs from "fs/promises";
import path from "path";
import schedule from "node-schedule";
import chalk from "chalk";
import axios from "axios";
import { LRUCache } from 'lru-cache';
import { handleSendTrackZingMp3 } from "./music/zingmp3.js";
import { removeMention } from "../../utils/format-util.js";
import { getMessageCache, getMessageCacheByMsgId } from "../../utils/message-cache.js";
import { getBotId } from "../../utils/env.js";
import { isAdmin } from "../../utils/role-policy.js";
import { handleSendTrackSoundCloud } from "./music/soundcloud.js";
import { handleSendTrackNhacCuaTui } from "./music/nhaccuatui.js";
import { handleSendMediaYoutube } from "./youtube/youtube-service.js";
import { deleteFile } from "../../utils/util.js";
import { sendTikTokMedia, sendTikTokVideo } from "./tiktok/tiktok-service.js";
import { handleSendTemplateCapcut } from "./capcut/capcut-service.js";
import { processAndSendMedia } from "./api-hoangdev/aio-downlink.js";
import { handleSpotifyDownloadReply } from "./spotify/spotify-downlink.js";
import { canContinueReply } from "../reply-access.js";
import {
  sendMessageCompleteRequest,
  sendMessageProcessingRequest,
  sendMessageWarningRequest,
} from "../chat-zalo/chat-style/chat-style.js";

import {
  openMediaSelection,
  startInteractionCountdown,
  completeInteractionCountdown,
  cancelInteractionCountdown,
  normalizeMessageReference,
  extractMessageId,
} from "../../utils/interaction-countdown.js";

const TIME_TO_SELECT = 60000;

// Không TTL ở đây: countdown 60 giây của bảng chọn là đồng hồ hết hạn duy nhất.
export const selectionsMapData = new LRUCache({
  max: 500
});

// Tra cứu phụ theo message ID của bảng chọn (dùng cho reply có quote).
const selectionsByPromptId = new Map();

export const getSelectionsMapData = () => selectionsMapData;

function normalizePromptIds(sentMessage) {
  const primary = extractMessageId(sentMessage);
  const ids = new Set();
  if (primary) ids.add(String(primary));
  const inner = Array.isArray(sentMessage?.message) ? sentMessage.message[0] : sentMessage?.message;
  const attachment0 = Array.isArray(sentMessage?.attachment) ? sentMessage.attachment[0] : sentMessage?.attachment;
  for (const candidate of [
    sentMessage?.data?.globalMsgId,
    sentMessage?.globalMsgId,
    inner?.data?.globalMsgId,
    inner?.globalMsgId,
    attachment0?.data?.globalMsgId,
    attachment0?.globalMsgId,
    sentMessage?.data?.msgId,
    sentMessage?.msgId,
    inner?.data?.msgId,
    inner?.msgId,
    attachment0?.data?.msgId,
    attachment0?.msgId,
  ]) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      ids.add(String(candidate));
    }
  }
  return [...ids];
}

function removeRecordIndexes(record) {
  if (!record) return;
  const ownerKey = record.userRequest;
  if (ownerKey !== undefined && ownerKey !== null && selectionsMapData.get(ownerKey) === record) {
    selectionsMapData.delete(ownerKey);
  }
  for (const promptId of record._promptIds || []) {
    if (selectionsByPromptId.get(promptId) === record) {
      selectionsByPromptId.delete(promptId);
    }
  }
}

async function disposeOwnedTemps(record) {
  if (!record || record._tempsDisposed) return;
  record._tempsDisposed = true;
  const paths = Array.isArray(record.ownedTempPaths) ? record.ownedTempPaths : [];
  for (const tempPath of paths) {
    if (!tempPath) continue;
    try {
      await deleteFile(tempPath);
    } catch (error) {
      console.warn(
        `[Selection:${record.platform || "unknown"}] temp cleanup failed for ${tempPath}: ${error?.message || error}`
      );
    }
  }
}

async function finalizeSelectionRecord(record, status) {
  if (!record || record._terminal) return;
  record._terminal = true;
  record.status = status;
  removeRecordIndexes(record);
  try {
    if (record.userRequest !== undefined && record.userRequest !== null) {
      await completeInteractionCountdown(`selection_${record.userRequest}`);
    }
  } catch (error) {
    console.warn(`[Selection:${record.platform || "unknown"}] countdown completion failed: ${error?.message || error}`);
  }
  await disposeOwnedTemps(record);
}

function lockSelectionInFlight(record) {
  if (!record || record._terminal) return false;
  if (record.status !== "open") return false;
  record.status = "inFlight";
  return true;
}

function unlockSelectionInFlight(record) {
  if (!record || record._terminal) return;
  if (record.status === "inFlight" && record.selectionSession?.isOpen?.()) {
    record.status = "open";
  }
}

async function registerSelectionRecord(idUser, data) {
  if (!data.api || !data.sentMessage || !data.messageContext) {
    throw new Error(`[Selection:${data.platform || "unknown"}] requires api, sentMessage, and messageContext`);
  }

  const previous = selectionsMapData.get(idUser);
  if (previous) {
    try {
      if (previous.selectionSession?.cancel) {
        await previous.selectionSession.cancel();
      }
    } catch (error) {
      console.warn(`[Selection] previous session cancel failed: ${error?.message || error}`);
    }
    removeRecordIndexes(previous);
    void disposeOwnedTemps(previous);
  }

  const selectionSession = openMediaSelection({
    key: `selection_${idUser}`,
    api: data.api,
    prompt: data.sentMessage,
    messageContext: data.messageContext,
    seconds: data.seconds,
    schedule: data.schedule,
    cancelSchedule: data.cancelSchedule,
    now: data.now,
    onExpire: async () => {
      await finalizeSelectionRecord(record, "expired");
      await data.onExpire?.();
    },
  });

  const record = {
    ...data,
    status: "open",
    userRequest: idUser,
    selectionSession,
    promptMessageId: extractMessageId(data.sentMessage),
    ownedTempPaths: Array.isArray(data.ownedTempPaths)
      ? [...data.ownedTempPaths]
      : data.ownedTempPaths
        ? [data.ownedTempPaths]
        : [],
    resendPrompt: typeof data.resendPrompt === "function" ? data.resendPrompt : null,
  };
  record._promptIds = normalizePromptIds(data.sentMessage);
  record._terminal = false;
  record._tempsDisposed = false;
  Object.defineProperty(record, "_sourceData", { value: data, enumerable: false });

  selectionsMapData.set(idUser, record);
  for (const promptId of record._promptIds) {
    selectionsByPromptId.set(promptId, record);
  }
  return record;
}

export async function setSelectionsMapData(idUser, data) {
  return await registerSelectionRecord(idUser, data || {});
}

export function findSelectionsMapDataByPromptId(promptMsgId) {
  if (promptMsgId === undefined || promptMsgId === null) return null;
  return selectionsByPromptId.get(String(promptMsgId)) || null;
}

export function findSelectionRecordForMessage(message) {
  const quoteId =
    message?.data?.quote?.globalMsgId ??
    message?.data?.quote?.msgId ??
    null;
  if (quoteId !== null) {
    return findSelectionsMapDataByPromptId(quoteId);
  }
  const senderId = message?.data?.uidFrom;
  if (senderId === undefined || senderId === null) return null;
  return selectionsMapData.get(senderId) || null;
}

/**
 * Gửi lại bảng chọn với message ID mới và countdown 60 giây mới sau một lần
 * tải/gửi thất bại. Preview temp được chuyển quyền sở hữu sang record mới và
 * KHÔNG bị xóa giữa các lần thử.
 */
export async function reopenSelectionsMapData(record) {
  if (!record || record._terminal) return null;
  const owner = record.userRequest;
  const platform = record.platform || "unknown";

  if (typeof record.resendPrompt !== "function") {
    console.warn(`[Selection:${platform}] cannot reopen: no resendPrompt configured`);
    await finalizeSelectionRecord(record, "expired");
    return null;
  }

  let newListMessage;
  try {
    newListMessage = await record.resendPrompt({ api: record.api });
  } catch (error) {
    console.error(`[Selection:${platform}] failed to resend selection menu: ${error?.message || error}`);
    await finalizeSelectionRecord(record, "expired");
    return null;
  }

  const inheritedTemps = Array.isArray(record.ownedTempPaths) ? [...record.ownedTempPaths] : [];
  record._tempsDisposed = true; // chuyển quyền sở hữu temp sang record mới

  const nextData = {
    ...(record._sourceData || {}),
    sentMessage: newListMessage,
    timestamp: Date.now(),
    ownedTempPaths: inheritedTemps,
  };
  const newPromptId = extractMessageId(newListMessage);
  if (newPromptId) {
    nextData.quotedMsgId = String(newPromptId);
  }

  try {
    return await registerSelectionRecord(owner, nextData);
  } catch (error) {
    console.error(`[Selection:${platform}] failed to register reopened session: ${error?.message || error}`);
    record._tempsDisposed = false;
    await finalizeSelectionRecord(record, "expired");
    return null;
  }
}

function createSelectionClaim(idUser, replyMessage, targetRecord = null) {
  return async () => {
    const record = targetRecord || selectionsMapData.get(idUser);
    if (!record?.selectionSession?.claim) return false;
    const result = await record.selectionSession.claim(null, replyMessage);
    if (!result.ok) return false;
    return true;
  };
}

export async function claimSelectionsMapData(idUser, replyMessage) {
  return await createSelectionClaim(idUser, replyMessage)();
}

export function releaseSelectionsMapData(idUser, selectionSession) {
  if (!idUser || !selectionSession) return false;
  const record = selectionsMapData.get(idUser);
  if (record && record.selectionSession === selectionSession) {
    removeRecordIndexes(record);
    return true;
  }
  return false;
}

export async function deleteSelectionsMapData(idUser) {
  const record = selectionsMapData.get(idUser);
  if (record) {
    await finalizeSelectionRecord(record, "completed");
    return;
  }
  completeInteractionCountdown(`selection_${idUser}`);
}

async function dispatchResolvedSelection(api, message, record, media, selectedIndex, modifier) {
  const senderId = message.data.uidFrom;

  if (typeof record.onSelect !== "function") {
    const claimed = await claimSelectionsMapData(record.userRequest, message);
    if (!claimed) return false;
    switch (record.platform) {
      case "zingmp3":
        return await handleSendTrackZingMp3(api, message, media, modifier);
      case "soundcloud":
        return await handleSendTrackSoundCloud(api, message, media);
      case "nhaccuatui":
        return await handleSendTrackNhacCuaTui(api, message, media);
      case "youtube": {
        const videoPath = null;
        try {
          await handleSendMediaYoutube(api, message, media, modifier || "default", videoPath, isAdmin(senderId));
        } catch (error) {
          if (videoPath) await deleteFile(videoPath);
        }
        return true;
      }
      case "tiktok":
        return await sendTikTokMedia(api, message, media, { typeVideo: modifier || "540p" });
      case "capcut":
        return await handleSendTemplateCapcut(api, message, media);
      case "downlink": {
        const { uniqueId, mediaType, title, duration = 0, author } = record;
        await processAndSendMedia(api, message, {
          selectedMedia: media,
          mediaType,
          uniqueId,
          duration,
          title,
          author,
          senderId,
          senderName: message.data.dName
        });
        return true;
      }
      case "spotify":
        return await handleSpotifyDownloadReply(api, message);
    }
    return false;
  }

  if (record.status === "inFlight") {
    await sendMessageProcessingRequest(api, message, {
      caption: "Đang xử lý lựa chọn này, vui lòng chờ một chút.",
    }, 30000);
    return true;
  }

  if (!lockSelectionInFlight(record)) {
    await sendMessageProcessingRequest(api, message, {
      caption: "Đang xử lý lựa chọn này, vui lòng chờ một chút.",
    }, 30000);
    return true;
  }

  let claimed = false;
  let claimAttempted = false;
  let thrownError = null;
  let rawOutcome = null;
  const claimFn = async () => {
    claimAttempted = true;
    const result = await record.selectionSession.claim(null, message);
    claimed = Boolean(result?.ok);
    return claimed;
  };

  try {
    rawOutcome = await record.onSelect(media, selectedIndex, modifier, message, claimFn);
  } catch (error) {
    thrownError = error;
    console.error(`[Selection:${record.platform || "unknown"}] onSelect failed:`, error);
  }

  const outcome =
    thrownError
      ? { ok: false }
      : rawOutcome === true
        ? { ok: true }
        : rawOutcome === false || rawOutcome === undefined || rawOutcome === null
          ? { ok: false }
          : { ok: rawOutcome.ok === true };

  if (outcome.ok) {
    await finalizeSelectionRecord(record, "completed");
    return thrownError ? true : rawOutcome?.handled !== false;
  }

  if (claimed) {
    await reopenSelectionsMapData(record);
    return true;
  }

  unlockSelectionInFlight(record);
  if (thrownError) return false;
  // Người thua trong race claim phải trả false; còn validation chặn trước claim
  // (đã cảnh báo người dùng) thì tin nhắn được tính là đã xử lý.
  return claimAttempted ? false : rawOutcome?.handled !== false;
}

export async function checkReplySelectionsMapData(api, message) {
  const senderId = message.data.uidFrom;

  const quote = message.data?.quote;
  if (quote) {
    const quoteId = quote.globalMsgId ?? quote.msgId;
    if (quoteId === undefined || quoteId === null) return false;
    const record = findSelectionsMapDataByPromptId(quoteId);
    if (!record) return false;
    if (!canContinueReply(record, senderId, message.threadId)) return false;

    const collection = Array.isArray(record.collection) ? record.collection : null;
    const selection = removeMention(message);
    const [selectedIndexRaw, modifier] = selection.trim().split(/\s+/);
    const selectedIndex = parseInt(selectedIndexRaw, 10) - 1;
    if (!collection || isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= collection.length) {
      await sendMessageWarningRequest(api, message, {
        caption: "Lựa chọn không hợp lệ hoặc không còn trong danh sách. Vui long chon lai.",
      }, 30000);
      return true;
    }
    return await dispatchResolvedSelection(api, message, record, collection[selectedIndex], selectedIndex, modifier);
  }

  if (!selectionsMapData.has(senderId)) {
    return false;
  }
  const record = selectionsMapData.get(senderId);
  if (!canContinueReply(record, senderId, record?.requireThreadMatch ? message.threadId : undefined)) {
    return false;
  }

  const selection = removeMention(message);
  const [selectedIndexRaw, subCommand] = selection.split(" ");
  const selectedIndex = parseInt(selectedIndexRaw, 10) - 1;
  if (isNaN(selectedIndex)) {
    return false;
  }
  const collection = Array.isArray(record.collection) ? record.collection : null;
  if (!collection || selectedIndex < 0 || selectedIndex >= collection.length) {
    return false;
  }
  const media = collection[selectedIndex];

  return await dispatchResolvedSelection(api, message, record, media, selectedIndex, subCommand);
};
