import fs from "fs";
import path from "path";
import schedule from "node-schedule";
import { MessageType } from "../../api-zalo/models/Message.js";
import { getActiveRuntimeContext, readCommandConfig } from "../../utils/io-json.js";
import { getProjectRoot } from "../../utils/env.js";
import { extractCleanArgs } from "../../commands/shared/command-input-utils.js";
import { createRankStore, getRankStore } from "./rank-store.js";

export function resolveRankInfoPath(customContext = null) {
  const ctx = customContext || getActiveRuntimeContext();
  const rawPath = ctx.rankInfoPath || path.join(ctx.dataDir || "", "rank-info.json");
  const projectRoot = getProjectRoot();
  return path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(projectRoot, rawPath);
}

export function resolveRankMetaPath(customContext = null) {
  const rankInfoPath = resolveRankInfoPath(customContext);
  return rankInfoPath.replace(/\.json$/i, "") + ".meta.json";
}

export function getRankResetDateKey(now = new Date()) {
  const dateObj = now instanceof Date ? now : new Date(now);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dateObj);
}

function readRankResetMeta(customContext = null) {
  try {
    const metaPath = resolveRankMetaPath(customContext);
    if (!fs.existsSync(metaPath)) return {};
    const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeRankResetMeta(lastResetDate, customContext = null) {
  try {
    const metaPath = resolveRankMetaPath(customContext);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(metaPath, JSON.stringify({ lastResetDate }, null, 2), "utf8");
  } catch (error) {
    console.error("Lỗi khi ghi file rank-info.meta.json:", error);
  }
}

function storeFor(customContext = null) {
  const ctx = customContext || getActiveRuntimeContext();
  return getRankStore(ctx, { projectRoot: getProjectRoot() });
}

export function readRankInfo(customContext = null) {
  try {
    // Reads are served from the write-behind store memory so hot-path
    // increments are immediately visible without touching disk.
    const data = storeFor(customContext).snapshot();
    if (!data || typeof data !== "object" || Array.isArray(data)) return { groups: {} };
    if (!data.groups || typeof data.groups !== "object" || Array.isArray(data.groups)) data.groups = {};
    return data;
  } catch (error) {
    console.error("Lỗi khi đọc rank info:", error);
    return { groups: {} };
  }
}

export function writeRankInfo(data, customContext = null) {
  try {
    // Administrative writes stay write-through for legacy compatibility.
    storeFor(customContext).replace(data);
  } catch (error) {
    console.error("Lỗi khi ghi file rank-info.json:", error);
  }
}

export function resetRankInfo(customContext = null, options = {}) {
  const initialData = { groups: {} };
  try {
    storeFor(customContext).reset();
    const todayKey = options.todayKey || getRankResetDateKey(options.now);
    writeRankResetMeta(todayKey, customContext);
  } catch (error) {
    console.error("Lỗi khi reset file rank-info.json:", error);
  }
  return initialData;
}

export function scheduleMidnightRankReset(customContext = null) {
  const ctx = customContext || getActiveRuntimeContext();
  const jobName = `reset_topchat_midnight_${ctx.uid || "admin"}`;

  const existingJob = schedule.scheduledJobs[jobName];
  if (existingJob) {
    existingJob.cancel();
  }

  return schedule.scheduleJob(jobName, { rule: "0 0 * * *", tz: "Asia/Ho_Chi_Minh" }, () => {
    try {
      console.log(`[RankSystem] Đang tự động reset topchat 0h00 (Asia/Ho_Chi_Minh) cho bot ${ctx.uid}...`);
      resetRankInfo(ctx);
    } catch (err) {
      console.error("[RankSystem] Lỗi khi reset topchat 0h00:", err);
    }
  });
}

export function updateUserRank(groupId, userId, userName, nameGroup, customContext = null) {
  if (!groupId || !userId) return;
  // Hot path: memory-only increment, flushed atomically by the store timer.
  storeFor(customContext).increment(groupId, userId, userName, nameGroup);
}

export async function handleRankCommand(api, message, aliasCommand = "topchat") {
  const threadId = message.threadId;
  const prefix = readCommandConfig()?.prefix || "!";
  const cleanArgs = extractCleanArgs(message, prefix, aliasCommand || "topchat");
  const isMeQuery = cleanArgs[0]?.toLowerCase() === "me";

  const rankInfo = readRankInfo();
  const rawUsers = rankInfo.groups[threadId]?.users || [];
  const groupUsers = rawUsers.filter((user) => user && Number(user.Rank) > 0);

  if (groupUsers.length === 0) {
    await api.sendMessage(
      { msg: "Chưa có dữ liệu xếp hạng cho nhóm này.", quote: message },
      threadId,
      MessageType.GroupMessage
    );
    return;
  }

  const sortedUsers = [...groupUsers].sort((a, b) => b.Rank - a.Rank);
  const senderId = String(message?.data?.uidFrom || "").trim();
  const senderName = message?.data?.dName || "Bạn";

  if (isMeQuery) {
    const myIndex = senderId ? sortedUsers.findIndex((u) => String(u.UID) === senderId) : -1;
    if (myIndex === -1) {
      await api.sendMessage(
        {
          msg: `📊 Thống kê tương tác HÔM NAY của ${senderName}:\n• Bạn chưa có tin nhắn nào được ghi nhận hôm nay trong nhóm này.`,
          quote: message,
        },
        threadId,
        MessageType.GroupMessage
      );
      return;
    }
    const myEntry = sortedUsers[myIndex];
    const meMsg =
      `🏆 Thứ hạng tương tác HÔM NAY của ${myEntry.UserName || senderName}:\n` +
      `• Hạng hiện tại: #${myIndex + 1}/${sortedUsers.length}\n` +
      `• Số tin nhắn hôm nay: ${myEntry.Rank} tin nhắn`;
    await api.sendMessage({ msg: meMsg, quote: message }, threadId, MessageType.GroupMessage);
    return;
  }

  const top10Users = sortedUsers.slice(0, 10);

  let rankMessage = "🏆 Bảng xếp hạng tương tác HÔM NAY (Top 10)\n\n";
  top10Users.forEach((user, index) => {
    rankMessage += `${index + 1}. ${user.UserName}: ${user.Rank} tin nhắn\n`;
  });

  if (senderId) {
    const myIndex = sortedUsers.findIndex((u) => String(u.UID) === senderId);
    if (myIndex >= 0) {
      rankMessage += `\n📌 Hạng của bạn: #${myIndex + 1}/${sortedUsers.length} (${sortedUsers[myIndex].Rank} tin nhắn)`;
    }
  }

  await api.sendMessage({ msg: rankMessage, quote: message }, threadId, MessageType.GroupMessage);
}

export async function initRankSystem(customContext = null, options = {}) {
  const todayKey = options.todayKey || getRankResetDateKey(options.now);
  const meta = readRankResetMeta(customContext);
  if (meta.lastResetDate !== todayKey) {
    resetRankInfo(customContext, { todayKey });
  }
  scheduleMidnightRankReset(customContext);
}
