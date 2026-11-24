import schedule from "node-schedule";
import { MessageType } from "../../api-zalo/models/Message.js";
import { GroupEventType } from "../../api-zalo/models/GroupEvent.js";
import { getGroupEventActorId } from "../../automations/group-event-utils.js";
import { getBotId } from "../../utils/env.js";
import { getLocmemStore } from "./locmem-store.js";
import { getVietnamDateKey, VIETNAM_TIMEZONE } from "./time-util.js";
import { checkAndRunStartupCatchUp, initializeMonthlyCleanupScheduler } from "./locmem-cleanup.js";

// Active scheduled jobs per botUid
const rolloverJobs = new Map();

/**
 * Extracts raw member UIDs from Zalo groupInfo.
 * @param {object} rawGroupInfo
 * @param {string} threadId
 * @returns {string[]}
 */
export function extractGroupMemberUids(rawGroupInfo, threadId) {
  if (!rawGroupInfo) return [];

  let rawList = [];
  if (Array.isArray(rawGroupInfo.memVerList)) {
    rawList = rawGroupInfo.memVerList;
  } else if (rawGroupInfo.gridInfoMap && threadId && Array.isArray(rawGroupInfo.gridInfoMap[threadId]?.memVerList)) {
    rawList = rawGroupInfo.gridInfoMap[threadId].memVerList;
  } else if (rawGroupInfo.gridInfoMap) {
    const entries = Object.values(rawGroupInfo.gridInfoMap);
    if (entries.length === 1 && Array.isArray(entries[0]?.memVerList)) {
      rawList = entries[0].memVerList;
    }
  }

  const uids = new Set();
  for (const item of rawList) {
    if (!item) continue;
    const str = String(item).trim();
    const lastUnderscore = str.lastIndexOf("_");
    const uid = (lastUnderscore > 0 && /^\d+$/.test(str.slice(lastUnderscore + 1)))
      ? str.slice(0, lastUnderscore)
      : (str.includes("_") ? str.split("_")[0] : str);
    if (uid) uids.add(uid);
  }

  // Also include creator and adminIds if present
  if (rawGroupInfo.creatorId) uids.add(String(rawGroupInfo.creatorId).trim());
  if (Array.isArray(rawGroupInfo.adminIds)) {
    for (const aId of rawGroupInfo.adminIds) {
      if (aId) uids.add(String(aId).trim());
    }
  }

  return Array.from(uids).filter(Boolean);
}

function isSelfSender(senderId, botUid) {
  if (!senderId) return false;
  const rawBotId = getBotId();
  if (rawBotId && rawBotId !== -1 && String(rawBotId) !== "-1" && senderId === String(rawBotId)) {
    return true;
  }
  if (typeof botUid === "string" && botUid && botUid !== "admin" && senderId === botUid) {
    return true;
  }
  if (botUid && typeof botUid === "object") {
    const candidate = botUid.liveZaloUid || botUid.botId;
    if (candidate && candidate !== "admin" && candidate !== -1 && senderId === String(candidate)) {
      return true;
    }
  }
  return false;
}

/**
 * Tracks a group message:
 * - Text, photo, sticker, file, command sent by members in a group.
 * - Ignores private messages, self messages (sent by bot), or events without valid sender/thread.
 *
 * @param {object} api
 * @param {object} message
 * @param {string|object} [botUid="admin"]
 */
export function trackLocmemMessage(api, message, botUid = "admin") {
  if (!message || !message.data) return;

  // 1. Only group messages
  if (message.type !== MessageType.GroupMessage && !message.isGroup) {
    return;
  }

  // 2. Ignore self messages
  if (message.isSelf) {
    return;
  }

  const threadId = String(message.threadId || "");
  const senderId = String(message.data?.uidFrom || "");
  if (!threadId || !senderId) return;

  if (isSelfSender(senderId, botUid)) {
    return;
  }

  const dateKey = getVietnamDateKey();
  const store = getLocmemStore(botUid);

  try {
    store.recordActivity({
      groupId: threadId,
      memberId: senderId,
      dateKey,
      messageCount: 1,
      reactionCount: 0,
      groupActionCount: 0,
    });
  } catch (err) {
    console.error(`[locmem-tracker] recordActivity message error: ${err.message}`);
    try {
      store.recordDowntime(threadId, dateKey, `sqlite_error: ${err.message}`);
    } catch {}
  }
}

/**
 * Tracks a valid group reaction:
 * - Ignores un-reactions (rType <= 0 or rType === -1).
 * - Ignores private reactions or self reactions.
 *
 * @param {object} api
 * @param {object} reaction
 * @param {string|object} [botUid="admin"]
 */
export function trackLocmemReaction(api, reaction, botUid = "admin") {
  if (!reaction || !reaction.data) return;

  const rType = reaction.data?.content?.rType;
  // Ignore un-reaction or missing rType
  if (rType === undefined || rType === null || Number(rType) <= 0) {
    return;
  }

  // Must be in group
  const threadId = String(
    (reaction.isGroup ? reaction.data?.idTo : null) ??
    reaction.threadId ??
    reaction.data?.idTo ??
    ""
  );
  if (!threadId) return;

  // Sender UID
  const senderId = String(reaction.data?.uidFrom ?? reaction.senderId ?? "");
  if (!senderId) return;

  // Ignore self
  if (isSelfSender(senderId, botUid)) {
    return;
  }

  const dateKey = getVietnamDateKey();
  const store = getLocmemStore(botUid);

  try {
    store.recordActivity({
      groupId: threadId,
      memberId: senderId,
      dateKey,
      messageCount: 0,
      reactionCount: 1,
      groupActionCount: 0,
    });
  } catch (err) {
    console.error(`[locmem-tracker] recordActivity reaction error: ${err.message}`);
    try {
      store.recordDowntime(threadId, dateKey, `sqlite_error: ${err.message}`);
    } catch {}
  }
}

/**
 * Tracks a group action event:
 * - Events with an actor (actorId/sourceId): UPDATE_BOARD (poll/vote),
 *   pin/topic/settings, new link, etc.
 * - Vote/poll recorded via UPDATE_BOARD.sourceId.
 * - Ignores self actions.
 *
 * @param {object} api
 * @param {object} event
 * @param {string|object} [botUid="admin"]
 */
export function trackLocmemGroupAction(api, event, botUid = "admin") {
  if (!event) return;

  // Ignore self events
  if (event.isSelf) {
    return;
  }

  const actorId = getGroupEventActorId(event);
  if (!actorId) {
    return;
  }

  if (isSelfSender(actorId, botUid)) {
    return;
  }

  const threadId = String(event.threadId || event.data?.groupId || "");
  if (!threadId) return;

  const dateKey = getVietnamDateKey();
  const store = getLocmemStore(botUid);

  try {
    store.recordActivity({
      groupId: threadId,
      memberId: actorId,
      dateKey,
      messageCount: 0,
      reactionCount: 0,
      groupActionCount: 1,
    });
  } catch (err) {
    console.error(`[locmem-tracker] recordActivity group action error: ${err.message}`);
    try {
      store.recordDowntime(threadId, dateKey, `sqlite_error: ${err.message}`);
    } catch {}
  }
}

/**
 * Takes snapshot of members for all groups bot participates in.
 * Initializes member activity counters to zero.
 * @param {object} api
 * @param {string} [botUid="admin"]
 * @param {string} [targetDateKey]
 * @returns {Promise<{ totalGroups: number, successfulGroups: number, failedGroups: number }>}
 */
export async function takeGroupSnapshots(api, botUid = "admin", targetDateKey = null) {
  const store = getLocmemStore(botUid);
  const dateKey = targetDateKey || getVietnamDateKey();

  if (!api || typeof api.getAllGroups !== "function") {
    store.recordDowntime(null, dateKey, "api_missing_getAllGroups");
    return { totalGroups: 0, successfulGroups: 0, failedGroups: 0 };
  }

  let allGroupsResult;
  try {
    allGroupsResult = await api.getAllGroups();
  } catch (err) {
    console.error(`[locmem-tracker] getAllGroups failed: ${err.message}`);
    store.recordDowntime(null, dateKey, `getAllGroups_failed: ${err.message}`);
    return { totalGroups: 0, successfulGroups: 0, failedGroups: 0 };
  }

  const groupIds = Object.keys(allGroupsResult?.gridVerMap || {});
  let successfulGroups = 0;
  let failedGroups = 0;

  for (const groupId of groupIds) {
    try {
      const groupInfo = typeof api.getGroupInfo === "function" ? await api.getGroupInfo(groupId) : null;
      if (!groupInfo) {
        throw new Error("Empty groupInfo returned");
      }
      const memberUids = extractGroupMemberUids(groupInfo, groupId);
      if (memberUids.length === 0) {
        throw new Error("No members extracted from groupInfo");
      }

      store.recordSnapshot(groupId, memberUids, dateKey);
      store.recordDailyCoverageSnapshot(groupId, dateKey, true);
      successfulGroups++;
    } catch (groupErr) {
      console.warn(`[locmem-tracker] snapshot failed for group ${groupId}: ${groupErr.message}`);
      store.recordDailyCoverageSnapshot(groupId, dateKey, false);
      store.recordDowntime(groupId, dateKey, `snapshot_failed: ${groupErr.message}`);
      failedGroups++;
    }
  }

  return { totalGroups: groupIds.length, successfulGroups, failedGroups };
}

/**
 * Executes midnight rollover in Asia/Ho_Chi_Minh:
 * 1. Checks and marks yesterday complete for groups that had no downtime and successful snapshot.
 * 2. Takes fresh snapshots for today.
 *
 * @param {object} api
 * @param {string} [botUid="admin"]
 * @param {object} [options]
 * @param {string} [options.yesterdayKey]
 * @param {string} [options.todayKey]
 */
export async function handleDayRollover(api, botUid = "admin", options = {}) {
  const store = getLocmemStore(botUid);
  const todayKey = options.todayKey || getVietnamDateKey();

  // Determine yesterdayKey in Asia/Ho_Chi_Minh
  let yesterdayKey = options.yesterdayKey;
  if (!yesterdayKey) {
    const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    yesterdayKey = getVietnamDateKey(yesterdayDate);
  }

  // 1. Mark yesterday complete (fail-closed if downtime/snapshot failed)
  try {
    if (api && typeof api.getAllGroups === "function") {
      const allGroupsResult = await api.getAllGroups().catch(() => null);
      const groupIds = Object.keys(allGroupsResult?.gridVerMap || {});
      for (const gId of groupIds) {
        store.markDayComplete(gId, yesterdayKey);
      }
    }
  } catch (markErr) {
    console.error(`[locmem-tracker] markDayComplete error: ${markErr.message}`);
  }

  // 2. Take snapshots for the new day
  try {
    await takeGroupSnapshots(api, botUid, todayKey);
  } catch (snapErr) {
    console.error(`[locmem-tracker] rollover snapshot error: ${snapErr.message}`);
  }
}

/**
 * Initializes tracking when the bot listener connects:
 * - Takes snapshots for today.
 * - If starting mid-day, marks downtime on today so today cannot be marked complete at midnight.
 * - Schedules midnight rollover cron job at 00:00:00 Asia/Ho_Chi_Minh.
 *
 * @param {object} api
 * @param {string} [botUid="admin"]
 * @param {object} [options]
 * @param {boolean} [options.isStartOfDay=false]
 */
export async function onListenerReady(api, botUid = "admin", options = {}) {
  const store = getLocmemStore(botUid);
  const todayKey = getVietnamDateKey();

  // Take snapshot now
  await takeGroupSnapshots(api, botUid, todayKey);

  // If not started exactly at the start of the day (e.g. boot/restart mid-day),
  // record downtime so today fails-closed and cannot be considered a full 24h complete day.
  if (!options.isStartOfDay) {
    store.recordDowntime(null, todayKey, "mid_day_listener_startup");
  }

  // Schedule rollover job at 00:00:00 UTC+7
  if (rolloverJobs.has(botUid)) {
    try {
      rolloverJobs.get(botUid).cancel();
    } catch {}
  }

  const job = schedule.scheduleJob({ rule: "0 0 * * *", tz: VIETNAM_TIMEZONE }, async () => {
    try {
      await handleDayRollover(api, botUid);
    } catch (err) {
      console.error(`[locmem-tracker] scheduled rollover error: ${err.message}`);
    }
  });

  if (job) {
    rolloverJobs.set(botUid, job);
  }

  // Schedule monthly cleanup at 03:10 (initialization automatically runs startup catch-up once)
  try {
    initializeMonthlyCleanupScheduler(botUid);
  } catch (err) {
    console.error(`[locmem-tracker] monthly cleanup init error: ${err.message}`);
  }
}

/**
 * Marks listener downtime (connection error / WebSocket closed).
 * @param {string} reason
 * @param {string|object} [botUid="admin"]
 */
export function markLocmemDowntime(reason = "listener_disconnected", botUid = "admin") {
  try {
    const store = getLocmemStore(botUid);
    const todayKey = getVietnamDateKey();
    store.recordDowntime(null, todayKey, String(reason || "listener_disconnected"));
  } catch (err) {
    console.warn(`[locmem-tracker] markLocmemDowntime warning: ${err.message}`);
  }
}

/**
 * Clears rollover schedule for botUid or all jobs if omitted (used in shutdown/tests).
 * @param {string|object} [botUid=null]
 */
export function clearRolloverJob(botUid = null) {
  if (botUid) {
    const key = typeof botUid === "string" ? botUid : (botUid?.botUid || botUid?.uid || "admin");
    if (rolloverJobs.has(key)) {
      try {
        rolloverJobs.get(key).cancel();
      } catch {}
      rolloverJobs.delete(key);
    }
  } else {
    for (const [key, job] of rolloverJobs.entries()) {
      try {
        job.cancel();
      } catch {}
    }
    rolloverJobs.clear();
  }
}
