import fs from "node:fs";
import { getProjectRoot } from "../../../utils/env.js";
import { createBotListImage } from "../list-canvas.js";
import { setSelectionsMapData } from "../../../service-debug/api-crawl/index.js";
import { sendMessageWarning } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { resolveOwnedActivationCandidates, resolveOwnerActiveSlot } from "./mybot-active-slot.js";
export { resolveOwnedActivationCandidates, resolveOwnerActiveSlot };

/*
  ownerUid,
  registry = null,
  projectRoot = getProjectRoot(),
} = {}) {
  const normOwner = String(ownerUid || "").trim();
  if (!normOwner) return [];

  const root = projectRoot || getProjectRoot();
  const reg = registry || loadMyBotsRegistry(path.join(root, "mybot", "mybots.json"));
  const candidates = [];

  for (const [key, bot] of Object.entries(reg)) {
    if (!bot || typeof bot !== "object") continue;
    if (bot.isMain === true || key === "admin" || String(bot.name || "").toLowerCase() === "admin") {
      continue;
    }

    const bOwner = String(
      bot.ownerUid ||
      bot.createdByUid ||
      (/^\d{10,}$/.test(String(bot.createdBy || "")) ? bot.createdBy : "")
    ).trim();

    if (bOwner === normOwner && bot.status !== "deleting") {
      const profile = getProfile(bot.uid || key, { root }) || {};
      const mergedBot = {
        key,
        uid: bot.uid || key,
        name: bot.name || key,
        displayName: bot.displayName || profile.nameServer || bot.name || key,
        ownerUid: bOwner,
        ownerName: bot.ownerName || profile.ownerName || "",
        status: bot.status || profile.status || "stopped",
        trialStatus: profile.trialStatus || bot.trialStatus || "pending",
        expiryAt: profile.expiryAt ?? bot.expiryAt ?? null,
        avatar: bot.avatar || profile.avatar || "",
        enabled: bot.enabled !== false && profile.enabled !== false,
        webPort: bot.webPort || profile.webPort,
        createdAt: bot.createdAt || profile.createdAt || 0,
        rawRecord: bot,
        profile,
      };
      candidates.push(mergedBot);
    }
  }

  // Stable sort: by createdAt ascending or name/key
  candidates.sort((a, b) => {
    const timeA = new Date(a.createdAt || 0).getTime();
    const timeB = new Date(b.createdAt || 0).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return String(a.key).localeCompare(String(b.key));
  });

  return candidates;
}

//
 * Checks if owner already has an active slot occupied.
 * Active slot is occupied if a bot belonging to the owner is:
 * - starting or running (or runtime PID active)
 * - has valid unexpired trial
 * - has valid unexpired plan / lifetime
//
export function resolveOwnerActiveSlot({
  ownerUid,
  candidates = null,
  registry = null,
  projectRoot = getProjectRoot(),
  runtimeResolver = null,
} = {}) {
  const normOwner = String(ownerUid || "").trim();
  if (!normOwner) return { occupied: false, activeBot: null, reason: null };

  const list = candidates || resolveOwnedActivationCandidates({ ownerUid: normOwner, registry, projectRoot });
  const now = Date.now();

  for (const bot of list) {
    if (bot.status === "rejected" || bot.enabled === false) {
      continue;
    }

    // 1. Process is running or starting
    let isRunning = bot.status === "running" || bot.status === "starting";
    if (runtimeResolver && typeof runtimeResolver.isBotRunning === "function") {
      isRunning = isRunning || runtimeResolver.isBotRunning(bot.uid || bot.key);
    }

    if (isRunning) {
      return {
        occupied: true,
        activeBot: bot,
        reason: "BOT_RUNNING",
      };
    }

    // 2. Unexpired trial or lifetime / plan
    const isPermanent = bot.expiryAt === "-1" || bot.expiryAt === -1;
    const isUnexpired = bot.expiryAt && new Date(bot.expiryAt).getTime() > now;

    if (isPermanent || isUnexpired) {
      return {
        occupied: true,
        activeBot: bot,
        reason: isPermanent ? "PERMANENT_ACTIVE" : (bot.trialStatus === "active" ? "TRIAL_ACTIVE" : "UNEXPIRED_PLAN"),
      };
    }
  }

  return {
    occupied: false,
    activeBot: null,
    reason: null,
  };
*/

/**
 * Opens an interactive selection session for selecting which bot to activate.
 */
export async function openMyBotActiveSelection({
  api,
  message,
  candidates,
  onSelect,
  projectRoot = getProjectRoot(),
  schedule,
  cancelSchedule,
  now,
} = {}) {
  const senderId = message?.data?.uidFrom || message?.senderId;
  const threadId = message?.threadId || message?.data?.idTo || message?.data?.threadId;
  const messageType = message?.type;

  if (!candidates || candidates.length === 0) {
    return await sendMessageWarning(
      api,
      message,
      "Bạn chưa sở hữu bot nào để kích hoạt! Vui lòng dùng lệnh qrlogin để tạo bot.",
      true,
      false
    );
  }

  // Render canvas table image
  let imagePath = null;
  try {
    imagePath = await createBotListImage(candidates, api);
  } catch (renderErr) {
    console.error("Lỗi tạo ảnh danh sách bot active:", renderErr);
  }

  const promptCaption = `📋 DANH SÁCH BOT CỦA BẠN (${candidates.length} bot)\n\nReply tin nhắn này hoặc chat số thứ tự để chọn bot cần chạy. Bạn có 60 giây để lựa chọn.`;

  const payload = {
    msg: promptCaption,
    ttl: 60000,
    quote: message,
  };
  if (imagePath && fs.existsSync(imagePath)) {
    payload.attachments = [imagePath];
  }

  let sentMessage = null;
  try {
    sentMessage = await api.sendMessage(payload, threadId, messageType);
  } catch (sendErr) {
    console.error("Lỗi gửi tin nhắn chọn bot active:", sendErr);
    if (imagePath && fs.existsSync(imagePath)) {
      try { fs.unlinkSync(imagePath); } catch {}
    }
    return null;
  }

  const selectionRecord = await setSelectionsMapData(senderId, {
    api,
    sentMessage,
    messageContext: message,
    platform: "mybot-active",
    requireThreadMatch: true,
    collection: candidates,
    seconds: 60,
    threadId,
    senderId,
    userRequest: senderId,
    schedule,
    cancelSchedule,
    now,
    ownedTempPaths: imagePath ? [imagePath] : [],
    onSelect: async (selectedCandidate, selectedIndex, modifier, replyMsg, claimFn) => {
      if (typeof claimFn === "function") {
        const claimed = await claimFn();
        if (!claimed) return false;
      }

      // Re-resolve candidate from registry to ensure fresh status
      const freshCandidates = resolveOwnedActivationCandidates({
        ownerUid: senderId,
        projectRoot,
      });
      const freshBot = freshCandidates.find(
        (b) => b.uid === selectedCandidate.uid || b.key === selectedCandidate.key
      ) || selectedCandidate;

      if (typeof onSelect === "function") {
        await onSelect(freshBot, selectedIndex, replyMsg);
      }
      return true;
    },
  });

  return selectionRecord;
}
