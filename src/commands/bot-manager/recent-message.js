import { getBotId } from "../../utils/env.js";
import { sendMessageStateQuote } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { extractCommandBody, safeThreadType } from "../shared/command-input-utils.js";

const MAX_DELETE_COUNT = 100;

export async function handleDeleteMessage(api, message, groupAdmins, aliasCommand = "deletemessage") {
  const prefixGlobal = getGlobalPrefix(message);
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "deletemessage";
  const keyContent = extractCommandBody(message, prefixGlobal, safeAlias);
  const tokens = keyContent.split(/\s+/).filter(Boolean);
  const rawCountToken = tokens[0] || "";
  const target = (tokens[1] || "").toLowerCase();
  const idBot = getBotId();
  const threadType = safeThreadType(message);
  let countDelete = 0;
  let countDeleteFail = 0;

  const parsedCount = Number.parseInt(rawCountToken, 10);
  const hasExplicitCount = Number.isFinite(parsedCount) && parsedCount > 0;

  if (message.data?.quote && !hasExplicitCount) {
    const quote = message.data.quote;
    const cliMsgId = quote.cliMsgId;
    const msgId = quote.globalMsgId ?? quote.msgId;
    const rawOwner = quote.uidFrom ?? quote.ownerId;
    const uidFrom = !rawOwner || String(rawOwner) === "0" ? idBot : rawOwner;

    let deleted = false;
    if (cliMsgId !== undefined && msgId !== undefined && typeof api?.deleteMessage === "function") {
      try {
        await api.deleteMessage(
          {
            type: threadType,
            threadId: message.threadId,
            data: {
              cliMsgId,
              msgId,
              uidFrom,
            },
          },
          false
        );
        deleted = true;
      } catch {
        deleted = false;
      }
    }

    if (!deleted) {
      deleted = await findAndDeleteMessage(api, message, {
        cliMsgId,
        msgId,
        uidFrom,
      });
    }

    if (deleted) {
      await sendMessageStateQuote(api, message, "Tin nhắn đã được xóa rồi nhé", true, 5000);
    } else {
      await sendMessageStateQuote(api, message, "Không thể xóa hoặc không tìm thấy tin nhắn được reply!", false, 5000);
    }
    return;
  }

  if (!hasExplicitCount) {
    await sendMessageStateQuote(
      api,
      message,
      `Hãy reply tin nhắn cần xóa hoặc nhập số lượng tin nhắn (1–${MAX_DELETE_COUNT}): ${prefixGlobal}${safeAlias} <số_lượng> [@user]`,
      false,
      10000
    );
    return;
  }

  const count = Math.min(parsedCount, MAX_DELETE_COUNT);
  const recentMessage = await getRecentMessage(api, message, count);
  const mentionTarget = [];
  if (Array.isArray(message.data?.mentions)) {
    for (const mention of message.data.mentions) {
      if (mention?.uid) mentionTarget.push(String(mention.uid));
    }
  }

  const filterByMention = mentionTarget.length > 0 && target !== "all";
  const botIdStr = String(idBot || "");

  const deletePromises = recentMessage
    .filter((msg) => {
      if (!filterByMention) return true;
      const msgUid = String(msg.uidFrom ?? "");
      return mentionTarget.includes(msgUid) || (mentionTarget.includes(botIdStr) && msgUid === "0");
    })
    .map((msg) => {
      const msgDel = {
        type: threadType,
        threadId: message.threadId,
        data: {
          cliMsgId: msg.cliMsgId,
          msgId: msg.msgId,
          uidFrom: String(msg.uidFrom) === "0" ? idBot : msg.uidFrom,
        },
      };

      return api
        .deleteMessage(msgDel, false)
        .then(() => {
          countDelete++;
          return true;
        })
        .catch(() => {
          countDeleteFail++;
          return false;
        });
    });

  await Promise.all(deletePromises);

  const caption =
    `${countDelete > 0 ? `Thành công xóa ${countDelete} tin nhắn` : "Không có tin nhắn nào được xóa"}` +
    `${countDeleteFail > 0 ? `\nCó ${countDeleteFail} tin nhắn không xóa được` : ""}`;
  await sendMessageStateQuote(api, message, caption, countDelete > 0, 60000);
}

export async function getRecentMessage(api, message, count = 50) {
  const threadId = message.threadId || message.idTo;
  const globalMsgId = message.data?.msgId || message.msgId;
  const safeCount = Math.min(Math.max(Number(count) || 50, 1), MAX_DELETE_COUNT);
  let allMessages = [];
  let currentMsgId = globalMsgId;

  try {
    if (typeof api?.getRecentMessages !== "function") return [];
    while (allMessages.length < safeCount) {
      const recentMessage = await api.getRecentMessages(threadId, currentMsgId, 50);
      const parsedMessage = typeof recentMessage === "string" ? JSON.parse(recentMessage) : recentMessage;
      const messages = parsedMessage?.groupMsgs;

      if (!Array.isArray(messages) || messages.length === 0) {
        break;
      }

      const sortedBatch = [...messages].sort((a, b) => Number(b.ts) - Number(a.ts));
      allMessages = [...allMessages, ...sortedBatch];
      const nextMsgId = sortedBatch[sortedBatch.length - 1]?.msgId;
      if (!nextMsgId || String(nextMsgId) === String(currentMsgId)) {
        break;
      }
      currentMsgId = nextMsgId;
    }
  } catch (error) {
    console.error("[recent-message] getRecentMessage error:", error?.message || error);
  }

  const sortedMessages = allMessages.sort((a, b) => Number(b.ts) - Number(a.ts));
  return sortedMessages.slice(0, safeCount);
}

async function findAndDeleteMessage(api, message, targetMsg) {
  if (typeof api?.getRecentMessages !== "function") return false;
  const threadId = message.threadId || message.idTo;
  const globalMsgId = message.data?.msgId || message.msgId;
  let currentMsgId = globalMsgId;
  const maxAttempts = 20;
  let attempts = 0;

  const currentTime = Date.now();
  const oneDayInMs = 24 * 60 * 60 * 1000;

  try {
    while (attempts < maxAttempts) {
      const recentMessage = await api.getRecentMessages(threadId, currentMsgId, 50);
      const parsedMessage = typeof recentMessage === "string" ? JSON.parse(recentMessage) : recentMessage;

      if (Array.isArray(parsedMessage?.groupMsgs)) {
        parsedMessage.groupMsgs.sort((a, b) => Number(b.ts) - Number(a.ts));
      }

      const messages = parsedMessage?.groupMsgs;

      if (!Array.isArray(messages) || messages.length === 0) {
        break;
      }

      const lastMessageTime = Number(messages[messages.length - 1].ts);
      if (Number.isFinite(lastMessageTime) && currentTime - lastMessageTime > oneDayInMs) {
        break;
      }

      const foundMsg = messages.find(
        (msg) =>
          String(msg.cliMsgId) === String(targetMsg.cliMsgId) &&
          String(msg.msgId) === String(targetMsg.msgId)
      );

      if (foundMsg) {
        const msgDel = {
          type: safeThreadType(message),
          threadId: message.threadId,
          data: {
            cliMsgId: foundMsg.cliMsgId,
            msgId: foundMsg.msgId,
            uidFrom: String(foundMsg.uidFrom) === "0" ? getBotId() : foundMsg.uidFrom,
          },
        };

        try {
          await api.deleteMessage(msgDel, false);
          return true;
        } catch (error) {
          console.error("Lỗi khi xóa tin nhắn:", error);
          return false;
        }
      }

      const nextMsgId = messages[messages.length - 1]?.msgId;
      if (!nextMsgId || String(nextMsgId) === String(currentMsgId)) {
        break;
      }
      currentMsgId = nextMsgId;
      attempts++;
    }
  } catch (error) {
    console.error("Lỗi khi tìm tin nhắn:", error);
  }

  return false;
}

