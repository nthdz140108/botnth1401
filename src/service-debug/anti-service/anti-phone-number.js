import { MessageMention } from "../../api-zalo/models/index.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { LRUCache } from "lru-cache";
import { sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { isInWhiteList } from "./white-list.js";
import { removeMention } from "../../utils/format-util.js";
import { getActiveRuntimeContext } from "../../utils/io-json.js";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEGACY_PHONE_WHITELIST_FILE = path.join(__dirname, "phone-whitelist.json");
const CACHE_TTL = 5 * 60 * 1000;
const phoneSettingsCacheByPath = new LRUCache({ max: 64, ttl: CACHE_TTL });
const phoneSpamState = new LRUCache({ max: 5000, ttl: 30 * 60 * 1000 });

const phoneRegex = new RegExp(/0[\d.\s]{9,12}\b/g);

function resolvePhoneWhitelistPath() {
  const dataDir = getActiveRuntimeContext()?.dataDir;
  return dataDir ? path.join(dataDir, "phone-whitelist.json") : LEGACY_PHONE_WHITELIST_FILE;
}

async function readPhoneSettings() {
  const filePath = resolvePhoneWhitelistPath();
  const cached = phoneSettingsCacheByPath.get(filePath);
  if (cached) {
    return cached;
  }

  try {
    let raw = null;
    if (fsSync.existsSync(filePath)) {
      raw = await fs.readFile(filePath, "utf8");
    } else if (fsSync.existsSync(LEGACY_PHONE_WHITELIST_FILE)) {
      raw = await fs.readFile(LEGACY_PHONE_WHITELIST_FILE, "utf8");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, raw, "utf8");
    }
    const parsedData = raw ? JSON.parse(raw) || {} : {};
    Object.keys(parsedData).forEach((groupId) => {
      if (!parsedData[groupId]?.patterns) {
        parsedData[groupId] = {
          patterns: Array.isArray(parsedData[groupId]) ? parsedData[groupId] : [],
        };
      }
    });

    if (!raw) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(parsedData, null, 2), "utf8");
    }

    phoneSettingsCacheByPath.set(filePath, parsedData);
    return parsedData;
  } catch {
    return {};
  }
}

async function writePhoneSettings(settings) {
  const filePath = resolvePhoneWhitelistPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(settings, null, 2), "utf8");
  phoneSettingsCacheByPath.set(filePath, settings);
}

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.replace(/\D/g, '');
}

function isWhitelisted(phone, whitelistedPatterns) {
  if (!whitelistedPatterns.length) return false;
  const normalized = normalizePhone(phone);
  return whitelistedPatterns.some(pattern => normalized.includes(pattern));
}

function detectPhoneNumber(content) {
  if (typeof content !== "string" || !content) {
    return false;
  }

  const matches = content.match(phoneRegex);
  if (!matches) return false;

  for (const match of matches) {
    const digitsOnly = normalizePhone(match);
    if (digitsOnly.length === 10) {
      return true;
    }
  }

  return false;
}

function checkPhone(content) {
  return detectPhoneNumber(content);
}

export async function antiPhoneNumber(
  api,
  message,
  isAdminBox,
  groupSettings,
  botIsAdminBox,
  isSelf
) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const threadId = message.threadId;
  const messageId = message.msgId;

  if (
    isSelf ||
    isAdminBox ||
    !botIsAdminBox ||
    !groupSettings[threadId]?.antiPhoneNumber
  ) {
    return false;
  }

  return await handlePhoneMessage(
    api,
    message,
    groupSettings,
    isAdminBox,
    threadId,
    senderId,
    senderName,
    !!messageId
  );
}

export async function handleAntiPhoneNumberCommand(
  api,
  message,
  groupSettings
) {
  const threadId = message.threadId;
  let isChangeSetting = false;
  const content = removeMention(message);
  const parts = content.split(" ");
  const subcommand = parts[1]?.toLowerCase();
  const phoneSettings = await readPhoneSettings();
  if (!phoneSettings[threadId]) {
    phoneSettings[threadId] = {
      patterns: []
    };
  }

  if (subcommand === "add" && parts[2]) {
    const pattern = parts[2].toLowerCase();
    if (!phoneSettings[threadId].patterns.includes(pattern)) {
      phoneSettings[threadId].patterns.push(pattern);
      await writePhoneSettings(phoneSettings);
      await sendMessageStateQuote(api, message, `Đã thêm "${pattern}" vào danh sách trắng số điện thoại.`, true, 300000);
      isChangeSetting = true;
    } else {
      await sendMessageStateQuote(api, message, `"${pattern}" đã có trong danh sách trắng số điện thoại.`, false, 300000);
    }
  } else if (subcommand === "remove" && parts[2]) {
    const pattern = parts[2].toLowerCase();
    if (phoneSettings[threadId].patterns.includes(pattern)) {
      phoneSettings[threadId].patterns = phoneSettings[threadId].patterns.filter(p => p !== pattern);
      if (phoneSettings[threadId].patterns.length === 0) {
        delete phoneSettings[threadId];
      }
      await writePhoneSettings(phoneSettings);
      await sendMessageStateQuote(api, message, `Đã xóa "${pattern}" khỏi danh sách trắng số điện thoại.`, true, 300000);
      isChangeSetting = true;
    } else {
      await sendMessageStateQuote(api, message, `"${pattern}" không tồn tại trong danh sách trắng số điện thoại.`, false, 300000);
    }
  } else if (subcommand === "list") {
    const patterns = phoneSettings[threadId]?.patterns || [];
    const caption = patterns.length > 0
      ? `Danh sách số điện thoại bỏ qua:\n${patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")}`
      : "Hiện không có số điện thoại nào trong danh sách trắng.";
    await sendMessageStateQuote(api, message, caption, patterns.length > 0, 300000);
  } else if (subcommand === "clearall") {
    if (phoneSettings[threadId]?.patterns?.length > 0) {
      phoneSettings[threadId].patterns = [];
      delete phoneSettings[threadId];
      await writePhoneSettings(phoneSettings);
      await sendMessageStateQuote(api, message, `Đã xóa tất số điện thoại khỏi danh sách trắng.`, true, 300000);
      isChangeSetting = true;
    } else {
      await sendMessageStateQuote(api, message, `Danh sách trắng hiện đang rỗng.`, false, 300000);
    }
  } else {
    const status = parts[1]?.toLowerCase();
    if (!groupSettings[threadId]) {
      groupSettings[threadId] = {};
    }
    const newStatus =
      status === "on"
        ? true
        : status === "off"
          ? false
          : !groupSettings[threadId].antiPhoneNumber;
    groupSettings[threadId].antiPhoneNumber = newStatus;
    isChangeSetting = true;
    const statusText = newStatus ? "bật" : "tắt";
    const caption = `Chức năng chống gửi số điện thoại đã được ${statusText}!`;
    await sendMessageStateQuote(api, message, caption, newStatus, 300000);
  }

  return isChangeSetting;
}

async function handlePhoneMessage(
  api,
  message,
  groupSettings,
  isAdminBox,
  threadId,
  senderId,
  senderName,
  hasValidId = false
) {
  let content = message.data.content;
  if (typeof content === 'object' && content !== null) {
    content = content.caption || content.title || content.text || content.description || '';
  }
  if (typeof content !== 'string') {
    content = String(content || '');
  }
  let isDeletePhone = false;
  const isUserWhiteList = isInWhiteList(groupSettings, threadId, senderId);
  const phoneSettings = await readPhoneSettings();
  const whitelistedPatterns = phoneSettings[threadId]?.patterns || [];

  if (isUserWhiteList) {
    return isDeletePhone;
  }

  const hasPhone = checkPhone(content);

  if (hasPhone) {
    const matches = content.match(phoneRegex);
    if (matches && !matches.every(phone => isWhitelisted(phone, whitelistedPatterns))) {
      let deleteSuccess = false;
      try {
        const deleteResult = await api.deleteMessage(message, false);
        if (deleteResult && deleteResult.status === 0) {
          deleteSuccess = true;
        }
      } catch {
        deleteSuccess = false;
      }

      if (deleteSuccess) {
        isDeletePhone = true;
        await updatePhoneCount(
          api,
          message,
          threadId,
          senderId,
          senderName,
          isAdminBox,
          deleteSuccess
        );
      } else {
        await api.sendMessage(
          {
            msg: "Nhờn với tào à ;!",
            quote: message,
            ttl: 300000,
          },
          threadId,
          MessageType.GroupMessage
        );
        await blockUser(api, message, threadId, senderId, senderName);
        return true;
      }
    }
  }

  return isDeletePhone;
}

async function updatePhoneCount(
  api,
  message,
  threadId,
  senderId,
  senderName,
  isAdminBox,
  deleteSuccess = true
) {
  const userKey = `${threadId}:${senderId}`;
  const now = Date.now();
  let state = phoneSpamState.get(userKey);
  if (!state || now - state.time >= 60 * 1000) {
    state = { count: 1, time: now };
  } else {
    state.count += 1;
  }
  phoneSpamState.set(userKey, state);

  if (isAdminBox) {
    return;
  }

  if (state.count > 2) {
    await blockUser(api, message, threadId, senderId, senderName);
    return;
  }

  await sendWarningMessage(api, message, senderId, senderName, state.count, deleteSuccess);
}

async function blockUser(api, message, threadId, senderId, senderName) {
  const userKey = `${threadId}:${senderId}`;
  try {
    await api.blockUsers(threadId, [senderId]);
  } catch (error) {
    console.error("Loi xu ly anti so dien thoai:", error.message);
  } finally {
    phoneSpamState.delete(userKey);
  }
}

async function sendWarningMessage(api, message, senderId, senderName, count) {
  let caption = `⚠️ Cảnh cáo ${senderName}!\nỞ đây cấm gửi số điện thoại`;
  switch (count) {
    case 2:
      caption = `⚠️ Cảnh cáo ${senderName}!\nNgừng gửi số điện thoại, trước khi, mọi chuyện dần tồi tệ hơn!`;
      break;
  }
  
  await api.sendMessage(
    {
      msg: caption,
      mentions: [
        MessageMention(senderId, senderName.length, "⚠️ Cảnh cáo ".length),
      ],
      quote: message,
      ttl: 300000,
    },
    message.threadId,
    MessageType.GroupMessage
  );
}