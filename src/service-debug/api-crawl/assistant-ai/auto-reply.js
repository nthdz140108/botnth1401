import fs from "fs";
import path from "path";
import { LRUCache } from "lru-cache";
import { removeMention } from "../../../utils/format-util.js";
import { getGlobalPrefix } from "../../service.js";
import { sendMessageStateQuote } from "../../chat-zalo/chat-style/chat-style.js";
import { chatGeminiHandle } from "./gemini.js";
import { appContext } from "../../../api-zalo/context.js";
import { showCooldownClock } from "../../../utils/interaction-countdown.js";

const configPath = path.join(process.cwd(), "assets/json-data/command-config.json");
const commandUsage = {};
export const senderNameCache = new LRUCache({
  max: 200,
  ttl: 10 * 60 * 1000,
});
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
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
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
  fs.promises.mkdir(path.dirname(configPath), { recursive: true })
    .then(() => fs.promises.writeFile(configPath, JSON.stringify(data, null, 2)))
    .catch(() => {});
}

export async function getSenderName(api, uid, fallbackName = "") {
  const key = String(uid || "").trim();
  const trimmedFallback = typeof fallbackName === "string" ? fallbackName.trim() : "";
  if (trimmedFallback) {
    if (key) senderNameCache.set(key, trimmedFallback);
    return trimmedFallback;
  }
  if (!key) return "Người dùng";
  const cached = senderNameCache.get(key);
  if (cached) return cached;
  if (typeof api?.getUserInfo === "function") {
    try {
      const info = await api.getUserInfo(key);
      const profile =
        info?.changed_profiles?.[key] ||
        info?.unchanged_profiles?.[key] ||
        info?.profiles?.[key] ||
        info?.data ||
        info;
      const resolved = String(
        profile?.displayName || profile?.zaloName || profile?.name || ""
      ).trim();
      if (resolved) {
        senderNameCache.set(key, resolved);
        return resolved;
      }
    } catch {
      // ignore user-info lookup failure and use fallback
    }
  }
  return "Người dùng";
}

function getCommandCountdown(name) {
  const config = loadCommandJson();
  return config.commands.find(c => c.name === name)?.countdown || 30; // Mặc định 30 giây
}

function setCommandCountdown(name, seconds) {
  const config = loadCommandJson();
  const command = config.commands.find(c => c.name === name);
  if (command) {
    command.countdown = seconds;
  } else {
    config.commands.push({ name, countdown: seconds });
  }
  saveCommandJson(config);
}

export async function handleAutoReplyCommand(api, message, aliasCommand, groupSettings) {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const content = removeMention(message).trim().toLowerCase();
  const query = content.replace(`${prefix}${aliasCommand}`, "").trim();
  const args = query.split(/\s+/);
  const command = args[0];

  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  if (command === "setcountdown") {
    if (args.length < 2) {
      await api.sendMessage({ msg: "⚠️ Bạn cần nhập số giây!", ttl: 30000 }, threadId, message.type);
      return true;
    }

    const seconds = parseInt(args[1]);
    if (isNaN(seconds) || seconds < 0) {
      await api.sendMessage({ msg: "❌ Vui lòng nhập số giây hợp lệ!", ttl: 30000 }, threadId, message.type);
      return true;
    }

    setCommandCountdown("autoreply", seconds);
    await api.sendMessage({
      msg: `✅ Đã cập nhật countdown cho Auto-AI: ${seconds} giây`,
      ttl: 30000,
    }, threadId, message.type);
    return true;
  }

  if (command === "on") {
    groupSettings[threadId].autoReplyCommand = true;
  } else if (command === "off") {
    groupSettings[threadId].autoReplyCommand = false;
  } else {
    groupSettings[threadId].autoReplyCommand = !groupSettings[threadId].autoReplyCommand;
  }

  const status = groupSettings[threadId].autoReplyCommand;
  const countdown = getCommandCountdown("autoreply");
  await sendMessageStateQuote(api, message, `Chức năng Auto-AI đã được ${status ? "bật" : "tắt"}!`, status, 30000);
  return true;
}

export async function handleAutoReplyGemini(api, message, groupSettings, isSelf) {
  if (isSelf || message?.isSelf) return false;
  const threadId = message.threadId;
  if (!groupSettings[threadId]?.autoReplyCommand) return false;
  const mentions = message.data?.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return false;
  const botId = String(
    api?.getBotId?.() || api?.getOwnId?.() || api?.currentUserId || appContext.uid || ""
  ).trim();
  const botMentioned = Boolean(botId) && mentions.some((m) => String(m?.uid || "") === botId);
  if (!botMentioned) return false;
  const content = removeMention(message).trim();
  if (!content) return false;

  const commandName = "autoreply";
  const cooldown = getCommandCountdown(commandName) * 1000;
  const cooldownKey = `${threadId}:${commandName}`;
  const currentTime = Date.now();
  const lastUsage = commandUsage[cooldownKey] || 0;
  const timeLeft = cooldown - (currentTime - lastUsage);

  if (timeLeft > 0) {
    showCooldownClock({ api, message, remainingMs: timeLeft });
    return true;
  }

  commandUsage[cooldownKey] = Date.now();

  try {
    const senderName = await getSenderName(api, message.data?.uidFrom, message.data?.dName);
    const messageWithSender = {
      ...message,
      data: {
        ...(message.data || {}),
        dName: senderName,
      },
    };
    const reply = await chatGeminiHandle(api, messageWithSender);
    if (reply) {
      const isQuoteSupported = !["webchat", "group.poll"].includes(message?.data?.msgType);
      const payload = { msg: reply, ttl: 60000 }; // TTL 60s
      if (isQuoteSupported) {
        payload.quote = message;
      }
      await api.sendMessage(payload, threadId, message.type);
    }
  } catch (err) {
    console.error("Lỗi gọi Gemini:", err);
    await api.sendMessage({ msg: "Lỗi xử lý AI", ttl: 60000 }, threadId, message.type);
  }

  return true;
}
