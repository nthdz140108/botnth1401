import { LRUCache } from "lru-cache";
import { MessageMention } from "../api-zalo/models/index.js";
import { MessageType } from "../api-zalo/models/Message.js";
import { antiPhoneNumber } from "../service-debug/anti-service/anti-phone-number.js";
import { antiBotCheck } from "../service-debug/anti-service/anti-bot.js";
import { getConnectedClientsCount, getIO } from "../web-service/web-server.js";
import { getBotId, isAdmin, admins, checkDisableProphylacticConfig } from "../index.js";
import { resolveInstanceAuthorization } from "../utils/instance-authorization.js";
import { logAuthorizationDecision } from "../utils/authorization-log.js";
import { getInstanceKind } from "../utils/env.js";
import { readGroupSettings } from "../utils/io-json.js";
import { antiTag } from "../service-debug/anti-service/anti-tag.js";
import { antiLink } from "../service-debug/anti-service/anti-link.js";
import { antiSpam } from "../service-debug/anti-service/anti-spam.js";
import { antiBadWord } from "../service-debug/anti-service/anti-badword.js";
import { antiNotText } from "../service-debug/anti-service/anti-not-text.js";
import { handleMute } from "../service-debug/anti-service/mute-user.js";
import { antiEffectSticker } from "../service-debug/anti-service/anti-stickerlag.js";
import { antiStickerEffect } from "../service-debug/anti-service/anti-stickereffect.js";
import { antiVideo } from "../service-debug/anti-service/anti-video.js";
import { antiAllEffectGif } from "../service-debug/anti-service/anti-gif.js";
import { superCheckBox } from "../service-debug/anti-service/setup-anti.js";
import { Reactions } from "../api-zalo/index.js";
import { handleOnChatUser, handleOnReplyFromUser, getGlobalPrefix } from "../service-debug/service.js";
import { handleQcInput } from "../service-debug/qc/index.js";
import { enforceAntiFile } from "../service-debug/anti-service/anti-file.js";
import { enforceAntiPhotoVideo } from "../service-debug/anti-service/anti-photo.js";
import { enforceAntiText } from "../service-debug/anti-service/anti-text.js";
import { enforceAntiVoice } from "../service-debug/anti-service/anti-voice.js";
import { antiAllEffectSticker } from "../service-debug/anti-service/anti-sticker.js";
import { antiForward } from "../service-debug/anti-service/anti-forward.js";
import { runMessageProtection } from "./message-protection.js";
import {
  clearAwaitingPrefix,
  clearPrefixCountdown,
  isExpired,
  cleanupExpired,
  findAwaitingPrefixByMessageId,
  extractQrLoginQuotedMessageId,
  extractPrefixFromReply,
} from "../utils/qr-login-prefix-state.js";
import { applyPrefixToBot } from "../commands/mybot/Manager/qr-login-command.js";
import {
  checkSpawnedProcessStatus,
  killSpawnedProcess,
  startBotWithLauncher,
} from "../commands/mybot/System/pm2-manager.js";
import {
  persistBotPrefix,
  applyPrefixAndRestart,
  restartBotAfterStop,
} from "../utils/qr-login-prefix-workflow.js";

//import { chatWithSimsimi } from "../service-debug/chat-bot/simsimi/simsimi-api.js";
import { handleChatBot } from "../service-debug/chat-bot/bot-learning/dqt-bot.js";
import { handleScoldFreeChat } from "../service-debug/chat-bot/scold-user/scold-user.js";
import { getGroupAdmins, getGroupInfoData } from "../service-debug/info-service/group-info.js";
import { getUserInfoData } from "../service-debug/info-service/user-info.js";
import { handleDownloadZalo } from "../service-debug/api-crawl/download/auto-download.js";
import { handleAdminHighLevelCommands } from "../commands/bot-manager/admin-manager.js";
import { handleAutoReplyGemini } from "../service-debug/api-crawl/assistant-ai/auto-reply.js";
import { updateUserRank } from "../service-debug/info-service/rank-chat.js";
import { pushMessageToWebLog } from "../utils/io-json.js";
import { handlePrefixCommand } from "../commands/bot-manager/prefix.js";
import { handleCommand, initGroupSettings, handleCommandPrivate } from "../commands/command.js";
import { logMessageToFile, readWebConfig, readAdmins, isMainBotAdmin } from "../utils/io-json.js";
import { terminalLog } from "../utils/terminal-log.js";
import { handleAutoJoin } from "../service-debug/anti-service/auto-join.js";
import { antiNude } from "../service-debug/anti-service/anti-nude/anti-nude.js";
import { isUserBlocked } from "../commands/bot-manager/group-manage.js";
import { canProcessChat } from "./chat-access-policy.js";
import { handleCalls } from "../commands/bot-check/replytag.js";
import { trackLocmemMessage } from "../service-debug/locmem/index.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";

const COOLDOWN_TIME = 1000;
const userLastMessageTime = new LRUCache({ max: 5000, ttl: 60 * 1000 });

const BUSINESS_CARD_COOLDOWN = 60 * 60 * 1000;
const lastBusinessCardTime = new LRUCache({ max: 5000, ttl: BUSINESS_CARD_COOLDOWN });
let lastProphylacticCheckMs = 0;

async function restartQrLoginBot(botUid) {
  // Use restartBotRuntime which goes through PM2 adapter internally.
  return restartBotAfterStop({
    botUid,
    checkStatus: checkSpawnedProcessStatus,
    killBot: killSpawnedProcess,
    startBot: startBotWithLauncher, // already PM2-backed (no CMD windows)
  });
}

async function canReplyToUser(senderId) {
  const currentTime = Date.now();
  const lastMessageTime = userLastMessageTime.get(senderId);

  if (!lastMessageTime || currentTime - lastMessageTime >= COOLDOWN_TIME) {
    userLastMessageTime.set(senderId, currentTime);
    return true;
  }
  return false;
}

async function handleQrLoginPrefixReply(api, message) {
  const senderId = message?.data?.uidFrom || '';
  const quote = message?.data?.quote || {};
  const quotedMessageId = extractQrLoginQuotedMessageId(quote);
  if (!quote || typeof quote !== "object" || Object.keys(quote).length === 0) return false;

  cleanupExpired();

  const matchedEntry = findAwaitingPrefixByMessageId(quotedMessageId, senderId, message.threadId);
  if (!matchedEntry || isExpired(matchedEntry)) return false;
  const matchedBotUid = matchedEntry.workspaceUid;

  const prefixResult = extractPrefixFromReply(message);
  if (!prefixResult.valid) {
    if (prefixResult.reason === "empty_or_mention_only") {
      await api.sendMessage(
        {
          msg: `⚠️ Prefix không được rỗng hoặc chỉ chứa mention!\n👉 Vui lòng reply lại tin nhắn này với ký tự prefix bạn muốn đặt (ví dụ: ! hoặc ? hoặc .)`,
          quote: message,
          ttl: 30000,
        },
        message.threadId,
        message.type
      );
      // Keep session waiting, do not clear countdown or awaiting prefix
      return true;
    }

    await api.sendMessage(
      {
        msg: `❌ Prefix không hợp lệ: ${prefixResult.error || "Chỉ chấp nhận 1-3 ký hiệu lệnh như !, ?, ., /, #, $, %, &, *, -, _, +"}\n👉 Vui lòng reply lại ký hiệu prefix hợp lệ.`,
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
    // Keep session waiting for retry
    return true;
  }

  const newPrefix = prefixResult.prefix;
  clearPrefixCountdown(matchedBotUid);
  try {
    const appliedPrefix = await persistBotPrefix(matchedBotUid, newPrefix);
    clearAwaitingPrefix(matchedBotUid);
    await api.sendMessage(
      {
        msg: `✅ Prefix của bot đã được đặt thành: ${appliedPrefix}\n📌 Bot hiện đang ở trạng thái Tạm dừng (stopped). Dùng lệnh '!mybot start' để khởi động bot.`,
        quote: message,
        ttl: 60000,
      },
      message.threadId,
      message.type
    );
  } catch (err) {
    console.error(`[ERROR] Failed to apply prefix: ${err.message}`);
    await api.sendMessage(
      {
        msg: `❌ Đã xảy ra lỗi khi đặt prefix: ${err.message}`,
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
    clearAwaitingPrefix(matchedBotUid);
  }
  return true;
}

export const eventSendMsgHooks = {
  handleQcInput: (context) => handleQcInput(context),
  handleOnChatUser: (...args) => handleOnChatUser(...args),
  handleOnReplyFromUser: (...args) => handleOnReplyFromUser(...args),
  handleCommand: (...args) => handleCommand(...args),
  handleScoldFreeChat: (...args) => handleScoldFreeChat(...args),
};

export async function checkAndSendBusinessCard(api, senderId, senderName) {
  if (getInstanceKind() !== "main") return false;
  const promoText = typeof process.env.BOT_PROMO_TEXT === "string" ? process.env.BOT_PROMO_TEXT.trim() : "";
  if (!promoText) return false;
  if (isAdmin(senderId)) return false;

  const currentTime = Date.now();
  const lastSentTime = lastBusinessCardTime.get(senderId);

  if (!lastSentTime || currentTime - lastSentTime >= BUSINESS_CARD_COOLDOWN) {
    lastBusinessCardTime.set(senderId, currentTime);
    const idBot = getBotId();
    await api.sendMessage(
      {
        msg: promoText,
      },
      senderId,
      MessageType.DirectMessage
    );
    const adminList = Array.isArray(admins) && admins.length > 0 ? admins : readAdmins();
    if (Array.isArray(adminList) && typeof api.sendBusinessCard === "function") {
      for (const userId of adminList) {
        if (userId && String(userId) !== String(idBot)) {
          await api.sendBusinessCard(null, userId, null, MessageType.DirectMessage, senderId);
        }
      }
    }
    return true;
  }
  return false;
}

function maybeCheckProphylacticConfig() {
  const now = Date.now();
  if (now - lastProphylacticCheckMs >= 60 * 1000) {
    lastProphylacticCheckMs = now;
    try {
      checkDisableProphylacticConfig();
    } catch {}
  }
}

export async function messagesUser(api, message) {
  maybeCheckProphylacticConfig();
  const senderId = message?.data?.uidFrom || '';
  const threadId = message?.threadId || '';
  let content = message?.data?.content || '';
  const isPlainText = typeof message.data.content === "string";
  const senderName = message?.data?.dName || '';
  const privateAuthorization = resolveInstanceAuthorization({
    senderId,
    threadId: "",
    instanceUid: getBotId(),
    instanceKind: getInstanceKind(),
  });
  let isAdminLevelHighest = privateAuthorization.isAdminLevelHigh;
  let callerIsBotAdmin = privateAuthorization.isBotAdmin;
  const idBot = getBotId();
  const io = getIO();
  let isSelf = idBot === senderId;
  const contentText = isPlainText
    ? content
    : content.href
      ? "Caption: " + content.title + "\nLink: " + content.href
      : content.catId
        ? "Sticker ID: " + content.id + " | " + content.catId + " | " + content.type
        : null;

  if (!message || !message.data || !threadId || !senderId) {
    return;
  }

  const webConfig = readWebConfig();
  const privateEnabled = webConfig.privateEnabled !== false;
  const groupEnabled = webConfig.groupEnabled !== false;

  if (message.type === MessageType.DirectMessage && !canProcessChat({
    chatScope: "private",
    privateEnabled,
    isGlobalAdmin: isAdminLevelHighest,
  })) {
    logAuthorizationDecision({
      instanceKind: privateAuthorization.instanceKind,
      instanceUid: privateAuthorization.instanceUid,
      senderId,
      threadId,
      scope: "private",
      role: privateAuthorization.role,
      source: privateAuthorization.source,
      verdict: "gate-denied",
      detail: "private-disabled",
    });
    return;
  }

  switch (message.type) {
    case MessageType.DirectMessage: {
      if (getConnectedClientsCount() > 0) {
        let userAvatar = '';
        try {
          const userInfo = await getUserInfoData(api, senderId);
          userAvatar = userInfo?.avatar || '';
        } catch (avatarError) {
          userAvatar = '';
        }
        pushMessageToWebLog(io, "Tin Nhắn Riêng Tư", senderName, content, userAvatar);
      }
      if (contentText) {
        const logMessage = `Có Mesage Riêng tư mới:
              - Sender Name: [ ${senderName} ] | ID: ${threadId}
              - Content: ${contentText}\n`;
        logMessageToFile(logMessage);
        terminalLog({
          scope: "private",
          fields: [
            { label: "FROM", value: senderName, meta: `Sender ID: ${senderId}`, tone: "yellow" },
            { label: "CONTENT", value: contentText },
          ],
          countAsMessage: true,
        });
      }
      if (!isUserBlocked(senderId) && await eventSendMsgHooks.handleQcInput({
        api, message, prefix: getGlobalPrefix(), authorizationSnapshot: privateAuthorization,
      })) break;
      if (contentText && contentText.toLowerCase().startsWith("uid"))
        api.sendMessage({msg: senderId, ttl: 60000, quote: message}, threadId, message.type);
      const scoldStopped = await eventSendMsgHooks.handleScoldFreeChat(api, message);
      if (scoldStopped) break;

      if (isPlainText) {
        const barePrefixMatch = typeof contentText === "string" && contentText.trim().toLowerCase() === "prefix";
        if (barePrefixMatch) {
          await handlePrefixCommand(api, message, privateAuthorization.isAdminLevelHigh);
          break;
        }

        let continueProcessingChat = true;
        continueProcessingChat = !isUserBlocked(senderId);
        continueProcessingChat = continueProcessingChat && (await canReplyToUser(senderId));
        const handledPrefixReply = await handleQrLoginPrefixReply(api, message);
        continueProcessingChat = continueProcessingChat && !handledPrefixReply;

        if (continueProcessingChat) {
          const dmGroupSettings = readGroupSettings();
          const dmReplyHandled = await eventSendMsgHooks.handleOnReplyFromUser(
            api,
            message,
            {},
            [],
            dmGroupSettings,
            privateAuthorization.isAdminLevelHigh,
            privateAuthorization.isBotAdmin,
            privateAuthorization.isAdminLevelHigh || privateAuthorization.isBotAdmin,
            true
          );
          continueProcessingChat = !dmReplyHandled;
        }
        if (continueProcessingChat) {
          const commandResult = await handleCommandPrivate(api, message, privateAuthorization);
          continueProcessingChat = continueProcessingChat && commandResult === 1 && isSelf;
          continueProcessingChat =
            continueProcessingChat && !(!isSelf && (await checkAndSendBusinessCard(api, senderId, senderName)));
        }
      }
      break;
    }
    case MessageType.GroupMessage: {
      try {
        trackLocmemMessage(api, message, getRuntimeContext());
      } catch (err) {
        console.error("[locmem] trackLocmemMessage error:", err);
      }
      let groupAdmins = [];
      let nameGroup = "";
      let isAdminBox = false;
      let botIsAdminBox = false;
      let groupInfo = {};
      let groupAuthorization = null;
      const groupSettings = readGroupSettings();
      if (threadId) {
        groupInfo = await getGroupInfoData(api, threadId);
        groupAdmins = await getGroupAdmins(groupInfo);
        botIsAdminBox = groupAdmins.includes(idBot.toString());
        nameGroup = groupInfo?.name || '';
        groupAuthorization = resolveInstanceAuthorization({
          senderId,
          threadId,
          instanceUid: idBot,
          instanceKind: getInstanceKind(),
          groupSettings,
        });
        isAdminBox = groupAuthorization.role !== "member" || groupAdmins.includes(String(senderId));
      }

      const effectiveAuthorization = groupAuthorization || privateAuthorization;

      if (!canProcessChat({
        chatScope: "group",
        groupEnabled,
        isGlobalAdmin: effectiveAuthorization.isAdminLevelHigh,
        isBotAdmin: effectiveAuthorization.isBotAdmin,
        isGroupAdmin: isAdminBox,
      })) {
        logAuthorizationDecision({
          instanceKind: effectiveAuthorization.instanceKind,
          instanceUid: effectiveAuthorization.instanceUid,
          senderId,
          threadId,
          scope: "group",
          role: effectiveAuthorization.role,
          source: effectiveAuthorization.source,
          verdict: "gate-denied",
          detail: "group-disabled",
        });
        return;
      }
      if (effectiveAuthorization.isBotAdmin) {
        logAuthorizationDecision({
          instanceKind: effectiveAuthorization.instanceKind,
          instanceUid: effectiveAuthorization.instanceUid,
          senderId,
          threadId,
          scope: "group",
          role: effectiveAuthorization.role,
          source: effectiveAuthorization.source,
          verdict: "gate-passed",
        });
      }

      if (contentText) {
        const logMessage = `Có Mesage nhóm mới:
              - Tên Nhóm: ${nameGroup} | Group ID: ${threadId}
              - Người Gửi: ${senderName} | Sender ID: ${senderId}
              - Nội Dung: ${contentText}\n`;
        logMessageToFile(logMessage);
        terminalLog({
          scope: "group",
          fields: [
            { label: "GROUP", value: nameGroup, meta: `Group ID: ${threadId}`, tone: "cyan" },
            { label: "FROM", value: senderName, meta: `Sender ID: ${senderId}`, tone: "yellow" },
            { label: "CONTENT", value: contentText },
          ],
          countAsMessage: true,
        });
      }

      initGroupSettings(groupSettings, threadId, nameGroup);
      if (getConnectedClientsCount() > 0) {
        pushMessageToWebLog(io, nameGroup, senderName, content, groupInfo?.avt || '');
      }

      if (threadId && senderId) {
        updateUserRank(threadId, senderId, message.data?.dName || senderName, nameGroup);
      }

      let handleChat = true;
      // Key vàng (trưởng nhóm) hoặc key bạc (phó nhóm) quyết định bot có
      // thể thu hồi tin nhắn của thành viên trong nhóm này hay không. Đây là
      // năng lực riêng của bot, tách biệt khỏi `isAdminBox` (quyền gọi lệnh).
      const botCanDeleteGroupMessages = (() => {
        const creatorId = groupInfo?.creatorId ? String(groupInfo.creatorId) : "";
        const adminIds = Array.isArray(groupInfo?.adminIds) ? groupInfo.adminIds : [];
        const botIdStr = idBot ? String(idBot) : "";
        if (!botIdStr) return false;
        if (creatorId && creatorId === botIdStr) return true;
        return adminIds.map((id) => String(id)).includes(botIdStr);
      })();

      let muted = false;
      try {
        muted = await handleMute(api, message, groupSettings, {
          isAdminBox,
          botCanDeleteGroupMessages,
          isSelf,
        });
      } catch (muteErr) {
        // A throwing mute layer must not crash the listener; treat as muted
        // so the rest of the pipeline still skips chat/command processing.
        console.error("[event-send-msg] handleMute threw:", muteErr?.message || muteErr);
        muted = true;
      }
      const badWordHandled = !muted && await antiBadWord(
        api,
        message,
        groupSettings,
        isAdminBox,
        botIsAdminBox,
        isSelf
      );
      const setupHandled = !muted && !badWordHandled && await superCheckBox(
        api,
        message,
        isSelf,
        botIsAdminBox,
        isAdminBox,
        groupSettings
      );
      let protectionHandled = badWordHandled || setupHandled;
      if (!muted && !protectionHandled && message && message.data && threadId && senderId) {
        const protectionResult = await runMessageProtection({
          context: { api, message, threadId, senderId },
          rules: [
            {
              name: "antiBot",
              action: "block",
              enabled: () => Boolean(groupSettings[threadId]?.enableAntiBot && !isAdminBox && !isSelf),
              run: () => antiBotCheck(api, message, groupSettings, isAdminBox, isSelf),
            },
            {
              name: "onlyText",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.onlyText),
              run: () => antiNotText(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiPhotoVideo",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiPhotoVideo),
              run: () => enforceAntiPhotoVideo(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiVideo",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiVideo),
              run: () => antiVideo(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiAllEffectGif",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiGif),
              run: () => antiAllEffectGif(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiVoice",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiVoice),
              run: () => enforceAntiVoice(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiText",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiText),
              run: () => enforceAntiText(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiFile",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiFile),
              run: () => enforceAntiFile(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiForward",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.blockForward),
              run: () => antiForward(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiLink",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.removeLinks || groupSettings[threadId]?.antiLink),
              run: () => antiLink(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiPhoneNumber",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.antiPhoneNumber || groupSettings[threadId]?.antiPhone),
              run: () => antiPhoneNumber(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiTag",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.removeTags),
              run: () => antiTag(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiSpam",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiSpam),
              run: () => antiSpam(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiNude",
              action: "delete",
              enabled: () => Boolean(botIsAdminBox && !isAdminBox && !isSelf && groupSettings[threadId]?.antiNude),
              run: () => antiNude(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiStickerEffect",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.antiStickerEffect),
              run: () => antiStickerEffect(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiEffectSticker",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.allowStickerlag),
              run: () => antiEffectSticker(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
            {
              name: "antiAllEffectSticker",
              action: "delete",
              enabled: () => Boolean(groupSettings[threadId]?.allowSticker),
              run: () => antiAllEffectSticker(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf),
            },
          ],
        });
        protectionHandled = protectionResult.handled;
      }
      const userBlocked = isUserBlocked(senderId);
      handleChat = !muted && !protectionHandled;
      handleChat = handleChat && !userBlocked;
      isAdminLevelHighest = effectiveAuthorization.isAdminLevelHigh;
      callerIsBotAdmin = effectiveAuthorization.isBotAdmin;
      if (handleChat && await eventSendMsgHooks.handleQcInput({
        api, message, prefix: getGlobalPrefix(), authorizationSnapshot: effectiveAuthorization,
      })) break;
      // QC content gets first claim after protection; free-chat helpers must
      // not consume advertisements such as "prefix", "uid..." or "tha".
      if (handleChat) {
        const scoldStopped = await eventSendMsgHooks.handleScoldFreeChat(api, message, groupAdmins);
        if (scoldStopped) break;
        if (isPlainText) {
          if (await handleQrLoginPrefixReply(api, message)) break;
          if (typeof contentText === 'string' && contentText.trim().toLowerCase() === 'prefix') {
            await handlePrefixCommand(api, message, effectiveAuthorization.isAdminLevelHigh);
            break;
          }
        }
      }
      const canProcessReply = handleChat && (
        groupSettings[threadId]?.activeBot === true || callerIsBotAdmin
      );
      const numberHandleCommand = await eventSendMsgHooks.handleCommand(
        api,
        message,
        groupInfo,
        groupAdmins,
        groupSettings,
        isAdminLevelHighest,
        callerIsBotAdmin,
        isAdminBox,
        handleChat,
        effectiveAuthorization
      );
      let mediaReplyHandled = false;
      if (isPlainText) {
        const shouldHandleOnChatUser = handleChat && groupSettings[threadId]?.activeBot === true && isSelf;
        if (shouldHandleOnChatUser || callerIsBotAdmin) {
          await eventSendMsgHooks.handleOnChatUser(api, message, numberHandleCommand === 5, groupSettings, groupInfo);
        }
        handleChat = handleChat && groupSettings[threadId]?.activeBot === true;
        handleChat = handleChat && isSelf;
        if (canProcessReply || (callerIsBotAdmin && !protectionHandled && !muted && !userBlocked)) {
          const replyHandled = await eventSendMsgHooks.handleOnReplyFromUser(
            api,
            message,
            groupInfo,
            groupAdmins,
            groupSettings,
            isAdminLevelHighest,
            callerIsBotAdmin,
            isAdminBox,
            true
          );
          if (replyHandled) { handleChat = true; mediaReplyHandled = true; }
        }
        if (
          !muted &&
          !protectionHandled &&
          !isSelf &&
          !userBlocked &&
          groupSettings[threadId]?.activeBot === true &&
          groupSettings[threadId]?.ifMentioned === true
        ) {
          const replyTagHandled = await handleCalls(
            api,
            message,
            groupSettings,
            senderId,
            senderName,
            isSelf,
          );
          if (replyTagHandled) handleChat = false;
        }
        if (!protectionHandled && !muted && !userBlocked) {
          await handleChatBot(api, message, threadId, groupSettings, nameGroup, numberHandleCommand === 2);
        }
      }

      if (!message || !message.data || !threadId || !senderId) {
        return;
      }

      if (!protectionHandled && !muted) {
        const isGroupActiveBot = groupSettings[threadId]?.activeBot === true;
        await Promise.all([
          isGroupActiveBot && !userBlocked
            ? handleAutoReplyGemini(api, message, groupSettings, isSelf)
            : false,
          !mediaReplyHandled && isGroupActiveBot && !userBlocked
            ? handleDownloadZalo(api, message, groupSettings, isSelf)
            : false,
          handleAutoJoin(api, message, groupSettings, botIsAdminBox, isSelf),
        ]);
      }
      break;
    }
  }
}
