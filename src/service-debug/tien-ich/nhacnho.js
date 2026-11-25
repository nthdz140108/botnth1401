import { promises as fs, existsSync } from "fs";
import path from "path";
import { MessageType } from "../../api-zalo/models/Message.js";
import { MessageMention } from "../../api-zalo/models/index.js";
import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
  sendMessageInsufficientAuthority,
} from "../chat-zalo/chat-style/chat-style.js";
import { getBotId, getProjectRoot } from "../../utils/env.js";
import { getActiveRuntimeContext } from "../../utils/io-json.js";
import { isAdmin } from "../../utils/role-policy.js";
import { getUserInfoData } from "../info-service/user-info.js";
import { extractCommandBody, safeThreadType } from "../../commands/shared/command-input-utils.js";

let reminderIntervalHandle = null;

function getLegacyDataFilePath(botId) {
  return path.join(getProjectRoot(), "data", `reminders_${botId}.json`);
}

function getDataFilePath(botId) {
  const ctx = getActiveRuntimeContext();
  if (ctx?.remindersPath) {
    return ctx.remindersPath;
  }
  return path.join(
    getProjectRoot(),
    "mybot",
    "instances",
    String(botId || "admin"),
    "data",
    "reminders.json"
  );
}

async function readReminders(botId) {
  const dataFilePath = getDataFilePath(botId);
  try {
    if (!existsSync(dataFilePath) && botId) {
      const legacyPath = getLegacyDataFilePath(botId);
      if (existsSync(legacyPath)) {
        const legacyData = await fs.readFile(legacyPath, "utf8");
        await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
        await fs.writeFile(dataFilePath, legacyData, "utf8");
      }
    }
    const data = await fs.readFile(dataFilePath, "utf8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[NHACNHO] Không thể đọc file ${dataFilePath}: ${error.message}`);
    }
    return [];
  }
}

async function writeReminders(reminders, botId) {
  const dataFilePath = getDataFilePath(botId);
  try {
    const dir = path.dirname(dataFilePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${dataFilePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(reminders, null, 2), "utf8");
    await fs.rename(tmpPath, dataFilePath);
  } catch (error) {
    console.error(`[NHACNHO] Lỗi khi ghi file ${dataFilePath}:`, error?.message || error);
  }
}

function parseDateString(dateStr) {
  const dateParts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!dateParts) return null;

  const day = Number.parseInt(dateParts[1], 10);
  const month = Number.parseInt(dateParts[2], 10) - 1;
  const rawYear = Number.parseInt(dateParts[3], 10);
  const year = dateParts[3].length === 2 ? 2000 + rawYear : rawYear;

  if (day < 1 || day > 31 || month < 0 || month > 11) return null;
  const check = new Date(Date.UTC(year, month, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { day, month, year };
}

function formatVietnamDateTime(timestampMs) {
  const vn = new Date(timestampMs + 7 * 3600_000);
  const hh = String(vn.getUTCHours()).padStart(2, "0");
  const mm = String(vn.getUTCMinutes()).padStart(2, "0");
  const dd = String(vn.getUTCDate()).padStart(2, "0");
  const mo = String(vn.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = vn.getUTCFullYear();
  return {
    timeStr: `${hh}:${mm}`,
    dateStr: `${dd}/${mo}/${yyyy}`,
    fullStr: `${hh}:${mm} ngày ${dd}/${mo}/${yyyy}`,
  };
}

function getUserVisibleReminders(allReminders, requesterId) {
  const uid = String(requesterId || "");
  return allReminders
    .filter((r) => String(r.requesterId) === uid || String(r.targetId) === uid)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

export async function handleNhacNhoCommand(api, message, aliasCommand = "nhacnho") {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const requesterId = message.data.uidFrom;
  const botId = getBotId() || api?.getOwnId?.() || "admin";

  const rawText = String(message?.data?.content || "").trim();
  const cmdStripRegex = new RegExp(
    `^\\s*${String(prefix || "").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*${String(
      aliasCommand || "nhacnho"
    ).replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?:\\s+|$)`,
    "i"
  );
  const rawContent = cmdStripRegex.test(rawText)
    ? rawText.replace(cmdStripRegex, "").trim()
    : extractCommandBody(message, prefix, aliasCommand);

  const subTokens = rawContent.split(/\s+/).filter(Boolean);
  const firstSub = (subTokens[0] || "").toLowerCase();

  if (firstSub === "list" || firstSub === "ds") {
    const reminders = await readReminders(botId);
    const mine = getUserVisibleReminders(reminders, requesterId);
    if (mine.length === 0) {
      await sendMessageStateQuote(api, message, "Bạn hiện không có lời nhắc nào đang chờ.", true, 60000);
      return;
    }
    const lines = mine.map((item, idx) => {
      const { fullStr } = formatVietnamDateTime(item.timestamp);
      const who =
        String(item.targetId) === String(requesterId)
          ? "Bạn"
          : item.targetName || item.targetId;
      return `${idx + 1}. [${fullStr}] (${who}) — ${item.message}`;
    });
    const listText =
      `📋 Danh sách lời nhắc đang chờ (${mine.length}):\n` +
      lines.join("\n") +
      `\n\n💡 Dùng ${prefix}${aliasCommand} del <STT> để xóa lời nhắc.`;
    await sendMessageStateQuote(api, message, listText, true, 120000, false);
    return;
  }

  if (firstSub === "del" || firstSub === "xoa" || firstSub === "remove") {
    const stt = Number.parseInt(subTokens[1], 10);
    if (!Number.isInteger(stt) || stt < 1) {
      await sendMessageFailed(
        api,
        message,
        `Vui lòng nhập số thứ tự lời nhắc cần xóa.\nVí dụ: ${prefix}${aliasCommand} del 1 (xem danh sách bằng ${prefix}${aliasCommand} list)`
      );
      return;
    }
    const reminders = await readReminders(botId);
    const mine = getUserVisibleReminders(reminders, requesterId);
    const targetItem = mine[stt - 1];
    if (!targetItem) {
      await sendMessageFailed(
        api,
        message,
        `Không tìm thấy lời nhắc số #${stt}. Dùng ${prefix}${aliasCommand} list để kiểm tra lại.`
      );
      return;
    }
    const remaining = reminders.filter((r) => r.id !== targetItem.id);
    await writeReminders(remaining, botId);
    const { fullStr } = formatVietnamDateTime(targetItem.timestamp);
    await sendMessageStateQuote(
      api,
      message,
      `Đã xóa lời nhắc #${stt} (${fullStr}): "${targetItem.message}"`,
      true,
      60000
    );
    return;
  }

  const timeRegex = /\b(\d{1,2}):(\d{2})\b/g;
  let timeMatch = null;
  let lastTimeIndex = -1;
  let currentMatch;
  while ((currentMatch = timeRegex.exec(rawContent)) !== null) {
    timeMatch = currentMatch;
    lastTimeIndex = currentMatch.index;
  }

  if (!timeMatch) {
    await sendMessageFailed(
      api,
      message,
      `Cú pháp: ${prefix}${aliasCommand} <nội dung> [dd/mm/yy] <HH:MM>\n` +
        `• Xem danh sách: ${prefix}${aliasCommand} list\n` +
        `• Xóa lời nhắc: ${prefix}${aliasCommand} del <STT>`
    );
    return;
  }

  const timeStr = timeMatch[0];
  const hours = Number.parseInt(timeMatch[1], 10);
  const minutes = Number.parseInt(timeMatch[2], 10);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    await sendMessageFailed(
      api,
      message,
      `Thời gian "${timeStr}" không hợp lệ! Giờ phải từ 00 đến 23 và phút từ 00 đến 59.`
    );
    return;
  }

  const contentBeforeTime = rawContent.substring(0, lastTimeIndex).trim();

  const dateRegex = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
  const dateMatch = contentBeforeTime.match(dateRegex);
  let specificDateParts = null;
  let contentWithoutDateAndTime = contentBeforeTime;

  if (dateMatch) {
    specificDateParts = parseDateString(dateMatch[1]);
    if (specificDateParts) {
      contentWithoutDateAndTime = contentBeforeTime.replace(dateRegex, "").trim();
    }
  }

  const textToParse = contentWithoutDateAndTime;
  let targetId = requesterId;
  let targetName = "bạn";
  let reminderText = "";

  const targetMention = message.data.mentions?.[0];
  const args = textToParse.split(/\s+/);
  const firstWord = args[0] || "";
  const isFirstWordUID = /^\d{10,}$/.test(firstWord);
  const mentionSlice =
    targetMention &&
    typeof targetMention.pos === "number" &&
    typeof targetMention.len === "number" &&
    typeof message.data.content === "string"
      ? message.data.content.substring(targetMention.pos, targetMention.pos + targetMention.len)
      : "";

  if (targetMention && mentionSlice && textToParse.startsWith(mentionSlice)) {
    targetId = targetMention.uid;
    targetName = targetMention.dName || mentionSlice.replace(/^@/, "").trim() || targetId;
    reminderText = textToParse.substring(mentionSlice.length).trim();
  } else if (isFirstWordUID) {
    if (!isAdmin(requesterId)) {
      await sendMessageInsufficientAuthority(
        api,
        message,
        "Bạn không có quyền dùng lệnh nhắc nhở qua UID."
      );
      return;
    }
    targetId = firstWord;
    reminderText = textToParse.substring(firstWord.length).trim();
    try {
      const userInfo = await getUserInfoData(api, targetId);
      targetName = userInfo.name || targetId;
    } catch {
      targetName = targetId;
    }
  } else {
    targetId = requesterId;
    targetName = "bạn";
    reminderText = textToParse.trim();
  }

  if (!reminderText) {
    await sendMessageFailed(
      api,
      message,
      `Bạn chưa nhập nội dung lời nhắc.\nCú pháp: ${prefix}${aliasCommand} [nội dung] [dd/mm/yy] [HH:MM]`
    );
    return;
  }

  const nowMsUTC = Date.now();
  const vnNow = new Date(nowMsUTC + 7 * 3600_000);
  let targetTimestampMs;

  if (specificDateParts) {
    targetTimestampMs = Date.UTC(
      specificDateParts.year,
      specificDateParts.month,
      specificDateParts.day,
      hours - 7,
      minutes,
      0,
      0
    );
    if (targetTimestampMs <= nowMsUTC) {
      await sendMessageFailed(
        api,
        message,
        `Không thể đặt lời nhắc cho quá khứ (${dateMatch[1]} ${timeStr}).`
      );
      return;
    }
  } else {
    targetTimestampMs = Date.UTC(
      vnNow.getUTCFullYear(),
      vnNow.getUTCMonth(),
      vnNow.getUTCDate(),
      hours - 7,
      minutes,
      0,
      0
    );
    if (targetTimestampMs <= nowMsUTC) {
      targetTimestampMs += 86_400_000;
    }
  }

  const normalizedTimeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  const newReminder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    requesterId,
    targetId,
    targetName: targetName === "bạn" ? message.data?.dName || "Bạn" : targetName,
    threadId,
    isGroup: safeThreadType(message) === MessageType.GroupMessage,
    message: reminderText,
    timestamp: targetTimestampMs,
  };

  try {
    const reminders = await readReminders(botId);
    reminders.push(newReminder);
    await writeReminders(reminders, botId);

    const { dateStr } = formatVietnamDateTime(targetTimestampMs);
    const confirmationMsg = `Đã đặt lời nhắc cho ${targetName} lúc ${normalizedTimeStr} ngày ${dateStr}. Nội dung: "${reminderText}"`;
    await sendMessageStateQuote(api, message, confirmationMsg, true, 300000);
  } catch (writeError) {
    console.error("[NHACNHO] Lỗi khi lưu lời nhắc:", writeError);
    await sendMessageFailed(api, message, "Đã xảy ra lỗi khi lưu lời nhắc. Vui lòng thử lại.");
  }
}

export async function checkReminders(api, botId) {
  if (!botId) {
    console.error("[checkReminders] Thiếu botId! Không thể kiểm tra lời nhắc.");
    return;
  }

  let allReminders = [];
  try {
    allReminders = await readReminders(botId);
  } catch (readError) {
    console.error(`[checkReminders] Lỗi đọc file reminders cho bot ${botId}:`, readError);
    return;
  }

  const now = Date.now();
  const dueReminders = [];
  const pendingReminders = [];

  for (const reminder of allReminders) {
    if (typeof reminder.timestamp !== "number" || Number.isNaN(reminder.timestamp)) {
      continue;
    }
    if (reminder.timestamp <= now) {
      dueReminders.push(reminder);
    } else {
      pendingReminders.push(reminder);
    }
  }

  if (dueReminders.length === 0) {
    return;
  }

  try {
    await writeReminders(pendingReminders, botId);
  } catch (writeError) {
    console.error("[checkReminders] Lỗi cập nhật file reminders sau khi lọc:", writeError);
  }

  for (const reminder of dueReminders) {
    if (!reminder || !reminder.targetId || !reminder.message || !reminder.requesterId) {
      continue;
    }
    const { targetId, targetName, threadId, isGroup, message, requesterId } = reminder;
    let finalMsg = `⏰ LỜI NHẮC TỰ ĐỘNG ⏰\nNội dung: ${message}`;

    if (requesterId !== targetId) {
      try {
        const requesterInfo = await getUserInfoData(api, requesterId);
        finalMsg += `\n(Người đặt: ${requesterInfo.name || "Một thành viên"})`;
      } catch {
        finalMsg += `\n(Người đặt: ${requesterId})`;
      }
    }

    try {
      await api.sendMessage(
        {
          msg: finalMsg,
          ttl: 86400000,
        },
        targetId,
        MessageType.DirectMessage
      );
    } catch (dmError) {
      console.warn(
        `[checkReminders] Không gửi được tin riêng cho ${targetId}, thử fallback vào nhóm ${threadId}:`,
        dmError?.message || dmError
      );
      if (threadId && String(threadId) !== String(targetId) && isGroup !== false) {
        try {
          const displayTag = `@${targetName || targetId}`;
          const groupText = `${displayTag}\n${finalMsg}`;
          await api.sendMessage(
            {
              msg: groupText,
              mentions: [MessageMention(targetId, displayTag.length, 0)],
              ttl: 86400000,
            },
            threadId,
            MessageType.GroupMessage
          );
        } catch (groupErr) {
          console.error(
            `[checkReminders] Fallback gửi nhóm ${threadId} cho lời nhắc ${reminder.id} thất bại:`,
            groupErr?.message || groupErr
          );
        }
      }
    }
  }
}

export async function startReminderService(api) {
  if (!api) return;
  if (reminderIntervalHandle) {
    clearInterval(reminderIntervalHandle);
    reminderIntervalHandle = null;
  }
  const runTick = async () => {
    const botId = getBotId() || api?.getOwnId?.() || "admin";
    await checkReminders(api, botId).catch(() => {});
  };
  await runTick();
  reminderIntervalHandle = setInterval(runTick, 30 * 1000);
  reminderIntervalHandle.unref?.();
}
