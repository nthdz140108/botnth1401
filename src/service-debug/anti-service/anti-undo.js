import { formatTime, removeMention } from "../../utils/format-util.js";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { isInWhiteList } from "./white-list.js";
import { resolveMessageCacheStore, markUndoMessage } from "../../utils/message-cache.js";
import { findUndoOriginalMessage, extractPhotoUrl } from "./anti-undo-utils.js";

const TIME_SHOW_UNDO_MESSAGE = 60_000 * 60 * 24;

// Cache lưu các mã undo event đã/đang xử lý để chặn báo trùng (duplicate suppression)
const processedUndoKeys = new Map();
const inFlightUndoKeys = new Set();
const MAX_PROCESSED_UNDO_KEYS = 2000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000; // 10 phút

// Hàng đợi xử lý độc lập giữa các nhóm để không bị chặn lẫn nhau
const groupQueues = new Map();
const activeGroupWorkers = new Map();

function getUndoEventKey(undoEvent) {
  const threadId = undoEvent?.data?.idTo || undoEvent?.threadId || "";
  let contentObj = undoEvent?.data?.content ?? undoEvent?.content;
  if (typeof contentObj === "string" && contentObj.trim().startsWith("{")) {
    try {
      contentObj = JSON.parse(contentObj);
    } catch {}
  }
  const cliMsgId = contentObj?.cliMsgId || undoEvent?.data?.cliMsgId || "";
  const msgId = contentObj?.msgId || undoEvent?.data?.msgId || "";
  const globalMsgId = contentObj?.globalMsgId || undoEvent?.data?.globalMsgId || "";
  const id = cliMsgId || msgId || globalMsgId;
  return id ? `${threadId}:${id}` : (undoEvent?.data?.msgId ? `${threadId}:${undoEvent.data.msgId}` : null);
}

function isDuplicateUndo(key) {
  if (!key) return false;
  if (inFlightUndoKeys.has(key)) return true;
  const now = Date.now();
  const seenAt = processedUndoKeys.get(key);
  if (seenAt && (now - seenAt) < DUPLICATE_WINDOW_MS) {
    return true;
  }
  return false;
}

function markUndoProcessed(key) {
  if (!key) return;
  const now = Date.now();
  processedUndoKeys.set(key, now);
  if (processedUndoKeys.size > MAX_PROCESSED_UNDO_KEYS) {
    const oldestAllowed = now - DUPLICATE_WINDOW_MS;
    for (const [k, v] of processedUndoKeys.entries()) {
      if (v < oldestAllowed || processedUndoKeys.size > MAX_PROCESSED_UNDO_KEYS) {
        processedUndoKeys.delete(k);
      }
    }
  }
}

export async function handleAntiUndoCommand(api, message, groupSettings) {
  const content = removeMention(message);
  const parts = content.trim().split(/\s+/);
  const threadId = message.threadId;
  const command = parts[1]?.toLowerCase();

  groupSettings[threadId] ??= {};

  let newStatus;
  if (command === "on") {
    groupSettings[threadId].antiUndo = true;
    newStatus = "bật";
  } else if (command === "off") {
    groupSettings[threadId].antiUndo = false;
    newStatus = "tắt";
  } else {
    groupSettings[threadId].antiUndo = !groupSettings[threadId].antiUndo;
    newStatus = groupSettings[threadId].antiUndo ? "bật" : "tắt";
  }

  const caption = `Chức năng chống thu hồi tin nhắn đã được ${newStatus}!`;
  await sendMessageStateQuote(api, message, caption, groupSettings[threadId].antiUndo, 300000);

  return true;
}

async function processGroupQueue(threadId) {
  if (activeGroupWorkers.get(threadId)) return;
  activeGroupWorkers.set(threadId, true);

  try {
    const queue = groupQueues.get(threadId);
    while (queue && queue.length > 0) {
      const item = queue.shift();
      try {
        await processUndo(
          item.api,
          item.undoEvent,
          item.isAdminBox,
          item.groupSettings,
          item.botIsAdminBox,
          item.isSelf,
          item.undoKey
        );
      } catch (err) {
        console.error(`[antiundo] Lỗi khi xử lý tin nhắn thu hồi trong nhóm ${threadId}:`, err);
      }
    }
  } finally {
    activeGroupWorkers.delete(threadId);
    if (groupQueues.get(threadId)?.length === 0) {
      groupQueues.delete(threadId);
    }
  }
}

async function processUndo(api, undoEvent, isAdminBox, groupSettings, botIsAdminBox, isSelf, passedUndoKey = null) {
  const threadId = String(undoEvent?.data?.idTo || undoEvent?.threadId || "");
  const senderId = String(undoEvent?.data?.uidFrom || undoEvent?.uidFrom || "");
  const undoKey = passedUndoKey || getUndoEventKey(undoEvent);

  if (!passedUndoKey && undoKey && isDuplicateUndo(undoKey)) {
    console.log(`[antiundo] Bỏ qua sự kiện thu hồi trùng hoặc đang xử lý: ${undoKey}`);
    return;
  }
  if (!passedUndoKey && undoKey) {
    inFlightUndoKeys.add(undoKey);
  }

  try {
    // Quyền ngoại lệ: bot tự gửi, admin box / bot admin / admin tối cao, danh sách trắng, hoặc nhóm tắt antiUndo
    if (isSelf) {
      console.log(`[antiundo] Bỏ qua sự kiện thu hồi: người gửi là bot (${senderId})`);
      return;
    }
    if (isAdminBox) {
      console.log(`[antiundo] Bỏ qua sự kiện thu hồi: người gửi là quản trị viên (${senderId})`);
      return;
    }
    if (isInWhiteList(groupSettings, threadId, senderId)) {
      console.log(`[antiundo] Bỏ qua sự kiện thu hồi: người gửi trong whitelist (${senderId})`);
      return;
    }
    if (!groupSettings[threadId]?.antiUndo) {
      console.log(`[antiundo] Bỏ qua sự kiện thu hồi: nhóm ${threadId} chưa bật antiUndo`);
      return;
    }

    // Tra cứu tin nhắn gốc trong đúng cache theo định danh runtime của bot
    const cacheStore = resolveMessageCacheStore(api);
    const lookup = findUndoOriginalMessage(cacheStore, undoEvent);
    if (!lookup.message) {
      console.warn("[antiundo] ignored undo event", {
        threadId,
        senderId,
        reason: lookup.reason,
      });
      return;
    }
    const originalMessage = lookup.message;

    const senderName = originalMessage.dName || "Người dùng";
    const timestamp = formatTime(new Date());
    const baseContent = `👤 ${senderName} đã thu hồi tin nhắn sau...\n` +
      `⏰ Thời gian gửi: ${originalMessage.timestampString || "Không rõ"}\n` +
      `🔔 Thời gian thu hồi: ${timestamp}\n` +
      `📝 Nội Dung: `;

    async function sendBaseMessage(additionalContent = "") {
      return await api.sendMessageForward(
        {
          msg: baseContent + additionalContent,
        },
        threadId,
        originalMessage.type,
        TIME_SHOW_UNDO_MESSAGE
      );
    }

    let success = false;

    const messageHandlers = {
      webchat: async () => {
        const textContent = typeof originalMessage.content === "string"
          ? originalMessage.content
          : (originalMessage.content?.title || originalMessage.content?.description || JSON.stringify(originalMessage.content));
        await sendBaseMessage(textContent);
        success = true;
      },

      "chat.text": async () => {
        const textContent = typeof originalMessage.content === "string"
          ? originalMessage.content
          : (originalMessage.content?.title || originalMessage.content?.description || JSON.stringify(originalMessage.content));
        await sendBaseMessage(textContent);
        success = true;
      },

      "chat.photo": async () => {
        // Gửi thông báo chữ ngay trước
        await sendBaseMessage("Ảnh...");
        const photoUrl = extractPhotoUrl(originalMessage.content);
        if (!photoUrl) {
          console.warn("[antiundo] Không tìm thấy URL ảnh hợp lệ để khôi phục");
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục ảnh (không tìm thấy URL ảnh hợp lệ)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
          return;
        }

        try {
          await api.sendImage(
            photoUrl,
            originalMessage,
            originalMessage.content?.title || "",
            TIME_SHOW_UNDO_MESSAGE
          );
          success = true;
        } catch (imgError) {
          console.warn("[antiundo] Không gửi lại được ảnh:", imgError?.message || imgError);
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục ảnh (ảnh đã hết hạn hoặc không truy cập được)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
        }
      },

      "chat.gif": async () => {
        await sendBaseMessage("Gif...");
        const gifUrl = extractPhotoUrl(originalMessage.content);
        if (!gifUrl) {
          console.warn("[antiundo] Không tìm thấy URL GIF để khôi phục");
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục GIF (không tìm thấy URL)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
          return;
        }
        try {
          await api.sendGif(
            gifUrl,
            originalMessage,
            originalMessage.content?.title || "",
            TIME_SHOW_UNDO_MESSAGE
          );
          success = true;
        } catch (gifErr) {
          console.warn("[antiundo] Không gửi lại được GIF:", gifErr?.message || gifErr);
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục GIF (GIF đã hết hạn hoặc không truy cập được)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
        }
      },

      "chat.video.msg": async () => {
        await sendBaseMessage("Video...");
        const videoUrl = originalMessage.content?.href || originalMessage.content?.url || originalMessage.content?.videoUrl;
        if (!videoUrl) {
          console.warn("[antiundo] Không tìm thấy URL video để khôi phục");
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục video (không tìm thấy URL video)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
          return;
        }
        try {
          await api.sendVideo({
            videoUrl,
            thumbnail: originalMessage.content?.thumb || originalMessage.content?.thumbUrl,
            threadId,
            threadType: originalMessage.type,
            message: { text: originalMessage.content?.title || "" },
            ttl: TIME_SHOW_UNDO_MESSAGE,
          });
          success = true;
        } catch (videoErr) {
          console.warn("[antiundo] Không gửi lại được video:", videoErr?.message || videoErr);
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục video (video đã hết hạn hoặc máy chủ từ chối gửi)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
        }
      },

      "chat.recommended": async () => {
        if (originalMessage.content?.action === "recommened.link") {
          let params = {};
          try {
            params = typeof originalMessage.content.params === "string"
              ? JSON.parse(originalMessage.content.params)
              : (originalMessage.content.params || {});
          } catch {}
          await sendBaseMessage("Link...");
          try {
            await api.sendMessageForward(
              {
                msg: originalMessage.content.title,
                title: params.mediaTitle,
                src: params.src,
                link: originalMessage.content.href || originalMessage.content.url,
                desc: originalMessage.content.description,
                thumb: originalMessage.content.thumb || originalMessage.content.thumbUrl,
              },
              threadId,
              originalMessage.type,
              TIME_SHOW_UNDO_MESSAGE
            );
            success = true;
          } catch (linkErr) {
            console.warn("[antiundo] Không gửi lại được link:", linkErr?.message || linkErr);
          }
        } else if (originalMessage.content?.action === "recommened.user") {
          let description = {};
          try {
            description = typeof originalMessage.content.description === "string"
              ? JSON.parse(originalMessage.content.description)
              : (originalMessage.content.description || {});
          } catch {}
          await sendBaseMessage();
          try {
            await api.sendBusinessCard(
              null,
              originalMessage.content.params,
              description.phone ? description.phone : null,
              originalMessage.type,
              threadId,
              TIME_SHOW_UNDO_MESSAGE
            );
            success = true;
          } catch (cardErr) {
            console.warn("[antiundo] Không gửi lại được danh thiếp:", cardErr?.message || cardErr);
          }
        }
      },

      "chat.sticker": async () => {
        await sendBaseMessage("Sticker...");
        if (originalMessage.content?.id) {
          try {
            await api.sendSticker(
              {
                id: originalMessage.content.id,
                cateId: originalMessage.content.catId || originalMessage.content.cateId,
                type: originalMessage.content.type,
              },
              threadId,
              originalMessage.type,
              TIME_SHOW_UNDO_MESSAGE
            );
            success = true;
          } catch (stkErr) {
            console.warn("[antiundo] Không gửi lại được sticker:", stkErr?.message || stkErr);
            await api.sendMessageForward(
              { msg: "⚠️ Không thể khôi phục sticker." },
              threadId,
              originalMessage.type,
              TIME_SHOW_UNDO_MESSAGE
            );
          }
        } else {
          console.warn("[antiundo] Thiếu ID sticker");
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục sticker." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
        }
      },

      "chat.voice": async () => {
        await sendBaseMessage("Voice...");
        const voiceUrl = originalMessage.content?.href || originalMessage.content?.url;
        if (!voiceUrl) {
          console.warn("[antiundo] Không tìm thấy URL voice để khôi phục");
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục tin nhắn thoại (không tìm thấy URL voice)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
          return;
        }
        try {
          await api.sendVoice(
            { threadId, type: originalMessage.type },
            voiceUrl,
            TIME_SHOW_UNDO_MESSAGE
          );
          success = true;
        } catch (voiceErr) {
          console.warn("[antiundo] Không gửi lại được voice:", voiceErr?.message || voiceErr);
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục tin nhắn thoại (file voice đã hết hạn)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
        }
      },

      "share.file": async () => {
        await sendBaseMessage("File...");
        let parsedContent = originalMessage.content;
        if (typeof parsedContent === "string") {
          try {
            parsedContent = JSON.parse(parsedContent);
          } catch {}
        }
        let dataFile = {};
        try {
          dataFile = typeof parsedContent?.params === "string"
            ? JSON.parse(parsedContent.params)
            : (parsedContent?.params || {});
        } catch {}
        const fileUrl = parsedContent?.href || parsedContent?.url || dataFile?.href || dataFile?.url;
        if (!fileUrl) {
          console.warn("[antiundo] Không tìm thấy URL file để khôi phục");
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục file (không tìm thấy liên kết file)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
          return;
        }
        try {
          await api.sendFile(
            originalMessage,
            fileUrl,
            TIME_SHOW_UNDO_MESSAGE,
            parsedContent?.title || "Tập tin",
            dataFile.fileSize,
            dataFile.fileExt,
            dataFile.checksum
          );
          success = true;
        } catch (fileErr) {
          console.warn("[antiundo] Không gửi lại được file:", fileErr?.message || fileErr);
          await api.sendMessageForward(
            { msg: "⚠️ Không thể khôi phục file (file đã hết hạn hoặc không thể tải)." },
            threadId,
            originalMessage.type,
            TIME_SHOW_UNDO_MESSAGE
          );
        }
      },
    };

    const handler = messageHandlers[originalMessage.msgType] || messageHandlers["chat.text"];
    if (handler) {
      await handler();
      // CHỈ ĐÁNH DẤU ĐÃ XỬ LÝ KHI GỬI THÀNH CÔNG
      if (success) {
        originalMessage.isUndo = true;
        if (originalMessage.cliMsgId) {
          if (typeof cacheStore?.markUndo === "function") {
            cacheStore.markUndo(originalMessage.cliMsgId);
          } else {
            markUndoMessage(originalMessage.cliMsgId);
          }
        }
        markUndoProcessed(undoKey);
      }
    }
  } finally {
    if (undoKey) {
      inFlightUndoKeys.delete(undoKey);
    }
  }
}

export async function antiUndoGroup(api, undoEvent, isAdminBox, groupSettings, botIsAdminBox, isSelf) {
  const undoKey = getUndoEventKey(undoEvent);
  if (isDuplicateUndo(undoKey)) {
    console.log(`[antiundo] Bỏ qua sự kiện thu hồi trùng hoặc đang xử lý: ${undoKey}`);
    return;
  }
  if (undoKey) {
    inFlightUndoKeys.add(undoKey);
  }

  const threadId = String(undoEvent?.data?.idTo || undoEvent?.threadId || "default");
  let queue = groupQueues.get(threadId);
  if (!queue) {
    queue = [];
    groupQueues.set(threadId, queue);
  }
  queue.push({ api, undoEvent, isAdminBox, groupSettings, botIsAdminBox, isSelf, undoKey });

  processGroupQueue(threadId).catch((err) => {
    console.error(`[antiundo] Worker error for group ${threadId}:`, err);
  });
}

export const __test = {
  getUndoEventKey,
  isDuplicateUndo,
  markUndoProcessed,
  processedUndoKeys,
  inFlightUndoKeys,
  groupQueues,
  processUndo,
};
