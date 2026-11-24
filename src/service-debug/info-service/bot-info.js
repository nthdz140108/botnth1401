import os from "os";
import si from "systeminformation";
import { readFileSync } from "fs";
import { join } from "path";
import { getBotName } from "../../utils/env.js";
import { getUserInfoData } from "./user-info-data.js";
import { createBotInfoImage, clearImagePath } from "../../utils/canvas/detailSystem-Config.js";
import { createNqduanBotDetailImage } from "../../utils/canvas/nqduan-detail-renderer.js";
import { normalizeBotInfo } from "./bot-details-utils.js";
import { MessageType } from "../../api-zalo/models/Message.js";

export { normalizeBotInfo } from "./bot-details-utils.js";

export function resolveBotId(api) {
  if (typeof api?.getOwnId === "function") {
    try {
      const id = api.getOwnId();
      if (id) return id;
    } catch {}
  }
  if (typeof api?.getBotId === "function") {
    try {
      const id = api.getBotId();
      if (id) return id;
    } catch {}
  }
  return getBotName() || "admin";
}

export const DETAIL_STAGE_TIMEOUTS = Object.freeze({
  PROFILE: 3500,
  SYSINFO: 4000,
  RENDER_PRIMARY: 8000,
  RENDER_NQDUAN: 7000,
  RENDER: 15_000,
  SEND: 8000,
});

export function withTimeout(promise, ms, stageName = "unknown") {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`[detail:${stageName}] Timeout after ${ms}ms`);
      error.stage = stageName;
      error.isTimeout = true;
      reject(error);
    }, ms);
  });

  return Promise.race([
    Promise.resolve(promise),
    timeoutPromise,
  ]).finally(() => {
    clearTimeout(timer);
  });
}

function getMessageScope(message) {
  if (message?.type === MessageType.GroupMessage || message?.type === 1) return "group";
  return "private";
}

function logDetailError(threadId, scope, stage, error) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`[bot-info:detail:${stage}] threadId=${threadId || "unknown"} scope=${scope} error=${errorMessage}`);
}

export async function fetchBotProfile(api, botId, timeoutMs = DETAIL_STAGE_TIMEOUTS.PROFILE) {
  try {
    const rawData = await withTimeout(getUserInfoData(api, botId), timeoutMs, "profile");
    return normalizeBotInfo(rawData);
  } catch (error) {
    return normalizeBotInfo(null);
  }
}

export async function collectSystemInfo(timeoutMs = DETAIL_STAGE_TIMEOUTS.SYSINFO) {
  let cpuData = { currentLoad: 0 };
  let diskData = null;

  try {
    const [load, disks] = await withTimeout(
      Promise.all([si.currentLoad(), si.fsSize()]),
      timeoutMs,
      "sysinfo"
    );
    if (load && typeof load.currentLoad === "number") {
      cpuData = load;
    }
    if (Array.isArray(disks) && disks.length > 0) {
      diskData = disks[0];
    }
  } catch (error) {
    // Graceful fallback on sysinfo timeout / failure
  }

  const cpus = os.cpus() || [];
  const cpuCount = cpus.length || 1;
  const cpuModel = cpus[0]?.model || "Unknown";

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedRam = ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(1);
  const totalRam = (totalMem / 1024 / 1024 / 1024).toFixed(1);
  const freeRam = (freeMem / 1024 / 1024 / 1024).toFixed(1);

  const diskUsage = diskData
    ? `${(((diskData.used ?? (diskData.size - diskData.available))) / 1024 / 1024 / 1024).toFixed(1)}GB `
      + `/ ${(diskData.size / 1024 / 1024 / 1024).toFixed(1)}GB`
      + ` (Free ${(diskData.available / 1024 / 1024 / 1024).toFixed(1)}GB)`
    : "N/A";

  const loadPercent = typeof cpuData.currentLoad === "number" ? cpuData.currentLoad.toFixed(1) : "0.0";

  return {
    version: getBotVersion(),
    os: getOsInfo(),
    memoryUsage: getMemoryUsage(),
    cpu: `${cpuCount} Cores - Utilization ${loadPercent}% `,
    ram: `${usedRam} GB / ${totalRam} GB (Free ${freeRam} GB)`,
    cpuModel,
    disk: diskUsage,
    Name: "Thanh Hung",
  };
}

export async function sendDetailFallback(api, message, stage = "pipeline", error = null) {
  const threadId = message?.threadId;
  const scope = getMessageScope(message);
  logDetailError(threadId, scope, stage, error || "Fallback triggered");

  if (!api?.sendMessage || !threadId) {
    return false;
  }

  try {
    const payload = {
      msg: "❌ Không thể lấy thông tin bot lúc này. Vui lòng thử lại sau.",
    };
    if (message) {
      payload.quote = message;
    }
    await api.sendMessage(payload, threadId, message?.type);
    return true;
  } catch (sendError) {
    logDetailError(threadId, scope, "fallback_send", sendError);
    return false;
  }
}

export function buildDeleteMessagePayload(sentMessage, threadId, messageType, botId) {
  if (!sentMessage) return null;

  if (sentMessage.data && (sentMessage.threadId || threadId)) {
    const msgId = sentMessage.data.msgId || sentMessage.data.globalMsgId || sentMessage.data.cliMsgId;
    if (!msgId) return null;
    return {
      type: typeof sentMessage.type !== "undefined" ? sentMessage.type : messageType,
      threadId: String(sentMessage.threadId || threadId),
      data: {
        cliMsgId: String(sentMessage.data.cliMsgId || Date.now() * 600),
        msgId: String(msgId),
        uidFrom: String(sentMessage.data.uidFrom || botId || "admin"),
      },
    };
  }

  const attachmentItem = Array.isArray(sentMessage?.attachment) ? sentMessage.attachment[0] : sentMessage?.attachment;
  const msgObj = attachmentItem || sentMessage?.message || sentMessage;

  const msgId = msgObj?.msgId || msgObj?.globalMsgId || sentMessage?.messageId || msgObj?.messageId;
  const cliMsgId = msgObj?.cliMsgId || sentMessage?.cliMsgId || msgObj?.msgId || Date.now() * 600;

  if (!msgId) return null;

  return {
    type: typeof messageType !== "undefined" ? messageType : MessageType.DirectMessage,
    threadId: String(threadId),
    data: {
      cliMsgId: String(cliMsgId),
      msgId: String(msgId),
      uidFrom: String(botId || "admin"),
    },
  };
}

export function scheduleDetailMessageCleanup(api, deletePayload, delayMs = 30000) {
  if (!api?.deleteMessage || !deletePayload) return;

  const timer = setTimeout(async () => {
    try {
      await api.deleteMessage(deletePayload, false);
    } catch (cleanupError) {
      logDetailError(
        deletePayload.threadId,
        deletePayload.type === MessageType.GroupMessage ? "group" : "private",
        "cleanup",
        cleanupError
      );
    }
  }, delayMs);

  if (typeof timer?.unref === "function") {
    timer.unref();
  }
}

export async function getBotDetails(api, message, groupSettings = {}) {
  const threadId = message?.threadId;
  const scope = getMessageScope(message);
  const uptime = getUptime();
  const { onConfigs, offConfigs } = getConfigStatus(threadId, groupSettings);
  const botId = resolveBotId(api);

  let botInfo;
  try {
    const rawData = await withTimeout(getUserInfoData(api, botId), DETAIL_STAGE_TIMEOUTS.PROFILE, "profile");
    botInfo = normalizeBotInfo(rawData);
  } catch (error) {
    logDetailError(threadId, scope, "profile", error);
    botInfo = normalizeBotInfo(null);
  }

  let botStats;
  try {
    botStats = await collectSystemInfo(DETAIL_STAGE_TIMEOUTS.SYSINFO);
  } catch (error) {
    logDetailError(threadId, scope, "sysinfo", error);
    botStats = {
      version: getBotVersion(),
      os: getOsInfo(),
      memoryUsage: getMemoryUsage(),
      cpu: "N/A",
      ram: "N/A",
      cpuModel: "Unknown",
      disk: "N/A",
      Name: "Thanh Hung",
    };
  }

  let imagePath = null;
  let renderStage = "render_primary";

  // Multi-tier render fallback chain: HHH Primary -> Nqduan Fallback -> Vietnamese Text
  try {
    imagePath = await withTimeout(
      createBotInfoImage(botInfo, uptime, botStats, onConfigs, offConfigs),
      DETAIL_STAGE_TIMEOUTS.RENDER_PRIMARY,
      "render_primary"
    );
  } catch (primaryError) {
    logDetailError(threadId, scope, "render_primary", primaryError);
    renderStage = "render_nqduan";
    try {
      imagePath = await withTimeout(
        createNqduanBotDetailImage(botInfo, uptime, botStats, onConfigs, offConfigs),
        DETAIL_STAGE_TIMEOUTS.RENDER_NQDUAN,
        "render_nqduan"
      );
    } catch (fallbackError) {
      logDetailError(threadId, scope, "render_nqduan", fallbackError);
      await sendDetailFallback(api, message, "render_all_failed", fallbackError);
      return;
    }
  }

  if (!imagePath) {
    await sendDetailFallback(api, message, renderStage, new Error("Render produced no image path"));
    return;
  }

  try {
    const sentMessage = await withTimeout(
      api.sendMessage({ msg: "", attachments: [imagePath], ttl: 600000 }, threadId, message?.type),
      DETAIL_STAGE_TIMEOUTS.SEND,
      "send_image"
    );

    const deletePayload = buildDeleteMessagePayload(sentMessage, threadId, message?.type, botId);
    if (deletePayload) {
      scheduleDetailMessageCleanup(api, deletePayload, 30000);
    }
  } catch (sendError) {
    logDetailError(threadId, scope, "send_image", sendError);
    await sendDetailFallback(api, message, "send_image", sendError);
  } finally {
    if (imagePath) {
      try {
        await clearImagePath(imagePath);
      } catch (clearError) {
        logDetailError(threadId, scope, "clear_temp_image", clearError);
      }
    }
  }
}

function getOsInfo() {
  let typeOs = "Unknown";
  switch (os.type()) {
    case "Linux":
      typeOs = "Linux";
      break;
    case "Darwin":
      typeOs = "macOS";
      break;
    case "Windows_NT":
      typeOs = "Windows";
      break;
  }
  return `${typeOs} ${os.release()}`;
}

function getUptime() {
  const uptimeInSeconds = process.uptime();
  const days = Math.floor(uptimeInSeconds / 86400);
  const hours = Math.floor((uptimeInSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeInSeconds % 3600) / 60);
  const seconds = Math.floor(uptimeInSeconds % 60);

  return `${days} ngày, ${hours} giờ, ${minutes} phút, ${seconds} giây`;
}

function getMemoryUsage() {
  const usedMem = process.memoryUsage().heapUsed;
  return `${Math.round((usedMem / 1024 / 1024) * 100) / 100} MB`;
}

function getConfigStatus(threadId, groupSettings) {
  const settings = groupSettings[threadId] || {};
  const onConfigs = [];
  const offConfigs = [];

  Object.entries(settings)
    .filter(([key, value]) => typeof value === "boolean")
    .forEach(([key, value]) => {
      const status = value ? "✅" : "❌";
      const configLine = `${getSettingEmoji(key)} ${getSettingName(key)}: ${status}`;
      if (value) {
        onConfigs.push(configLine);
      } else {
        offConfigs.push(configLine);
      }
    });

  return { onConfigs, offConfigs };
}

function getBotVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return packageJson.version || "Không xác định";
  } catch (error) {
    console.error("Lỗi khi đọc phiên bản bot:", error);
    return "Không xác định";
  }
}

function getSettingEmoji(settingKey) {
  const emojiMap = {
    antiSpam: "🛑",
    removeLinks: "🔗",
    autoJoin: "🤝",
    filterBadWords: "🚫",
    welcomeGroup: "👋",
    byeGroup: "👋🏻",
    learnEnabled: "📚",
    replyEnabled: "💬",
    activeBot: "🤖",
    activeGame: "🎮",
    memberApprove: "✅",
    removeTags: "🏷️",
    enableSetup: "⚙️",
    antiNude: "🙅‍♀️",
    allowSticker: "🎟️",
    allowStickerlag: "🐢",
    antiUndo: "⏪",
    antiMention: "🔕",
    sendTask: "📢",
    sendstk: "🎭",
    sendtext: "📝",
    enableDownload: "📥",
    enableAntiBot: "🛡️",
    autoReplyCommand: "🤖",
    antiFile: "📂",
    antiPhotoVideo: "🖼️",
    antiVoice: "🎙️",
    antiText: "🔤",
    antiJoinLeave: "🚷",
    updateGroup: "🔔",
    antiKickBlock: "🛡️",
    blockForward: "📵",
    antiPhoneNumber: "📞",
  };
  return emojiMap[settingKey] || "⚙️";
}

export function getSettingName(settingKey) {
  const nameMap = {
    activeBot: "Tương tác với thành viên",
    activeGame: "Xử lý trò chơi",
    antiSpam: "Chống spam",
    removeTags: "Chặn tag thành viên",
    enableSetup: "Cấu hình hệ thống",
    antiMention: "Chống spam mention",
    removeLinks: "Chặn liên kết",
    filterBadWords: "Xóa từ ngữ thô tục",
    welcomeGroup: "Chào mừng thành viên mới",
    byeGroup: "Thông báo thành viên rời nhóm",
    learnEnabled: "Học hỏi (AI)",
    replyEnabled: "Trả lời tin nhắn nhóm",
    onlyText: "Chỉ cho phép văn bản",
    memberApprove: "Phê duyệt thành viên mới",
    antiNude: "Chống ảnh nhạy cảm",
    antiUndo: "Chặn thu hồi tin nhắn",
    sendTask: "Gửi nội dung định kỳ",
    sendstk: "Tự động gửi sticker",
    sendtext: "Tự động gửi tin nhắn",
    enableDownload: "Tự động tải xuống",
    allowStickerlag: "Chặn sticker gây lag",
    allowSticker: "Chặn sticker",
    enableAntiBot: "Chặn bot người dùng",
    autoReplyCommand: "Auto reply (AI)",
    antiFile: "Chặn gửi file",
    antiPhotoVideo: "Chặn ảnh & video",
    antiVoice: "Chặn voice",
    antiText: "Chặn văn bản",
    antiJoinLeave: "Chặn spam vào/ra nhóm",
    updateGroup: "Thông báo sự kiện nhóm",
    antiKickBlock: "Chống kick/block",
    blockForward: "Chặn chuyển tiếp tin nhắn",
    autoJoin: "Tự động tham gia nhóm",
    antiPhoneNumber: "Chặn số điện thoại",
  };

  return nameMap[settingKey] || settingKey;
}
