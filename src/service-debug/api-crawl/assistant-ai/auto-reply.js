import fs from "fs";
import path from "path";
import { LRUCache } from "lru-cache";
import { removeMention } from "../../../utils/format-util.js";
import { getGlobalPrefix } from "../../service.js";
import { getBotId } from "../../../utils/env.js";
import { sendMessageStateQuote } from "../../chat-zalo/chat-style/chat-style.js";
import { chatGeminiHandle } from "./gemini.js";
import { appContext } from "../../../api-zalo/context.js";
import { showCooldownClock } from "../../../utils/interaction-countdown.js";
import { getActiveRuntimeContext } from "../../../utils/io-json.js";
import {
  extractCleanArgs,
  safeThreadType,
} from "../../../commands/shared/command-input-utils.js";

const legacyConfigPath = path.join(process.cwd(), "assets/json-data/command-config.json");
const commandUsage = new Map();
export const senderNameCache = new LRUCache({
  max: 200,
  ttl: 10 * 60 * 1000,
});
const cachedConfigsByPath = new Map();

function resolveConfigPath() {
  try {
    const ctx = getActiveRuntimeContext();
    if (ctx?.dataDir) {
      return path.join(ctx.dataDir, "command-config.json");
    }
  } catch {
    // fallback to legacy path
  }
  return legacyConfigPath;
}

function normalizeConfigData(raw) {
  if (raw && typeof raw === "object" && Array.isArray(raw.commands)) {
    return raw;
  }
  return { commands: [] };
}

function loadCommandJson() {
  const targetPath = resolveConfigPath();
  const now = Date.now();
  const cached = cachedConfigsByPath.get(targetPath);
  if (cached && now - cached.at < 30000) {
    return cached.data;
  }
  try {
    const readCandidate = fs.existsSync(targetPath)
      ? targetPath
      : fs.existsSync(legacyConfigPath)
        ? legacyConfigPath
        : null;
    if (!readCandidate) {
      const initial = { commands: [] };
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, JSON.stringify(initial, null, 2));
      cachedConfigsByPath.set(targetPath, { data: initial, at: now });
      return initial;
    }
    const parsed = normalizeConfigData(JSON.parse(fs.readFileSync(readCandidate, "utf8")));
    cachedConfigsByPath.set(targetPath, { data: parsed, at: now });
    return parsed;
  } catch {
    return cached?.data || { commands: [] };
  }
}

function saveCommandJson(data) {
  const targetPath = resolveConfigPath();
  const normalized = normalizeConfigData(data);
  cachedConfigsByPath.set(targetPath, { data: normalized, at: Date.now() });
  fs.promises
    .mkdir(path.dirname(targetPath), { recursive: true })
    .then(() => fs.promises.writeFile(targetPath, JSON.stringify(normalized, null, 2)))
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
  const found = config.commands.find((c) => c.name === name);
  return Number.isFinite(found?.countdown) ? found.countdown : 30;
}

function setCommandCountdown(name, seconds) {
  const config = loadCommandJson();
  const command = config.commands.find((c) => c.name === name);
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
  const threadType = safeThreadType(message);
  const args = extractCleanArgs(message, prefix, aliasCommand || "autoreply");
  const command = (args[0] || "").toLowerCase();

  if (!groupSettings[threadId]) groupSettings[threadId] = {};

  if (command === "setcountdown") {
    if (args.length < 2) {
      await api.sendMessage({ msg: "⚠️ Bạn cần nhập số giây!", ttl: 30000 }, threadId, threadType);
      return true;
    }

    const seconds = Number.parseInt(args[1], 10);
    if (Number.isNaN(seconds) || seconds < 0) {
      await api.sendMessage({ msg: "❌ Vui lòng nhập số giây hợp lệ!", ttl: 30000 }, threadId, threadType);
      return true;
    }

    setCommandCountdown("autoreply", seconds);
    await api.sendMessage(
      {
        msg: `✅ Đã cập nhật countdown cho Auto-AI: ${seconds} giây`,
        ttl: 30000,
      },
      threadId,
      threadType
    );
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
  await sendMessageStateQuote(
    api,
    message,
    `Chức năng Auto-AI đã được ${status ? "bật" : "tắt"}!`,
    status,
    30000
  );
  return true;
}

export async function handleAutoReplyGemini(api, message, groupSettings, isSelf) {
  if (isSelf || message?.isSelf) return false;
  const threadId = message.threadId;
  if (!groupSettings?.[threadId]?.autoReplyCommand) return false;
  const mentions = message.data?.mentions;
  if (!Array.isArray(mentions) || mentions.length === 0) return false;

  const botId = String(
    api?.getBotId?.() || api?.getOwnId?.() || api?.currentUserId || getBotId() || appContext.uid || ""
  ).trim();
  const botMentioned = Boolean(botId) && mentions.some((m) => String(m?.uid || "") === botId);
  if (!botMentioned) return false;

  const content = removeMention(message).trim();
  if (!content) return false;

  const commandName = "autoreply";
  const cooldown = getCommandCountdown(commandName) * 1000;
  const instanceKey = botId || "default";
  const cooldownKey = `${instanceKey}:${threadId}:${commandName}`;
  const currentTime = Date.now();
  const lastUsage = commandUsage.get(cooldownKey) || 0;
  const timeLeft = cooldown - (currentTime - lastUsage);

  if (timeLeft > 0) {
    showCooldownClock({ api, message, remainingMs: timeLeft });
    return true;
  }

  commandUsage.set(cooldownKey, currentTime);

  try {
    const senderName = await getSenderName(api, message.data?.uidFrom, message.data?.dName);
    const messageWithSender = {
      ...message,
      data: {
        ...(message.data || {}),
        dName: senderName,
      },
    };
    await chatGeminiHandle(api, messageWithSender);
  } catch (err) {
    console.error("Lỗi gọi Gemini Auto-Reply:", err);
    await api.sendMessage({ msg: "Lỗi xử lý AI", ttl: 60000 }, threadId, safeThreadType(message));
  }

  return true;
}
