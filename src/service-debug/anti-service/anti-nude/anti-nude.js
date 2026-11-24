import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { LRUCache } from "lru-cache";
import { MessageMention } from "../../../api-zalo/models/index.js";
import { MessageType } from "../../../api-zalo/models/Message.js";

import { sendMessageStateQuote } from "../../chat-zalo/chat-style/chat-style.js";
import { deleteFile, downloadFile } from "../../../utils/util.js";
import { withTempFile } from "../../../utils/temp-lease-manager.js";
import { getFfmpegExecutableSync } from "../../../utils/runtime-dependencies.js";
import { isInWhiteList } from "../white-list.js";
import { removeMention } from "../../../utils/format-util.js";
import { getVideoMetadata } from "../../../api-zalo/utils.js";
import { getAntiState, updateAntiConfig } from "../index.js";
import {
  extractMediaCandidate,
  isValidMediaUrl,
  stickerCache,
} from "./anti-nude-payload.js";
import { AntiNudeTaskLimiter } from "./anti-nude-limiter.js";
import { AntiNudeMetrics, globalAntiNudeMetrics } from "./anti-nude-metrics.js";

const execFileAsync = promisify(execFile);

export const blockedUsers = new LRUCache({ max: 1000, ttl: 5 * 60 * 1000 });
export const revokedMessagesCache = new LRUCache({ max: 5000, ttl: 30 * 60 * 1000 });
const VIOLATION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const PERCENT_NSFW = 40;

// Bounded concurrency task limiter replacing single-threaded ImageQueue
export const taskLimiter = new AntiNudeTaskLimiter({
  maxConcurrency: 2,
  maxQueueSize: 32,
});

// Per-user violation update locks to prevent race conditions
const userViolationLocks = new Map();

// In-flight background job tracking for test draining
const activeBackgroundJobs = new Set();

let mockClassifier = null;
let mockDownloader = null;
let mockFfmpeg = null;

export function setMockClassifierForTest(fn) {
  mockClassifier = fn;
}

export function resetMockClassifierForTest() {
  mockClassifier = null;
}

export function setMockDownloaderForTest(fn) {
  mockDownloader = fn;
}

export function resetMockDownloaderForTest() {
  mockDownloader = null;
}

export function setMockFfmpegForTest(fn) {
  mockFfmpeg = fn;
}

export function resetMockFfmpegForTest() {
  mockFfmpeg = null;
}

export function getUserViolationLockCountForTest() {
  return userViolationLocks.size;
}

export async function withUserViolationLock(userId, fn) {
  const currentPromise = userViolationLocks.get(userId) || Promise.resolve();
  let release;
  const nextPromise = new Promise((resolve) => {
    release = resolve;
  });
  const chainedPromise = currentPromise.then(() => nextPromise);
  userViolationLocks.set(userId, chainedPromise);

  try {
    await currentPromise;
    return await fn();
  } finally {
    release();
    if (userViolationLocks.get(userId) === chainedPromise) {
      userViolationLocks.delete(userId);
    }
  }
}

async function runFfmpeg(args, { timeoutMs = 15000 } = {}) {
  if (mockFfmpeg) {
    return mockFfmpeg(args, { timeoutMs });
  }
  const ffmpegBinary = getFfmpegExecutableSync();
  if (!ffmpegBinary) {
    throw new Error("FFmpeg không được cài đặt hoặc không thể truy cập");
  }
  await execFileAsync(ffmpegBinary, args, { timeout: timeoutMs, windowsHide: true });
}

function pruneExpiredNudeViolations(rawViolations, now = Date.now()) {
  const violations = { ...(rawViolations || {}) };
  let changed = false;
  for (const [userId, violation] of Object.entries(violations)) {
    if (!violation || now - Number(violation.lastViolation || 0) > VIOLATION_TIMEOUT_MS) {
      delete violations[userId];
      changed = true;
    }
  }
  return { violations, changed };
}

async function loadViolations() {
  const antiState = getAntiState();
  const { violations, changed } = pruneExpiredNudeViolations(antiState.data.violationsNude);
  if (changed) {
    updateAntiConfig({
      ...antiState.data,
      violationsNude: violations,
    });
  }
  return violations;
}

async function saveViolation(senderId, count, senderName, threadId) {
  const antiState = getAntiState();
  const { violations } = pruneExpiredNudeViolations(antiState.data.violationsNude);

  if (count <= 0) {
    delete violations[senderId];
  } else {
    violations[senderId] = {
      count,
      lastViolation: Date.now(),
      senderName,
      threadId,
    };
  }

  updateAntiConfig({
    ...antiState.data,
    violationsNude: violations,
  });
}

export async function classifyLocalImageFile(localFilePath, options = {}) {
  if (mockClassifier) {
    return mockClassifier(localFilePath);
  }
  let workerPool = options?.workerPool || null;
  if (!workerPool) {
    const { getActiveRuntimeLifecycle } = await import("../../../core/runtime-lifecycle.js");
    const lifecycle = getActiveRuntimeLifecycle();
    workerPool = lifecycle?.nsfwWorkerPool || null;
  }
  if (!workerPool) {
    throw new Error("NSFW worker pool is not available");
  }

  try {
    const res = await workerPool.runTask("classify", { filePath: localFilePath });
    if (res && typeof res.nsfwScore === "number") {
      return res.nsfwScore;
    }
    throw new Error("Invalid classification response from NSFW worker");
  } catch (firstErr) {
    console.warn("[anti-nude] NSFW worker error, pruning idle workers and retrying once:", firstErr.message);
    try {
      const busyCount = Number(workerPool.stats?.()?.busy ?? 0);
      if (firstErr?.workerPid && typeof workerPool.recycle === "function") {
        await workerPool.recycle(firstErr.workerPid);
      } else if (typeof workerPool.pruneIdle === "function") {
        await workerPool.pruneIdle();
      } else if (busyCount === 0 && typeof workerPool.recycleAll === "function") {
        await workerPool.recycleAll();
      }
    } catch {}
    const retryRes = await workerPool.runTask("classify", { filePath: localFilePath });
    if (retryRes && typeof retryRes.nsfwScore === "number") {
      return retryRes.nsfwScore;
    }
    throw new Error(`NSFW classification failed: ${firstErr.message}`);
  }
}

async function analyzeDynamicMedia({ localFilePath, ext, threshold, timings }) {
  let durationSec = 0;
  try {
    const meta = await Promise.race([
      getVideoMetadata(localFilePath),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Video duration probe timeout")), 2500);
        timer.unref?.();
      }),
    ]);
    durationSec = (meta?.duration || 0) / 1000;
  } catch {
    durationSec = 0;
  }

  let timestamps = [];
  if (durationSec > 1) {
    const mid = Number((durationSec / 2).toFixed(2));
    const end = Number((durationSec * 0.85).toFixed(2));
    timestamps = [...new Set([0, mid, end].filter((t) => typeof t === "number" && !isNaN(t)))];
  } else {
    // WebP, short GIF, or unprobed dynamic media
    timestamps = [0, 0.5, 1.0];
  }

  let maxNsfwScore = 0;
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    try {
      const frameScore = await withTempFile(".jpg", async (frameTempPath) => {
        const tExtractStart = performance.now();
        await runFfmpeg(["-ss", String(ts), "-i", localFilePath, "-vframes", "1", "-y", frameTempPath], {
          timeoutMs: 10000,
        });
        timings.frameExtractMs += performance.now() - tExtractStart;

        const tClassifyStart = performance.now();
        const score = await classifyLocalImageFile(frameTempPath);
        timings.classifyMs += performance.now() - tClassifyStart;
        return score;
      });

      maxNsfwScore = Math.max(maxNsfwScore, frameScore);
      if (maxNsfwScore > threshold) {
        // Short-circuit immediately on first violating frame!
        return {
          success: true,
          nsfwScore: maxNsfwScore,
          earlyRevoke: true,
          frameIndex: i,
          source: "frame",
        };
      }
    } catch (frameErr) {
      // If a later timestamp is out of range, log and continue
      console.warn(`[anti-nude] Lỗi trích xuất/chấm frame ${i} (ts=${ts}s):`, frameErr.message);
    }
  }

  return {
    success: true,
    nsfwScore: maxNsfwScore,
    earlyRevoke: false,
    source: "dynamic",
  };
}

export async function downloadAndAnalyzeMedia(mediaCandidate, threshold = PERCENT_NSFW, timings = {}) {
  const dlFn = mockDownloader || downloadFile;

  // Stage 1: Fast-path thumbnail check
  if (mediaCandidate.thumbUrl && isValidMediaUrl(mediaCandidate.thumbUrl)) {
    timings.thumbnailChecked = true;
    try {
      const thumbResult = await withTempFile(".jpg", async (thumbTempPath) => {
        const tDl = performance.now();
        await dlFn(mediaCandidate.thumbUrl, thumbTempPath, {
          maxBytes: 8 * 1024 * 1024,
          timeout: 6000,
        });
        timings.downloadMs += performance.now() - tDl;

        const tCl = performance.now();
        const score = await classifyLocalImageFile(thumbTempPath);
        timings.classifyMs += performance.now() - tCl;
        return score;
      });

      if (thumbResult > threshold) {
        // Thumbnail is NSFW: REVOKE IMMEDIATELY without downloading full dynamic media!
        timings.earlyRevoke = true;
        return {
          success: true,
          nsfwScore: thumbResult,
          earlyRevoke: true,
          source: "thumbnail",
        };
      }
    } catch (thumbErr) {
      console.warn("[anti-nude] Lỗi chấm thumbnail nhanh:", thumbErr.message);
    }
  }

  // If thumbnail was safe or absent, proceed to mediaUrl
  if (!mediaCandidate.mediaUrl || !isValidMediaUrl(mediaCandidate.mediaUrl)) {
    if (timings.thumbnailChecked) {
      return { success: true, nsfwScore: 0, earlyRevoke: false, source: "thumbnail_safe" };
    }
    const err = new Error("No valid media URL found to analyze");
    err.code = "INVALID_MEDIA_URL";
    throw err;
  }

  const urlPath = new URL(mediaCandidate.mediaUrl).pathname;
  const rawExt = path.extname(urlPath).toLowerCase() || "";
  const ext = rawExt.slice(1) || (mediaCandidate.isDynamic ? "mp4" : "jpg");

  if (mediaCandidate.isDynamic || ["mp4", "gif", "webp", "mov"].includes(ext)) {
    // Dynamic media: Download ONCE into a managed temp file
    return withTempFile(`.${ext}`, async (localMediaPath) => {
      const tDl = performance.now();
      await dlFn(mediaCandidate.mediaUrl, localMediaPath, {
        maxBytes: 25 * 1024 * 1024,
        timeout: 9000,
      });
      timings.downloadMs += performance.now() - tDl;

      return analyzeDynamicMedia({
        localFilePath: localMediaPath,
        ext,
        threshold,
        timings,
      });
    });
  }

  // Static image: Download once and classify
  return withTempFile(`.${ext || "jpg"}`, async (localImagePath) => {
    const tDl = performance.now();
    await dlFn(mediaCandidate.mediaUrl, localImagePath, {
      maxBytes: 15 * 1024 * 1024,
      timeout: 8000,
    });
    timings.downloadMs += performance.now() - tDl;

    const tCl = performance.now();
    const score = await classifyLocalImageFile(localImagePath);
    timings.classifyMs += performance.now() - tCl;

    return {
      success: true,
      nsfwScore: score,
      earlyRevoke: score > threshold,
      source: "image",
    };
  });
}

export async function downloadAndAnalyzeNudeImage(linkImage, messageType, thumbnail = null, options = {}) {
  const timings = {
    queueWaitMs: 0,
    downloadMs: 0,
    frameExtractMs: 0,
    classifyMs: 0,
    revokeMs: 0,
    totalMs: 0,
    violation: false,
    revoked: false,
    error: false,
    overloaded: false,
    thumbnailChecked: false,
    earlyRevoke: false,
  };

  const isDynamic = Boolean(
    messageType === "chat.video.msg" ||
    messageType === "chat.gif" ||
    /\.(mp4|gif|webp)(\?|$)/i.test(String(linkImage || ""))
  );

  const mediaCandidate = {
    hasMedia: Boolean(linkImage || thumbnail),
    mediaType: isDynamic ? "dynamic" : "photo",
    mediaUrl: linkImage,
    thumbUrl: thumbnail,
    isDynamic,
  };

  const threshold = options.threshold ?? PERCENT_NSFW;

  try {
    const result = await taskLimiter.run(async ({ queueWaitMs }) => {
      timings.queueWaitMs = queueWaitMs;
      return downloadAndAnalyzeMedia(mediaCandidate, threshold, timings);
    });

    if (options.detailed) {
      return { ...result, timings };
    }
    return Number((result?.nsfwScore ?? 0).toFixed(0));
  } catch (err) {
    if (err.code === "OVERLOADED") {
      timings.overloaded = true;
      timings.error = true;
    } else {
      timings.error = true;
    }
    console.warn("[anti-nude] Lỗi downloadAndAnalyzeNudeImage:", err.message);

    if (options.throwOnError) {
      throw err;
    }
    if (options.detailed) {
      return { success: false, error: err.message, timings };
    }
    // Return explicit error indicator or rethrow depending on options
    return 0;
  }
}

function getMessageDedupeKey(message, threadId) {
  const m = message?.data || message || {};
  const msgId = m.msgId || m.cliMsgId || message?.cliMsgId;
  if (msgId) return `${threadId}:${msgId}`;
  return `${threadId}:${m.uidFrom}:${m.msgType}:${m.sendTime || ""}:${m.content?.href || ""}`;
}

async function executeRevocation({
  api,
  message,
  threadId,
  senderId,
  senderName,
  nsfwProb,
  isWhiteList,
  groupSettings,
  botIsAdminBox,
  timings,
}) {
  const tRevokeStart = performance.now();

  // Deduplication check: revoke at most once per message
  const dedupeKey = getMessageDedupeKey(message, threadId);
  if (revokedMessagesCache.has(dedupeKey)) {
    return false;
  }
  revokedMessagesCache.set(dedupeKey, true);

  // Re-check antiNude status and bot permissions before acting
  if (!groupSettings?.[threadId]?.antiNude) {
    console.log(`[anti-nude] antiNude was turned off in thread ${threadId} during processing. Skipping action.`);
    return false;
  }
  if (!botIsAdminBox) {
    console.log(`[anti-nude] Bot is no longer admin in thread ${threadId}. Skipping action.`);
    return false;
  }

  // Serialize per-user violation updates
  await withUserViolationLock(senderId, async () => {
    const violations = await loadViolations();
    const userViolation = violations[senderId] || {
      count: 0,
      lastViolation: 0,
    };

    if (Date.now() - userViolation.lastViolation > 3600000) {
      userViolation.count = 0;
    }

    userViolation.count++;
    await saveViolation(senderId, userViolation.count, senderName, threadId);

    if (isWhiteList) {
      await api.deleteMessage(message, false);
      await api.sendMessage(
        {
          msg: `⚠️ ${senderName}!\nNội dung nhạy cảm đã bị thu hồi (Độ nhạy cảm: ${Math.max(nsfwProb, 50)}%).`,
          mentions: [MessageMention(senderId, senderName.length, "⚠️ ".length)],
          quote: message,
          ttl: 30000,
        },
        threadId,
        MessageType.GroupMessage
      );
    } else if (userViolation.count >= 5) {
      await handleNudeContent(api, message, threadId, senderId);
      await saveViolation(senderId, 0, senderName, threadId);
    } else {
      await api.deleteMessage(message, false);
      await api.sendMessage(
        {
          msg:
            `⚠️ Cảnh cáo ${senderName}!\n` +
            `Không gửi nội dung nhạy cảm trong nhóm! (Độ nhạy cảm: ${Math.max(nsfwProb, 50)}%).` +
            `\nVi phạm nhiều lần sẽ bị chặn khỏi nhóm!`,
          mentions: [MessageMention(senderId, senderName.length, "⚠️ Cảnh cáo ".length)],
          quote: message,
          ttl: 30000,
        },
        threadId,
        MessageType.GroupMessage
      );
    }
  });

  timings.revokeMs = performance.now() - tRevokeStart;
  timings.revoked = true;
  return true;
}

export async function antiNude(api, message, isAdminBox, groupSettings, botIsAdminBox, isSelf, options = {}) {
  const senderId = message?.data?.uidFrom;
  const senderName = message?.data?.dName || "Thành viên";
  const threadId = message?.threadId;

  // Fast preflight validation
  if (
    !threadId ||
    !senderId ||
    isAdminBox ||
    isSelf ||
    !botIsAdminBox ||
    blockedUsers.has(senderId) ||
    !groupSettings?.[threadId]?.antiNude
  ) {
    return false;
  }

  // Extract media candidate (image, GIF, sticker, video)
  const candidate = await extractMediaCandidate(api, message);
  if (!candidate.hasMedia) {
    return false;
  }

  const isWhiteList = isInWhiteList(groupSettings, threadId, senderId);
  const percentNsfw = isWhiteList ? 60 : PERCENT_NSFW;
  const tMessageStart = performance.now();

  const analyzeAndProcess = async () => {
    const timings = {
      queueWaitMs: 0,
      downloadMs: 0,
      frameExtractMs: 0,
      classifyMs: 0,
      revokeMs: 0,
      totalMs: 0,
      violation: false,
      revoked: false,
      error: false,
      overloaded: false,
      thumbnailChecked: false,
      earlyRevoke: false,
    };

    try {
      const result = await taskLimiter.run(async ({ queueWaitMs }) => {
        timings.queueWaitMs = queueWaitMs;
        return downloadAndAnalyzeMedia(candidate, percentNsfw, timings);
      });

      const nsfwScore = result?.nsfwScore ?? 0;
      if (nsfwScore > percentNsfw) {
        timings.violation = true;
        const revoked = await executeRevocation({
          api,
          message,
          threadId,
          senderId,
          senderName,
          nsfwProb: nsfwScore,
          isWhiteList,
          groupSettings,
          botIsAdminBox,
          timings,
        });
        return revoked;
      }
      return false;
    } catch (error) {
      if (error.code === "OVERLOADED") {
        timings.overloaded = true;
        timings.error = true;
        console.warn(`[anti-nude] Quá tải worker pool khi kiểm tra tin nhắn nhóm ${threadId}: ${error.message} (không tính vi phạm)`);
      } else {
        timings.error = true;
        console.warn(`[anti-nude] Lỗi khi kiểm tra nội dung media nhóm ${threadId}: ${error.message} (không tính vi phạm)`);
      }
      return false;
    } finally {
      timings.totalMs = performance.now() - tMessageStart;
      globalAntiNudeMetrics.record(timings);
    }
  };

  // If sync mode requested (e.g., in unit tests): await and return result
  if (options.sync === true) {
    return analyzeAndProcess();
  }

  // Non-blocking mode: Dispatch heavy analysis to background worker queue,
  // allowing text commands and message dispatch loop to respond immediately!
  const bgJob = analyzeAndProcess();
  activeBackgroundJobs.add(bgJob);
  bgJob.finally(() => activeBackgroundJobs.delete(bgJob));

  return false;
}

async function handleNudeContent(api, message, threadId, senderId) {
  try {
    blockedUsers.set(senderId, true);
    await api.deleteMessage(message, false);
    await api.blockUsers(threadId, [senderId]);
  } catch (error) {
    console.error("Lỗi khi xử lý nội dung nhạy cảm:", error.message);
  }
}

async function showNudeViolationHistory(api, message) {
  const threadId = message?.threadId;
  try {
    const mentions = message.data?.mentions;

    if (!mentions || mentions.length === 0) {
      await api.sendMessage(
        {
          msg: "Vui lòng tag (@mention) người dùng để xem lịch sử vi phạm.",
          quote: message,
          ttl: 30000,
        },
        threadId,
        message.type
      );
      return;
    }

    const violations = await loadViolations();

    let responseMsg = "📝 Lịch sử vi phạm gửi ảnh nhạy cảm:\n\n";
    const messageMentions = [];
    let mentionPosition = responseMsg.length;

    for (const mention of mentions) {
      const userId = mention.uid;
      const userName = message.data.content.substr(mention.pos, mention.len).replace("@", "");
      const violation = violations[userId];

      messageMentions.push(MessageMention(userId, userName.length, mentionPosition));

      if (!violation) {
        responseMsg += `${userName} chưa có vi phạm nào.\n\n`;
      } else {
        responseMsg += `${userName}:\n`;
        responseMsg += `Lần vi phạm gần nhất: ${new Date(violation.lastViolation).toLocaleString()}\n\n`;
      }

      mentionPosition = responseMsg.length;
    }

    await api.sendMessage(
      {
        msg: responseMsg.trim(),
        quote: message,
        mentions: messageMentions,
        ttl: 30000,
      },
      threadId,
      message.type
    );
  } catch (error) {
    console.error("Lỗi khi đọc lịch sử vi phạm:", error.message);
    await api.sendMessage(
      {
        msg: "Đã xảy ra lỗi khi đọc lịch sử vi phạm.",
        quote: message,
        ttl: 30000,
      },
      threadId,
      message.type
    );
  }
}

export async function handleAntiNudeCommand(api, message, groupSettings) {
  const content = removeMention(message);
  const threadId = message.threadId;
  const args = content.split(" ");
  const command = args[1]?.toLowerCase();

  if (!groupSettings[threadId]) {
    groupSettings[threadId] = {};
  }

  if (command === "list") {
    await showNudeViolationHistory(api, message);
    return true;
  }

  let newStatus;
  if (command === "on") {
    groupSettings[threadId].antiNude = true;
    newStatus = "bật";
  } else if (command === "off") {
    groupSettings[threadId].antiNude = false;
    newStatus = "tắt";
  } else {
    groupSettings[threadId].antiNude = !groupSettings[threadId].antiNude;
    newStatus = groupSettings[threadId].antiNude ? "bật" : "tắt";
  }

  const caption = `Chức năng chống nội dung nhạy cảm đã được ${newStatus}!`;
  await sendMessageStateQuote(api, message, caption, groupSettings[threadId].antiNude, 300000);

  return true;
}

export async function startNudeViolationCheck() {
  try {
    await loadViolations();
  } catch (error) {
    console.error("Lỗi khi dọn lịch sử vi phạm nude:", error.message);
  }
}

export function getAntiNudeMetrics() {
  return globalAntiNudeMetrics.getStats();
}

export function resetAntiNudeMetricsForTest() {
  globalAntiNudeMetrics.reset();
}

export async function waitForAntiNudeJobs() {
  await taskLimiter.drain();
  await Promise.all(Array.from(activeBackgroundJobs));
}

export function clearStickerCacheForTest() {
  stickerCache.clear();
}

export function clearRevokedMessagesForTest() {
  revokedMessagesCache.clear();
}
