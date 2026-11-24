import { MessageType } from "../../../api-zalo/models/Message.js";
import { appContext } from "../../../api-zalo/context.js";
import { getProfile } from "../../../commands/mybot/System/mybot-profile-service.js";
const fallbackNameServer = "Thanh Hung";
import {
  buildStyledMessagePayload,
  DEFAULT_STYLE,
  SAFE_COLORS,
} from "../../../commands/mybot/System/mybot-style.js";

export const COLOR_RED = "db342e";
export const COLOR_YELLOW = "f7b503";
export const COLOR_GREEN = "15a85f";
export const SIZE_18 = "18";
export const SIZE_16 = "14";
export const IS_BOLD = true;

function getCurrentBotProfile() {
  try {
    const currentUid = appContext.uid || "admin";
    return getProfile(currentUid);
  } catch {
    return {
      nameServer: fallbackNameServer || "Thanh Hung",
      style: DEFAULT_STYLE,
    };
  }
}

async function sendStyledMessage(api, threadId, type, payloadBuilder, isGroup, senderName, senderId) {
  const attempts = [
    { label: "full", skipQuote: false, skipStyle: false },
    { label: "no-quote", skipQuote: true, skipStyle: false },
    { label: "no-style", skipQuote: true, skipStyle: true },
    { label: "plain", skipQuote: true, skipStyle: true, plain: true },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    try {
      const payload = payloadBuilder(attempt.skipQuote, attempt.skipStyle, attempt.plain);
      await api.sendMessage(payload, threadId, type);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[chat-style] send attempt '${attempt.label}' failed | threadId=${threadId} type=${type}: ${error.message}`);
      continue;
    }
  }
  console.error(`[chat-style] all send attempts failed | threadId=${threadId} type=${type}`, lastError);
  throw lastError;
}

export async function sendMessageInsufficientAuthority(api, message, caption, hasState = true) {
  const senderName = message?.data?.dName || "";
  const senderId = message?.data?.uidFrom || "";
  const threadId = message?.threadId;
  const isGroup = message?.type === MessageType.GroupMessage;
  const iconState = "🚫🚫🚫";
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      const effectiveStyle = {
        ...profile.style,
        color: COLOR_RED,
      };
      return buildStyledMessagePayload({
        style: effectiveStyle,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: caption,
        stateIcon: hasState ? iconState : "",
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl: 60000,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageQuery(api, message, caption, hasState = true) {
  const senderName = message?.data?.dName || "";
  const senderId = message?.data?.uidFrom || "";
  const threadId = message?.threadId;
  const isGroup = message?.type === MessageType.GroupMessage;
  const iconState = "❓❓❓";
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      const effectiveStyle = {
        ...profile.style,
        color: COLOR_RED,
      };
      return buildStyledMessagePayload({
        style: effectiveStyle,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: caption,
        stateIcon: hasState ? iconState : "",
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl: 60000,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageWarning(api, message, caption, hasState = true) {
  const senderName = message?.data?.dName || "";
  const senderId = message?.data?.uidFrom || "";
  const threadId = message?.threadId;
  const isGroup = message?.type === MessageType.GroupMessage;
  const iconState = "🚨🚨🚨";
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      const effectiveStyle = {
        ...profile.style,
        color: COLOR_RED,
      };
      return buildStyledMessagePayload({
        style: effectiveStyle,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: caption,
        stateIcon: hasState ? iconState : "",
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl: 60000,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageComplete(api, message, caption, hasState = true) {
  const senderName = message?.data?.dName || "";
  const senderId = message?.data?.uidFrom || "";
  const threadId = message?.threadId;
  const isGroup = message?.type === MessageType.GroupMessage;
  const iconState = "✅✅✅";
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      const effectiveStyle = {
        ...profile.style,
        color: profile.style?.color || COLOR_RED,
      };
      return buildStyledMessagePayload({
        style: effectiveStyle,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: caption,
        stateIcon: hasState ? iconState : "",
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl: 60000,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageFailed(api, message, caption, hasState = true) {
  const senderName = message?.data?.dName || "";
  const senderId = message?.data?.uidFrom || "";
  const threadId = message?.threadId;
  const isGroup = message?.type === MessageType.GroupMessage;
  const iconState = "❌❌❌";
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      const effectiveStyle = {
        ...profile.style,
        color: COLOR_RED,
      };
      return buildStyledMessagePayload({
        style: effectiveStyle,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: caption,
        stateIcon: hasState ? iconState : "",
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl: 60000,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageStateQuote(api, message, caption, state, ttl = 0, onState = true) {
  const senderName = message?.data?.dName || "";
  const senderId = message?.data?.uidFrom || "";
  const threadId = message?.threadId;
  const isGroup = message?.type === MessageType.GroupMessage;
  const iconState = state ? "✅✅✅" : "❌❌❌";
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      return buildStyledMessagePayload({
        style: profile.style,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: caption,
        stateIcon: onState ? iconState : "",
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl: ttl || 60000,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageState(api, threadId, caption, state, ttl = 0) {
  try {
    const profile = getCurrentBotProfile();
    const iconState = state ? "✅✅✅" : "❌❌❌";
    const payload = buildStyledMessagePayload({
      style: profile.style,
      nameServer: profile.nameServer,
      isGroup: true,
      text: caption,
      stateIcon: iconState,
      ttl,
    });
    await api.sendMessage(payload, threadId, MessageType.GroupMessage);
  } catch (error) {
    console.log(error);
  }
}

export async function sendMessageResultRequest(api, type = MessageType.GroupMessage, threadId, caption, state, ttl = 0) {
  try {
    const profile = getCurrentBotProfile();
    const iconState = state ? "✅✅✅" : "❌❌❌";
    const payload = buildStyledMessagePayload({
      style: profile.style,
      nameServer: profile.nameServer,
      isGroup: type === MessageType.GroupMessage,
      text: caption,
      stateIcon: iconState,
      ttl,
    });
    await api.sendMessage(payload, threadId, type);
  } catch (error) {
    console.log(error);
  }
}

export async function sendMessageFromSQL(api, message, result, hasState = true, ttl = 0) {
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName;
  const isGroup = message.type === MessageType.GroupMessage;
  const profile = getCurrentBotProfile();

  await sendStyledMessage(
    api,
    threadId,
    message.type,
    (skipQuote, skipStyle, plain) => {
      const stateIcon = hasState ? (result.success ? "✅✅✅" : "❌❌❌") : "";
      return buildStyledMessagePayload({
        style: profile.style,
        nameServer: profile.nameServer,
        senderName,
        isGroup,
        text: result.message,
        stateIcon,
        quote: skipQuote ? null : message,
        mentions: skipQuote ? [] : [{ pos: 0, uid: senderId, len: senderName.length }],
        ttl,
        skipStyle,
        skipQuote,
        plain,
      });
    },
    isGroup,
    senderName,
    senderId
  );
}

export async function sendMessageImageNotQuote(api, result, threadId, waitingImagePath, ttl = 0, isUseProphylactic = false) {
  try {
    const profile = getCurrentBotProfile();
    const payload = buildStyledMessagePayload({
      style: profile.style,
      nameServer: profile.nameServer,
      isGroup: true,
      text: result.message,
      mentions: result.mentions,
      ttl,
    });
    payload.attachments = waitingImagePath ? [waitingImagePath] : [];
    payload.isUseProphylactic = isUseProphylactic;

    await api.sendMessage(payload, threadId, MessageType.GroupMessage);
  } catch (error) {
    console.log(error);
  }
}

export async function sendMessageFromSQLImage(api, message, result, hasState = true, waitingImagePath) {
  try {
    const threadId = message.threadId;
    const senderId = message.data?.uidFrom;
    const senderName = message.data?.dName;
    const isGroup = message.type === MessageType.GroupMessage;
    const profile = getCurrentBotProfile();

    const stateIcon = hasState ? (result.success ? "✅✅✅" : "❌❌❌") : "";
    const payload = buildStyledMessagePayload({
      style: profile.style,
      nameServer: profile.nameServer,
      senderName,
      isGroup,
      text: result.message,
      stateIcon,
      mentions: [{ pos: 0, uid: senderId, len: senderName.length }],
    });
    payload.attachments = waitingImagePath ? [waitingImagePath] : [];

    await api.sendMessage(payload, threadId, message.type);
  } catch (error) {
    console.log(error);
  }
}

export async function sendMessageWarningRequest(api, message, objectData, ttl = 0) {
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName;
  const isGroup = message.type === MessageType.GroupMessage;
  const profile = getCurrentBotProfile();

  const effectiveStyle = {
    ...profile.style,
    color: COLOR_RED,
    size: { ...profile.style.size, nameServer: 14 },
  };

  const payload = buildStyledMessagePayload({
    style: effectiveStyle,
    nameServer: objectData.caption,
    senderName,
    isGroup,
    text: "",
    mentions: [{ pos: 0, uid: senderId, len: senderName.length }],
    ttl,
  });
  payload.attachments = objectData.imagePath ? [objectData.imagePath] : [];

  return await api.sendMessage(payload, threadId, message.type);
}

export async function sendMessageProcessingRequest(api, message, objectData, ttl = 0) {
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName;
  const isGroup = message.type === MessageType.GroupMessage;
  const profile = getCurrentBotProfile();

  const effectiveStyle = {
    ...profile.style,
    color: COLOR_YELLOW,
    size: { ...profile.style.size, nameServer: 14 },
  };

  const payload = buildStyledMessagePayload({
    style: effectiveStyle,
    nameServer: objectData.caption,
    senderName,
    isGroup,
    text: "",
    mentions: [{ pos: 0, uid: senderId, len: senderName.length }],
    ttl,
  });
  payload.attachments = objectData.imagePath ? [objectData.imagePath] : [];

  return await api.sendMessage(payload, threadId, message.type);
}

export async function sendMessageCompleteRequest(api, message, objectData, ttl = 0) {
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName;
  const isGroup = message.type === MessageType.GroupMessage;
  const profile = getCurrentBotProfile();

  const effectiveStyle = {
    ...profile.style,
    color: COLOR_GREEN,
    size: { ...profile.style.size, nameServer: 14 },
  };

  const payload = buildStyledMessagePayload({
    style: effectiveStyle,
    nameServer: objectData.caption,
    senderName,
    isGroup,
    text: "",
    mentions: [{ pos: 0, uid: senderId, len: senderName.length }],
    ttl,
  });
  payload.attachments = objectData.imagePath ? [objectData.imagePath] : [];

  return await api.sendMessage(payload, threadId, message.type);
}

export async function sendMessageTag(api, message, objectData, ttl = 0) {
  const threadId = message.threadId;
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName;
  const isGroup = message.type === MessageType.GroupMessage;
  const profile = getCurrentBotProfile();

  const effectiveStyle = {
    ...profile.style,
    color: COLOR_GREEN,
    size: { ...profile.style.size, nameServer: 14 },
  };

  const tempPrefix = isGroup ? senderName + "\n" : "";
  const adjustedMentions = [
    { pos: 0, uid: senderId, len: senderName.length },
    ...(objectData.mentions || []).map((m) => ({
      ...m,
      pos: m.pos + tempPrefix.length,
    })),
  ];

  const payload = buildStyledMessagePayload({
    style: effectiveStyle,
    nameServer: objectData.caption,
    senderName,
    isGroup,
    text: "",
    mentions: adjustedMentions,
    ttl,
  });
  payload.attachments = objectData.imagePath ? [objectData.imagePath] : [];

  return await api.sendMessage(payload, threadId, message.type);
}
