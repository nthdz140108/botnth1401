import { appContext } from "../../../api-zalo/context.js";
import { isOutboundMessage } from "../../../api-zalo/outbound-message-registry.js";
import { readDownloadLink, hasCommandPrefix, messageTextParts, claimDownloadMessage } from "./download-input.js";
import { runPlatformDownload, downloadFailureCaption, logDownloadEvent } from "./download-job.js";
import fs from "fs";
import path from "path";
import {
  handleDownloadReply as handleLegacyDownloadReply,
  MEDIA_TYPES,
  getMediaType,
} from "./aio-downlink.js";
import {
  handleDownloadCommand,
  handleDownloadReply as handleHoangdevDownloadReply,
} from "../api-hoangdev/aio-downlink.js";
import { extractCleanArgs } from "../../../commands/shared/command-input-utils.js";
import { getGlobalPrefix } from "../../service.js";
import { sendReactionConfirmReceive } from "../../../commands/command-response.js";
import { sendMessageStateQuote } from "../../chat-zalo/chat-style/chat-style.js";
import { showCooldownClock } from "../../../utils/interaction-countdown.js";
import { getBotId, getProjectRoot } from "../../../utils/env.js";
import { getActiveRuntimeContext } from "../../../utils/io-json.js";
import { getTikTokMedia, getDataDownloadVideo } from "../tiktok/tiktok-api.js";
import { sendTikTokMedia, sendTikTokVideo } from "../tiktok/tiktok-service.js";
import { handleYouTubeAutoDownload } from "./youtube-autodownload.js";
import { normalizeYoutubeUrl } from "../youtube/youtube-service.js";

const legacyConfigPath = path.join(getProjectRoot(), "assets/json-data/command-config.json");
const commandUsage = {};
const cachedConfigsByInstance = new Map();

function resolveActiveBotId() {
  return String(getBotId() || appContext.uid || "admin").trim();
}

function resolveInstanceCooldownPath(botId) {
  const ctx = getActiveRuntimeContext();
  const baseDataDir =
    ctx?.dataDir ||
    path.join(getProjectRoot(), "mybot", "instances", String(botId || "admin"), "data");
  return path.join(baseDataDir, "autodownload-config.json");
}

function loadCommandJson(botId) {
  const key = String(botId || "admin");
  const now = Date.now();
  const cached = cachedConfigsByInstance.get(key);
  if (cached && now - cached.at < 30000) {
    return cached.data;
  }

  const instancePath = resolveInstanceCooldownPath(key);
  try {
    if (fs.existsSync(instancePath)) {
      const parsed = JSON.parse(fs.readFileSync(instancePath, "utf8"));
      const normalized = parsed && Array.isArray(parsed.commands) ? parsed : { commands: [] };
      cachedConfigsByInstance.set(key, { data: normalized, at: now });
      return normalized;
    }
    if (fs.existsSync(legacyConfigPath)) {
      const parsed = JSON.parse(fs.readFileSync(legacyConfigPath, "utf8"));
      const normalized = parsed && Array.isArray(parsed.commands) ? parsed : { commands: [] };
      cachedConfigsByInstance.set(key, { data: normalized, at: now });
      return normalized;
    }
  } catch {}

  const initial = { commands: [] };
  cachedConfigsByInstance.set(key, { data: initial, at: now });
  return initial;
}

function saveCommandJson(botId, data) {
  const key = String(botId || "admin");
  cachedConfigsByInstance.set(key, { data, at: Date.now() });
  const instancePath = resolveInstanceCooldownPath(key);
  fs.promises
    .mkdir(path.dirname(instancePath), { recursive: true })
    .then(() => fs.promises.writeFile(instancePath, JSON.stringify(data, null, 2), "utf8"))
    .catch(() => {});
}

function getCommandCountdown(botId, name) {
  const config = loadCommandJson(botId);
  return config.commands?.find((c) => c.name === name)?.countdown || 0;
}

function setCommandCountdown(botId, name, seconds) {
  const config = loadCommandJson(botId);
  if (!Array.isArray(config.commands)) config.commands = [];
  const command = config.commands.find((c) => c.name === name);
  if (command) {
    command.countdown = seconds;
  } else {
    config.commands.push({ name, countdown: seconds });
  }
  saveCommandJson(botId, config);
}

export async function handleAutoDownloadCommand(api, message, aliasCommand, groupSettings) {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const botId = resolveActiveBotId(api);
  const args = extractCleanArgs(message, prefix, aliasCommand || "autodownload");
  const command = (args[0] || "").toLowerCase();

  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  if (command === "setcountdown") {
    if (args.length < 2) {
      await api.sendMessage({ msg: "⚠️ Bạn cần nhập số giây!", quote: message, ttl: 30000 }, threadId, message.type);
      return true;
    }

    const seconds = parseInt(args[1], 10);
    if (isNaN(seconds) || seconds < 0) {
      await api.sendMessage({ msg: "❌ Vui lòng nhập số giây hợp lệ!", quote: message, ttl: 30000 }, threadId, message.type);
      return true;
    }

    setCommandCountdown(botId, "download", seconds);
    await api.sendMessage(
      {
        msg: `✅ Đã cập nhật countdown cho lệnh download: ${seconds} giây`,
        quote: message,
        ttl: 30000,
      },
      threadId,
      message.type
    );
    return true;
  }

  if (command === "on") {
    groupSettings[threadId].enableDownload = true;
  } else if (command === "off") {
    groupSettings[threadId].enableDownload = false;
  } else {
    groupSettings[threadId].enableDownload = !groupSettings[threadId].enableDownload;
  }

  const status = groupSettings[threadId].enableDownload;
  await sendMessageStateQuote(api, message, `Chức năng download tự động đã được ${status ? "bật" : "tắt"}!`, status, 30000);
  return true;
}

export { MEDIA_TYPES, getMediaType, getTikTokMedia, getDataDownloadVideo, sendTikTokMedia, sendTikTokVideo };

export async function handleDownloadZalo(api, message, groupSettings, isSelf, dependencies = {}) {
  const threadId = message.threadId;
  const userId = message.data?.uidFrom;
  const prefix = getGlobalPrefix();
  const botId = resolveActiveBotId(api);

  if (isOutboundMessage(botId, message) || hasCommandPrefix(message, prefix)) return false;

  const replyHandled =
    (await (dependencies.handleReply || handleHoangdevDownloadReply)(api, message)) ||
    (await (dependencies.handleLegacyReply || handleLegacyDownloadReply)(api, message));
  if (replyHandled) return true;

  const link = readDownloadLink(message);
  if (!link || !groupSettings?.[threadId]?.enableDownload) return false;
  if (groupSettings?.[threadId]?.activeBot === false) return false;

  if (isSelf || message.isSelf) {
    if (typeof message.data?.content === "object") {
      const previewLink = readDownloadLink({ data: { content: { href: message.data.content?.href } } });
      if (!previewLink || previewLink.url !== link.url) return false;
    } else if (messageTextParts(message).some((text) => text.trim() !== link.url)) {
      return false;
    }
  }

  if (!claimDownloadMessage(botId, message)) return true;
  logDownloadEvent({ source: link.platform, stage: "read-link", status: "ok" });

  const validUrl = link.url;
  const usageKey = JSON.stringify([botId, threadId, userId]);

  const cooldownCommandName = "download";
  const cooldown = getCommandCountdown(botId, cooldownCommandName) * 1000;
  const currentTime = Date.now();
  const lastUsage = commandUsage[usageKey]?.[cooldownCommandName] || 0;
  const timeLeft = cooldown - (currentTime - lastUsage);

  if (timeLeft > 0) {
    showCooldownClock({ api, message, remainingMs: timeLeft });
    return true;
  }

  if (!commandUsage[usageKey]) commandUsage[usageKey] = {};
  commandUsage[usageKey][cooldownCommandName] = currentTime;

  if (link.platform === "tiktok") {
    try {
      await (dependencies.sendReaction || sendReactionConfirmReceive)(api, message, 5);
      await (dependencies.runPlatformDownload || runPlatformDownload)(api, message, validUrl, "tiktok");
    } catch (error) {
      await api.sendMessage(
        { msg: downloadFailureCaption("TikTok", "receive", error), quote: message, ttl: 30000 },
        threadId,
        message.type
      );
    }
    return true;
  }

  if (link.platform === "youtube") {
    try {
      return await handleYouTubeAutoDownload(
        api,
        message,
        normalizeYoutubeUrl(validUrl) || validUrl,
        userId,
        message.data?.dName,
        { prefix }
      );
    } catch (error) {
      await api.sendMessage(
        { msg: downloadFailureCaption("YouTube", "receive", error), quote: message, ttl: 30000 },
        threadId,
        message.type
      );
      return true;
    }
  }

  await (dependencies.sendReaction || sendReactionConfirmReceive)(api, message, 5);

  const commandName = "download";
  const fakeMessage = {
    ...message,
    body: `${prefix}${commandName} ${validUrl}`,
    data: {
      ...(message.data || {}),
      content: `${prefix}${commandName} ${validUrl}`,
      mentions: [],
    },
  };
  await handleDownloadCommand(api, fakeMessage, commandName);
  return true;
}
