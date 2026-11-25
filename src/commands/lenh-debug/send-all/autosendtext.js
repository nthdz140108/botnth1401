import { MessageType } from "../../../api-zalo/index.js";
import { appContext } from "../../../api-zalo/context.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { readGroupSettings, writeGroupSettings } from "../../../utils/io-json.js";
import { resolveInstanceAuthorization } from "../../../utils/instance-authorization.js";
import {
  sendMessageWarningRequest,
  sendMessageStateQuote,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { extractCommandBody } from "../../shared/command-input-utils.js";

const autoIntervalMap = {}; // Periodic interval per threadId
const autoTimeMap = {}; // Fixed-clock checker interval per threadId
const lastSentMap = {}; // Last sent dateKey per threadId and HH:MM:SS

const MIN_ADMIN_BOX_INTERVAL_MS = 30 * 1000;
const MIN_HIGH_ADMIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getVietnamClockParts(nowMs = Date.now()) {
  const vn = new Date(nowMs + 7 * 3600_000);
  const hh = String(vn.getUTCHours()).padStart(2, "0");
  const mm = String(vn.getUTCMinutes()).padStart(2, "0");
  const ss = String(vn.getUTCSeconds()).padStart(2, "0");
  const dateKey = `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}-${String(vn.getUTCDate()).padStart(2, "0")}`;
  return { currentTime: `${hh}:${mm}:${ss}`, today: dateKey };
}

function isHighLevelCaller(message, api, options = {}) {
  if (options?.isAdminLevelHighest || options?.callerIsBotAdmin) return true;
  try {
    const senderId =
      message?.data?.uidFrom || message?.senderID || message?.senderId || "";
    const instanceUid = String(
      api?.getBotId?.() || api?.getOwnId?.() || api?.currentUserId || appContext?.uid || ""
    ).trim();
    const auth = resolveInstanceAuthorization({
      senderId,
      threadId: message?.threadId || "",
      instanceUid,
    });
    return Boolean(auth?.isAdminLevelHigh || auth?.isAdminBot);
  } catch {
    return false;
  }
}

function stopPeriodicTimer(threadId) {
  if (autoIntervalMap[threadId]) {
    clearInterval(autoIntervalMap[threadId]);
    delete autoIntervalMap[threadId];
  }
}

function stopClockTimer(threadId) {
  if (autoTimeMap[threadId]) {
    clearInterval(autoTimeMap[threadId]);
    delete autoTimeMap[threadId];
  }
}

export async function handleAutoSendTextCommand(
  api,
  message,
  groupSettings = readGroupSettings(),
  options = {}
) {
  const prefix = getGlobalPrefix();

  if (!message || (!message.threadId && !message?.data?.idTo)) {
    return;
  }

  const threadId = message?.threadId || message?.data?.idTo;
  const aliasCommand = options?.aliasCommand || "sendtext";
  const body = extractCommandBody(message, prefix, aliasCommand);

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  if (!lastSentMap[threadId]) {
    lastSentMap[threadId] = {};
  }

  if (!Array.isArray(groupSettings[threadId].autoSendTime)) {
    if (
      groupSettings[threadId].autoSendTime &&
      typeof groupSettings[threadId].autoSendTime === "object"
    ) {
      groupSettings[threadId].autoSendTime = [groupSettings[threadId].autoSendTime];
    } else {
      groupSettings[threadId].autoSendTime = [];
    }
    try {
      writeGroupSettings(groupSettings);
    } catch (error) {
      console.error("Loi ghi cau hinh nhom:", error.message);
    }
  }

  const tokens = body ? body.split(/\s+/).filter(Boolean) : [];
  const status = tokens[0]?.toLowerCase();

  if (status === "on" || status === "off" || tokens.length === 0) {
    let newStatus;
    if (status === "on") {
      if (
        !groupSettings[threadId].autoSendText &&
        groupSettings[threadId].autoSendTime.length === 0
      ) {
        const objectData = {
          caption: `Vui lòng thiết lập nội dung và thời gian trước: ${prefix}${aliasCommand} <số><s/p/h> <nội dung> hoặc ${prefix}${aliasCommand} time <HH:MM:SS> <nội dung>`,
        };
        try {
          await sendMessageWarningRequest(api, message, objectData, 30000);
        } catch (error) {
          console.error("Loi gui canh bao:", error.message);
        }
        return;
      }
      groupSettings[threadId].sendtext = true;
      newStatus = "bật";
    } else if (status === "off") {
      groupSettings[threadId].sendtext = false;
      newStatus = "tắt";
    } else {
      if (
        !groupSettings[threadId].sendtext &&
        !groupSettings[threadId].autoSendText &&
        groupSettings[threadId].autoSendTime.length === 0
      ) {
        const objectData = {
          caption: `Vui lòng thiết lập nội dung và thời gian trước: ${prefix}${aliasCommand} <số><s/p/h> <nội dung> hoặc ${prefix}${aliasCommand} time <HH:MM:SS> <nội dung>`,
        };
        try {
          await sendMessageWarningRequest(api, message, objectData, 30000);
        } catch (error) {
          console.error("Loi gui canh bao:", error.message);
        }
        return;
      }
      groupSettings[threadId].sendtext = !groupSettings[threadId].sendtext;
      newStatus = groupSettings[threadId].sendtext ? "bật" : "tắt";
    }

    try {
      writeGroupSettings(groupSettings);
    } catch (error) {
      console.error("Loi ghi cau hinh nhom:", error.message);
    }

    if (groupSettings[threadId].sendtext) {
      if (groupSettings[threadId].autoSendText) {
        const { interval, content } = groupSettings[threadId].autoSendText;
        startAutoText(api, threadId, content, interval);
      }
      if (groupSettings[threadId].autoSendTime.length > 0) {
        startAutoTime(api, threadId, groupSettings[threadId].autoSendTime);
      }
    } else {
      stopPeriodicTimer(threadId);
      stopClockTimer(threadId);
      delete lastSentMap[threadId];
    }

    const caption = `Đã ${newStatus} chức năng gửi tin nhắn tự động vào nhóm này!`;
    try {
      await sendMessageStateQuote(api, message, caption, groupSettings[threadId].sendtext, 30000);
    } catch (error) {
      console.error("Loi gui trang thai:", error.message);
    }
    return;
  }

  if (status === "time") {
    const subCommand = tokens[1]?.toLowerCase();

    if (subCommand === "list") {
      const times = groupSettings[threadId].autoSendTime || [];
      if (times.length === 0) {
        try {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: "Chưa có mốc giờ nào được thiết lập." },
            30000
          );
        } catch (error) {
          console.error("Loi gui danh sach moc gio:", error.message);
        }
        return;
      }
      const caption = `Danh sách mốc giờ:\n${times.map((t, i) => `${i + 1}. ${t.time} - ${t.content}`).join("\n")}`;
      try {
        await sendMessageWarningRequest(api, message, { caption }, 30000);
      } catch (error) {
        console.error("Loi gui danh sach moc gio:", error.message);
      }
      return;
    }

    if (subCommand === "remove") {
      const timeRaw = tokens[2];
      const timeMatch = timeRaw?.match(/^([0-1][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/);
      if (!timeMatch) {
        try {
          await sendMessageWarningRequest(
            api,
            message,
            {
              caption: `📌 Dùng: ${prefix}${aliasCommand} time remove <HH:MM:SS>\nVí dụ: ${prefix}${aliasCommand} time remove 14:30:00`,
            },
            30000
          );
        } catch (error) {
          console.error("Loi gui huong dan xoa moc gio:", error.message);
        }
        return;
      }

      const initialLength = groupSettings[threadId].autoSendTime.length;
      groupSettings[threadId].autoSendTime = groupSettings[threadId].autoSendTime.filter(
        (t) => t.time !== timeRaw
      );
      if (groupSettings[threadId].autoSendTime.length === initialLength) {
        try {
          await sendMessageWarningRequest(
            api,
            message,
            { caption: `Không tìm thấy mốc giờ ${timeRaw} để xóa.` },
            30000
          );
        } catch (error) {
          console.error("Loi gui thong bao xoa moc gio:", error.message);
        }
        return;
      }

      try {
        writeGroupSettings(groupSettings);
      } catch (error) {
        console.error("Loi ghi cau hinh moc gio:", error.message);
      }

      if (groupSettings[threadId].autoSendTime.length === 0) {
        stopClockTimer(threadId);
        delete lastSentMap[threadId];
      } else if (groupSettings[threadId].sendtext) {
        startAutoTime(api, threadId, groupSettings[threadId].autoSendTime);
      }

      try {
        await sendMessageWarningRequest(
          api,
          message,
          { caption: `✅ Đã xóa mốc giờ ${timeRaw}.` },
          30000
        );
      } catch (error) {
        console.error("Loi gui thong bao xoa moc gio:", error.message);
      }
      return;
    }

    const timeListRaw = tokens[1];
    const timeList = timeListRaw?.split(",").map((t) => t.trim()) || [];
    const afterTimeMatch = body.match(/^time\s+\S+\s+([\s\S]+)$/i);
    const msgRaw = (afterTimeMatch ? afterTimeMatch[1] : tokens.slice(2).join(" "))
      .trim()
      .replace(/\\n/g, "\n");

    const validTimes = timeList.filter((time) =>
      /^([0-1][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9])$/.test(time)
    );
    if (validTimes.length === 0 || !timeListRaw) {
      try {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption: `📌 Dùng: ${prefix}${aliasCommand} time <HH:MM:SS,HH:MM:SS,...> <nội dung>\nVí dụ: ${prefix}${aliasCommand} time 08:00:00,09:00:00 Chào buổi sáng`,
          },
          30000
        );
      } catch (error) {
        console.error("Loi gui huong dan thoi gian:", error.message);
      }
      return;
    }

    if (!msgRaw) {
      try {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption: `❗ Thiếu nội dung tin nhắn.\nDùng: ${prefix}${aliasCommand} time <HH:MM:SS,HH:MM:SS,...> <nội dung>`,
          },
          30000
        );
      } catch (error) {
        console.error("Loi gui thong bao thieu noi dung:", error.message);
      }
      return;
    }

    validTimes.forEach((time) => {
      const existingTimeIndex = groupSettings[threadId].autoSendTime.findIndex(
        (t) => t.time === time
      );
      if (existingTimeIndex !== -1) {
        groupSettings[threadId].autoSendTime[existingTimeIndex].content = msgRaw;
      } else {
        groupSettings[threadId].autoSendTime.push({ time, content: msgRaw });
      }
    });

    groupSettings[threadId].sendtext = true;
    try {
      writeGroupSettings(groupSettings);
    } catch (error) {
      console.error("Loi ghi cau hinh nhom:", error.message);
    }

    const { currentTime, today } = getVietnamClockParts();
    validTimes.forEach((time) => {
      if (time === currentTime && !lastSentMap[threadId][time]) {
        sendAutoTextNow(api, threadId, msgRaw);
        lastSentMap[threadId][time] = today;
      }
    });

    try {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `✅ Đã thiết lập gửi tin nhắn "${msgRaw}" vào các mốc giờ: ${validTimes.join(", ")}.`,
        },
        30000
      );
    } catch (error) {
      console.error("Loi gui thong bao thiet lap moc gio:", error.message);
    }

    startAutoTime(api, threadId, groupSettings[threadId].autoSendTime);
    return;
  }

  const timeRaw = tokens[0];
  const timeMatch = timeRaw?.match(/^([0-9]+)([sph])$/i);

  if (!timeMatch) {
    try {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `📌 Dùng: ${prefix}${aliasCommand} <số><s/p/h> <nội dung> hoặc ${prefix}${aliasCommand} time <HH:MM:SS> <nội dung>\nVí dụ: ${prefix}${aliasCommand} 30s Xin chào! hoặc ${prefix}${aliasCommand} time 14:30:00 Xin chào!`,
        },
        30000
      );
    } catch (error) {
      console.error("Loi gui huong dan:", error.message);
    }
    return;
  }

  const value = Number.parseInt(timeMatch[1], 10);
  const unit = timeMatch[2].toLowerCase();
  let intervalMs = 0;

  if (unit === "s") {
    intervalMs = value * 1000;
  } else if (unit === "p") {
    intervalMs = value * 60 * 1000;
  } else if (unit === "h") {
    intervalMs = value * 60 * 60 * 1000;
  }

  const highAdmin = isHighLevelCaller(message, api, options);
  const minAllowedMs = highAdmin ? MIN_HIGH_ADMIN_INTERVAL_MS : MIN_ADMIN_BOX_INTERVAL_MS;

  if (intervalMs < minAllowedMs || intervalMs > MAX_INTERVAL_MS) {
    const caption =
      !highAdmin && intervalMs >= MIN_HIGH_ADMIN_INTERVAL_MS && intervalMs < MIN_ADMIN_BOX_INTERVAL_MS
        ? "⏰ Quản trị viên nhóm chỉ được đặt chu kỳ tối thiểu từ 30 giây trở lên (ví dụ: 30s, 1p, 1h)."
        : `⏰ Khoảng thời gian không hợp lệ. Hợp lệ: ${highAdmin ? "1s" : "30s"} đến 24h.`;
    try {
      await sendMessageWarningRequest(api, message, { caption }, 30000);
    } catch (error) {
      console.error("Loi gui thong bao khoang thoi gian:", error.message);
    }
    return;
  }

  const afterIntervalMatch = body.match(/^\S+\s+([\s\S]+)$/);
  const msgContent = (afterIntervalMatch ? afterIntervalMatch[1] : tokens.slice(1).join(" "))
    .trim()
    .replace(/\\n/g, "\n");

  if (!msgContent) {
    try {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `❗ Thiếu nội dung tin nhắn.\nDùng: ${prefix}${aliasCommand} <số><s/p/h> <nội dung>`,
        },
        30000
      );
    } catch (error) {
      console.error("Loi gui thong bao thieu noi dung:", error.message);
    }
    return;
  }

  groupSettings[threadId].autoSendText = {
    interval: intervalMs / (60 * 1000),
    content: msgContent,
  };
  groupSettings[threadId].sendtext = true;
  try {
    writeGroupSettings(groupSettings);
  } catch (error) {
    console.error("Loi ghi cau hinh nhom:", error.message);
  }

  try {
    await sendMessageWarningRequest(
      api,
      message,
      { caption: `✅ Đã thiết lập gửi tin nhắn mỗi ${value}${unit}.` },
      30000
    );
  } catch (error) {
    console.error("Loi gui thong bao thiet lap:", error.message);
  }

  await sendAutoTextNow(api, threadId, msgContent);
  startAutoText(api, threadId, msgContent, intervalMs / (60 * 1000));
  if (groupSettings[threadId].autoSendTime?.length > 0 && !autoTimeMap[threadId]) {
    startAutoTime(api, threadId, groupSettings[threadId].autoSendTime);
  }
}

function startAutoText(api, threadId, text, intervalMin) {
  stopPeriodicTimer(threadId);

  const intervalMs = Math.max(1000, Math.round(Number(intervalMin) * 60 * 1000));
  autoIntervalMap[threadId] = setInterval(() => {
    const currentSettings = readGroupSettings();
    if (!currentSettings[threadId]?.sendtext || !currentSettings[threadId]?.autoSendText) {
      stopPeriodicTimer(threadId);
      return;
    }
    const latestContent = currentSettings[threadId].autoSendText.content || text;
    sendAutoTextNow(api, threadId, latestContent);
  }, intervalMs);
  autoIntervalMap[threadId]?.unref?.();
}

function startAutoTime(api, threadId, times) {
  stopClockTimer(threadId);

  if (!Array.isArray(times) || times.length === 0) {
    return;
  }

  if (!lastSentMap[threadId]) {
    lastSentMap[threadId] = {};
  }

  autoTimeMap[threadId] = setInterval(() => {
    const currentSettings = readGroupSettings();
    const activeTimes = currentSettings[threadId]?.autoSendTime;
    if (
      !currentSettings[threadId]?.sendtext ||
      !Array.isArray(activeTimes) ||
      activeTimes.length === 0
    ) {
      stopClockTimer(threadId);
      delete lastSentMap[threadId];
      return;
    }

    if (!lastSentMap[threadId]) {
      lastSentMap[threadId] = {};
    }

    const { currentTime, today } = getVietnamClockParts();
    activeTimes.forEach(({ time, content }) => {
      if (currentTime === time && lastSentMap[threadId][time] !== today) {
        sendAutoTextNow(api, threadId, content);
        lastSentMap[threadId][time] = today;
      }
    });
  }, 1000);
  autoTimeMap[threadId]?.unref?.();
}

async function sendAutoTextNow(api, threadId, text) {
  try {
    await api.sendMessage(
      { msg: text, ttl: 30 * 24 * 60 * 60 * 1000 },
      threadId,
      MessageType.GroupMessage
    );
  } catch (err) {
    console.error(`Error sending message to thread ${threadId}:`, err);
  }
}

export function restoreAutoSendText(api) {
  const groupSettings = readGroupSettings();
  for (const threadId in groupSettings) {
    if (groupSettings[threadId]?.sendtext) {
      if (groupSettings[threadId].autoSendText) {
        const { interval, content } = groupSettings[threadId].autoSendText;
        startAutoText(api, threadId, content, interval);
      }
      if (groupSettings[threadId].autoSendTime) {
        if (!Array.isArray(groupSettings[threadId].autoSendTime)) {
          if (typeof groupSettings[threadId].autoSendTime === "object") {
            groupSettings[threadId].autoSendTime = [groupSettings[threadId].autoSendTime];
            try {
              writeGroupSettings(groupSettings);
            } catch (error) {
              console.error("Loi ghi cau hinh nhom:", error.message);
            }
          } else {
            groupSettings[threadId].autoSendTime = [];
          }
        }
        if (groupSettings[threadId].autoSendTime.length > 0) {
          startAutoTime(api, threadId, groupSettings[threadId].autoSendTime);
        }
      }
    }
  }
}
