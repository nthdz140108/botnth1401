import path from "node:path";
import { sendLocalVideoWithFallback } from "../../service-debug/chat-zalo/chat-special/send-video/send-video.js";
import { uploadAudioFile } from "../../service-debug/chat-zalo/chat-special/send-voice/process-audio.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { appContext } from "../../api-zalo/context.js";
import { getProfile } from "../mybot/System/mybot-profile-service.js";
import { buildStyledMessagePayload, DEFAULT_STYLE } from "../mybot/System/mybot-style.js";
import { MEDIA_KIND_IMAGE, MEDIA_KIND_AUDIO, MEDIA_KIND_VIDEO, mediaKindOf } from "./media.js";

const FALLBACK_NAME_SERVER = "Thanh Hung";

function currentBotStyleProfile() {
  try {
    const profile = getProfile(appContext.uid || "admin");
    if (profile?.nameServer) {
      return {
        nameServer: profile.nameServer,
        style: profile.style || DEFAULT_STYLE,
      };
    }
  } catch {
    // fallthrough
  }
  return { nameServer: "", style: DEFAULT_STYLE };
}

function resolveBotHeader(botName) {
  const profile = currentBotStyleProfile();
  const name = String(botName || "").trim() || profile.nameServer || FALLBACK_NAME_SERVER;
  return { name, style: profile.style };
}

export async function sendCustomCommand(api, message, customCommand, { botName = "", senderName = "" } = {}) {
  const text = String(customCommand?.text ?? "");
  const kind = mediaKindOf(customCommand);
  const quote = message;
  const header = resolveBotHeader(botName);

  if (kind === MEDIA_KIND_VIDEO) {
    const filePath = customCommand?.media?.path;
    if (!filePath) {
      return sendStyledText(api, message, text, { botName, senderName, quote });
    }
    const ok = await sendLocalVideoWithFallback({
      api,
      message,
      videoFiles: [filePath],
      caption: plainCaption(text, header.name),
      ttl: 180000,
      propagateErrors: false,
    });
    if (ok) return true;
    return sendStyledText(api, message, text, { botName, senderName, quote });
  }

  if (kind === MEDIA_KIND_IMAGE) {
    const filePath = customCommand?.media?.path;
    if (!filePath) {
      return sendStyledText(api, message, text, { botName, senderName, quote });
    }
    await sendStyledText(api, message, text, { botName, senderName, quote });
    try {
      await api.sendMessage(
        {
          msg: "",
          attachments: [filePath],
          ttl: 180000,
        },
        message.threadId,
        message.type
      );
    } catch (error) {
      console.warn(`[cmdadd] image send failed after styled text sent: ${error?.message || error}`);
    }
    return true;
  }

  if (kind === MEDIA_KIND_AUDIO) {
    const voiceFile = customCommand?.media?.path;
    await sendStyledText(api, message, text, { botName, senderName, quote });
    if (voiceFile) {
      const voiceUrl = await uploadAudioFile(voiceFile, api, message);
      if (voiceUrl) await api.sendVoice(message, voiceUrl, 600000);
    }
    return true;
  }

  return sendStyledText(api, message, text, { botName, senderName, quote });
}

export async function sendStyledText(api, message, text, { botName = "", senderName = "", quote = message } = {}) {
  const header = resolveBotHeader(botName);
  const payload = buildStyledMessagePayload({
    style: header.style,
    nameServer: header.name,
    senderName: senderName || "",
    isGroup: message.type === MessageType.GroupMessage,
    text,
    quote,
    ttl: 60000,
  });
  await api.sendMessage(payload, message.threadId, message.type);
  return true;
}

function plainCaption(text, botName) {
  const bot = String(botName || "").trim();
  if (!text) return bot;
  return bot ? `${bot}\n${text}` : text;
}
