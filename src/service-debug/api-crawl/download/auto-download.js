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
import { removeMention } from "../../../utils/format-util.js";
import { getGlobalPrefix } from "../../service.js";
import { sendReactionConfirmReceive } from "../../../commands/command-response.js";
import { sendMessageStateQuote } from "../../chat-zalo/chat-style/chat-style.js";
import { showCooldownClock } from "../../../utils/interaction-countdown.js";
import { sleep } from "../../../utils/util.js";
import { getTikTokMedia, getDataDownloadVideo } from "../tiktok/tiktok-api.js";
import { sendTikTokMedia, sendTikTokVideo } from "../tiktok/tiktok-service.js";
import { handleYouTubeAutoDownload } from "./youtube-autodownload.js";
import { normalizeYoutubeUrl } from "../youtube/youtube-service.js";
const configPath = path.join(process.cwd(), "assets/json-data/command-config.json");
const activeCooldowns = new Set();
const commandUsage = {};
const pendingRequests = {};
let cachedCommandConfig = null;
let cachedCommandConfigAt = 0;

function loadCommandJson() {
  const now = Date.now();
  if (cachedCommandConfig && now - cachedCommandConfigAt < 30000) {
    return cachedCommandConfig;
  }
  try {
    if (!fs.existsSync(configPath)) {
      const initial = { commands: [] };
      fs.writeFileSync(configPath, JSON.stringify(initial, null, 2));
      cachedCommandConfig = initial;
      cachedCommandConfigAt = now;
      return initial;
    }
    cachedCommandConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cachedCommandConfigAt = now;
    return cachedCommandConfig;
  } catch {
    return cachedCommandConfig || { commands: [] };
  }
}

function saveCommandJson(data) {
  cachedCommandConfig = data;
  cachedCommandConfigAt = Date.now();
  fs.promises.writeFile(configPath, JSON.stringify(data, null, 2)).catch(() => {});
}

function getCommandCountdown(name) {
  const config = loadCommandJson();
  return config.commands?.find(c => c.name === name)?.countdown || 0;
}

function setCommandCountdown(name, seconds) {
  const config = loadCommandJson();
  if (!Array.isArray(config.commands)) config.commands = [];
  const command = config.commands.find(c => c.name === name);
  if (command) {
    command.countdown = seconds;
  } else {
    config.commands.push({ name, countdown: seconds });
  }
  saveCommandJson(config);
}

function extractValidUrl(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  const urls = text.match(urlRegex);
  if (!urls) return null;

  for (const url of urls) {
    if (getMediaType(url)) {
      return url;
    }
  }
  return null;
}

function extractYouTubeUrl(text) {
  const youtubeRegex = /https?:\/\/(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)\/[^\s]+/i;
  const match = text.match(youtubeRegex);
  return match ? match[0] : null;
}

function extractTikTokUrl(text) {
  const tiktokRegex = /https?:\/\/((?:vm|vt|www)\.)?tiktok\.com\/[^\s]+/i;
  const match = text.match(tiktokRegex);
  return match ? match[0] : null;
}

export async function handleAutoDownloadCommand(api, message, aliasCommand, groupSettings) {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const content = removeMention(message).trim().toLowerCase();
  const query = content.replace(`${prefix}${aliasCommand}`, "").trim();
  const args = query.split(/\s+/);
  const command = args[0];

  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  if (command === "setcountdown") {
    if (args.length < 2) {
      await api.sendMessage({ msg: "⚠️ Bạn cần nhập số giây!", quote: message, ttl: 30000 }, threadId, message.type);
      return true;
    }
  
    const seconds = parseInt(args[1]);
    if (isNaN(seconds) || seconds < 0) {
      await api.sendMessage({ msg: "❌ Vui lòng nhập số giây hợp lệ!", quote: message, ttl: 30000 }, threadId, message.type);
      return true;
    }
  
    setCommandCountdown("download", seconds);
    await api.sendMessage({
      msg: `✅ Đã cập nhật countdown cho lệnh download: ${seconds} giây`,
      quote: message,
      ttl: 30000,
    }, threadId, message.type);
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

export { MEDIA_TYPES, getMediaType };

export async function handleDownloadZalo(api, message, groupSettings, isSelf, dependencies = {}) {
    const threadId = message.threadId;
    const userId = message.data?.uidFrom;
    const prefix = getGlobalPrefix();
    const botId = appContext.uid || 'admin';
    if (isOutboundMessage(botId, message) || hasCommandPrefix(message, prefix)) return false;
    const replyHandled =
      (await (dependencies.handleReply || handleHoangdevDownloadReply)(api, message)) ||
      (await (dependencies.handleLegacyReply || handleLegacyDownloadReply)(api, message));
    if (replyHandled) return true;
    const link = readDownloadLink(message);
    if (!link || !groupSettings[threadId]?.enableDownload) return false;
    // Self-authored plain text must contain only a URL. A preview has its own href.
    if (isSelf || message.isSelf) {
      if (typeof message.data?.content === 'object') {
        const previewLink = readDownloadLink({ data: { content: { href: message.data.content?.href } } });
        if (!previewLink || previewLink.url !== link.url) return false;
      } else if (messageTextParts(message).some(text => text.trim() !== link.url)) return false;
    }
    if (!claimDownloadMessage(botId, message)) return true;
    logDownloadEvent({ source: link.platform, stage: 'read-link', status: 'ok' });
    const validUrl = link.url;
    const usageKey = JSON.stringify([botId, threadId, userId]);

  const cooldownCommandName = "download";
  const cooldown = getCommandCountdown(cooldownCommandName) * 1000;
  const currentTime = Date.now();
  const lastUsage = commandUsage[usageKey]?.[cooldownCommandName] || 0;
  const timeLeft = cooldown - (currentTime - lastUsage);

  if (timeLeft > 0) {
    showCooldownClock({ api, message, remainingMs: timeLeft });
    return true;
  }

  if (!commandUsage[usageKey]) commandUsage[usageKey] = {};
  commandUsage[usageKey][cooldownCommandName] = currentTime;

  const tiktokUrl = link.platform === "tiktok" ? validUrl : null;
  if (tiktokUrl) {
    try {
      await (dependencies.sendReaction || sendReactionConfirmReceive)(api, message, 5);
      // Shared getTikTokMedia / sendTikTokMedia pipeline, with one failure response.
      await (dependencies.runPlatformDownload || runPlatformDownload)(api, message, tiktokUrl, "tiktok");
    } catch (error) {
      await api.sendMessage({ msg: downloadFailureCaption("TikTok", "receive", error), quote: message, ttl: 30000 }, threadId, message.type);
    }
    return true;
  }

  const youtubeUrl = link.platform === "youtube" ? validUrl : null;
  if (youtubeUrl) {
    try {
      return await handleYouTubeAutoDownload(api, message, normalizeYoutubeUrl(youtubeUrl) || youtubeUrl, userId, message.data?.dName, { prefix });
    } catch (error) {
      await api.sendMessage({ msg: downloadFailureCaption("YouTube", "receive", error), quote: message, ttl: 30000 }, threadId, message.type);
      return true;
    }
  }

  await sendReactionConfirmReceive(api, message, 5);

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
