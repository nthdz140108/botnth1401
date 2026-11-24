import { MessageType } from "../../api-zalo/index.js";
import {
  getCanonicalGroupSettingsPath,
  readGroupSettings,
  writeGroupSettings,
} from "../../utils/io-json.js";
import {
  resolveRandomChartTrack,
  deliverRandomChartTrack,
} from "../api-crawl/music/zingmp3.js";
import {
  searchVideoTiktok,
  sendTikTokMedia,
} from "../api-crawl/tiktok/tiktok-service.js";
import {
  sendRandomGirlVideo,
  resolveVideoPoolConfig,
  listLocalVideoCandidates,
  VideoSourceEmptyError,
} from "../chat-zalo/chat-special/send-video/send-video.js";
import {
  buildDefaultSendtaskSchedules,
  renderSendtaskQuery,
  SENDTASK_RETRY,
  SENDTASK_FALLBACK_KINDS,
  SENDTASK_FALLBACK_DEFAULTS,
} from "../../commands/studio/sendtask-defaults.js";
import { getOrCreateSendtaskSchedulerManager } from "./sendtask-scheduler-manager.js";

export const SENDTASK_BROADCAST_DEFAULTS = Object.freeze({
  concurrency: 3,
  timeoutMs: 180000,
  // 0 ở tầng broadcaster (test/tái sử dụng thư viện không bị chèn delay);
  // scheduler chạy thật áp SENDTASK_GROUP_DELAY_DEFAULT_MS qua initializeScheduler.
  groupDelayMs: 0,
});

// Khoảng cách giữa lúc bắt đầu xử lý 2 nhóm liên tiếp trong cùng một lượt
// broadcast production: tránh dội đồng loạt download/send vào một host lúc :05
// (nguyên nhân chính khiến imgur 429 cả host trong log VPS).
export const SENDTASK_GROUP_DELAY_DEFAULT_MS = 20000;

// Giới hạn chỉ số nhóm được stagger để tổng thời gian giãn cách có trần,
// tránh chờ quá lâu khi bật sendTask cho rất nhiều nhóm.
export const SENDTASK_GROUP_STAGGER_MAX_INDEX = 30;

/**
 * Kết quả chuẩn của một lần gửi:
 * - `sent`: media đã vào nhóm.
 * - `source-error`: nguồn chính (provider ngoài) lỗi trước khi gửi gì cả → được phép fallback.
 * - `source-empty`: nguồn chính hợp lệ nhưng rỗng/không có stream → được phép fallback.
 * - `delivery-error`: Zalo gửi lỗi/không xác nhận → KHÔNG fallback để tránh gửi trùng.
 */
export const SENDTASK_SOURCE_OUTCOMES = Object.freeze([
  "sent",
  "source-error",
  "source-empty",
  "delivery-error",
]);

// Giới hạn tuyệt đối số lần thử URL video cho MỘT nhóm trong MỘT lượt job
// (dùng chung giữa nguồn chính và fallback).
export const SENDTASK_VIDEO_ATTEMPT_LIMIT = 12;

function defaultLog(line) {
  console.log(line);
}

function condenseError(error) {
  const raw = error?.message || String(error);
  return String(raw).replace(/\s+/g, " ").slice(0, 160);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Chạy worker trên từng phần tử với số luồng song song giới hạn.
 * Mọi phần tử đều được thử dù một phần tử khác lỗi (allSettled semantics).
 */
export async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const parallelism = Math.max(1, Math.min(Number(limit) > 0 ? Number(limit) : list.length, list.length));
  let cursor = 0;

  async function runner() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = { ok: true, value: await worker(list[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }

  await Promise.allSettled(Array.from({ length: parallelism }, () => runner()));
  return results;
}

function raceWithTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`timed out after ${timeoutMs}ms`);
        error.code = "SENDTASK_TIMEOUT";
        reject(error);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function isMissingGroupError(error) {
  return Boolean(error?.message?.includes("Không tồn tại"));
}

async function disableSendTaskForThread(threadId) {
  const groupSettings = readGroupSettings();
  if (groupSettings[threadId]) {
    groupSettings[threadId].sendTask = false;
    writeGroupSettings(groupSettings);
    return true;
  }
  return false;
}

/**
 * Snapshot mọi thread đang bật SendTask tại thời điểm job bắt đầu.
 * Đọc từ canonical group-settings store của bot đang chạy, không lọc ngẫu nhiên
 * và không phụ thuộc activeBot.
 */
export function collectEnabledTargets(groupSettings = readGroupSettings()) {
  return Object.keys(groupSettings || {}).filter(
    (threadId) => groupSettings[threadId]?.sendTask === true,
  );
}

/**
 * Chuẩn hóa kết quả sender về protocol bốn trạng thái.
 * - `true` (legacy) coi như đã gửi.
 * - object có `status` hợp lệ giữ nguyên.
 * - `false`/undefined/object lạ là lỗi gửi Zalo (delivery-error).
 */
function normalizeSenderOutcome(result) {
  if (result === true) return { status: "sent" };
  if (result && typeof result === "object" && SENDTASK_SOURCE_OUTCOMES.includes(result.status)) {
    return result;
  }
  return { status: "delivery-error" };
}

async function sendGirlVideoToOne(api, threadId, { caption, ttl, type, attemptBudget, candidates = null }) {
  const message = {
    threadId,
    type: MessageType.GroupMessage,
  };
  // propagateErrors: lỗi thật (vd nhóm không tồn tại) phải nổi lên broadcaster
  // để tự tắt đúng nhóm thay vì bị nuốt thành false chung chung.
  return sendRandomGirlVideo(api, message, caption, type, ttl, {
    propagateErrors: true,
    attemptBudget,
    candidates,
  });
}

/**
 * Bộ nguồn mặc định nối vào service thật.
 * Tách bạch giai đoạn NGUỒN (provider ngoài) và GỬI (Zalo) để phân loại lỗi.
 * Test có thể inject toàn bộ qua options.sources.
 */
function defaultSources() {
  return {
    searchTiktok: (query) => searchVideoTiktok(query),
    deliverTikTok: async (api, threadId, media, { caption } = {}) => {
      const message = {
        threadId,
        type: MessageType.GroupMessage,
        data: { uidFrom: "", dName: "Bot" },
      };
      // Caption của lịch (dòng "> SendTask HH:05 <") được truyền vào để
      // video/slideshow TikTok cũng báo sendtask như các khung giờ khác.
      await sendTikTokMedia(api, message, media, { isRandom: true, caption });
      return true;
    },
    resolveZingTrack: () => resolveRandomChartTrack(),
    deliverZingTrack: async (api, threadId, track, { caption, ttl }) => {
      const message = { threadId, type: MessageType.GroupMessage };
      await deliverRandomChartTrack(api, message, track, caption, ttl);
      return true;
    },
    loadGirlPool: (category) => {
      // Snapshot candidate MỘT lần mỗi lượt broadcast cho category tương ứng:
      // mọi pool video đều local, quét .mp4 trong <project-root>/video/.
      const config = resolveVideoPoolConfig({ type: !category || category === "default" ? "girl" : category });
      if (!config) return [];
      return listLocalVideoCandidates(config.source);
    },
    sendGirlVideo: (api, threadId, payload) => sendGirlVideoToOne(api, threadId, payload),
  };
}

function resolveFallbackConfig(record) {
  const rawKind = record.fallbackKind === undefined || record.fallbackKind === null
    ? SENDTASK_FALLBACK_DEFAULTS.kind
    : String(record.fallbackKind);
  const enabled = rawKind !== "" && SENDTASK_FALLBACK_KINDS.includes(rawKind);
  return {
    kind: enabled ? rawKind : null,
    category: enabled ? String(record.fallbackCategory || SENDTASK_FALLBACK_DEFAULTS.category) : "",
  };
}

/**
 * Lấy nguồn TikTok dùng chung cho cả batch, retry + timeout theo cấu hình.
 * Timeout ở đây chỉ là NGUỒN chưa xác nhận (chưa gửi gì) nên xếp vào source-error.
 * Kết quả rỗng dừng ngay (không retry) vì query đã thành công mà không có nội dung.
 */
async function fetchSharedTiktokSource(sources, query, retry, timeoutMs) {
  const maxRetries = Number.isFinite(retry.maxRetries) ? retry.maxRetries : SENDTASK_RETRY.maxRetries;
  const backoffMs = Number.isFinite(retry.backoffMs) ? retry.backoffMs : SENDTASK_RETRY.backoffMs;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0 && backoffMs > 0) {
      await sleep(backoffMs * attempt);
    }
    try {
      const list = await raceWithTimeout(
        Promise.resolve().then(() => sources.searchTiktok(query)),
        timeoutMs,
      );
      if (Array.isArray(list) && list.length > 0) {
        return { state: "ok", mediaList: list, error: null };
      }
      return { state: "empty", mediaList: [], error: null };
    } catch (error) {
      lastError = error;
    }
  }
  return { state: "error", mediaList: null, error: lastError };
}

function buildPrimarySender({ kind, category, caption, ttlMinutes, sharedSource, sources }) {
  if (kind === "tiktok-search") {
    const mediaList = sharedSource.state === "ok" ? sharedSource.mediaList : [];
    if (mediaList.length === 0) {
      return async () => ({
        status: sharedSource.state === "error" ? "source-error" : "source-empty",
        error: sharedSource.error ?? undefined,
      });
    }
    return async (api, threadId) => {
      const randomIndex = Math.floor(Math.random() * mediaList.length);
      await sources.deliverTikTok(api, threadId, mediaList[randomIndex], { caption });
      return { status: "sent" };
    };
  }

  if (kind === "zing-chart") {
    return async (api, threadId) => {
      let track;
      try {
        track = await sources.resolveZingTrack(api, threadId);
      } catch (error) {
        return { status: "source-error", error };
      }
      if (!track || !track.linkMusic) {
        return { status: "source-empty" };
      }
      // Từ đây trở đi là giai đoạn GỬI: mọi exception phải nổi lên nguyên trạng
      // (kể cả "Không tồn tại") để broadcaster phân loại, không fallback mù quáng.
      await sources.deliverZingTrack(api, threadId, track, { caption, ttl: ttlMinutes });
      return { status: "sent" };
    };
  }

  // girl-video (mặc định): pool đọc đồng bộ từ file tĩnh hoặc quét folder local
  const poolLinks = sources.loadGirlPool(category);
  if (!Array.isArray(poolLinks) || poolLinks.length === 0) {
    return async () => ({ status: "source-empty" });
  }
  return (api, threadId, deliveryContext) => sendGirlVideoToOne(api, threadId, {
    caption,
    ttl: ttlMinutes,
    type: category || "default",
    attemptBudget: deliveryContext.videoAttemptBudget,
    // Snapshot dùng chung cả batch: mỗi nhóm vẫn shuffle/random độc lập.
    candidates: poolLinks,
  });
}

function buildFallbackSender({ fallback, caption, ttlMinutes, sources }) {
  if (!fallback.kind) return null;
  // Hiện tại fallback chỉ hỗ trợ pool video nội bộ (girl-video)
  const poolLinks = sources.loadGirlPool(fallback.category);
  if (!Array.isArray(poolLinks) || poolLinks.length === 0) {
    return null;
  }
  return (api, threadId, deliveryContext) => sources.sendGirlVideo(api, threadId, {
    caption,
    ttl: ttlMinutes,
    type: fallback.category || "default",
    attemptBudget: deliveryContext.videoAttemptBudget,
    candidates: poolLinks,
  });
}

async function deliverPrimary(api, threadId, primaryFn, { timeoutMs, retry, deliveryContext }) {
  const maxRetries = Number.isFinite(retry.maxRetries) ? retry.maxRetries : SENDTASK_RETRY.maxRetries;
  const backoffMs = Number.isFinite(retry.backoffMs) ? retry.backoffMs : SENDTASK_RETRY.backoffMs;
  const disableOnMissingGroup = retry.disableOnMissingGroup !== false;

  let lastError = null;
  let attempts = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0 && backoffMs > 0) {
      await sleep(backoffMs * attempt);
    }
    try {
      const raw = await raceWithTimeout(
        Promise.resolve().then(() => primaryFn(api, threadId, deliveryContext)),
        timeoutMs,
      );
      const outcome = normalizeSenderOutcome(raw);
      attempts = attempt + 1;
      if (outcome.status === "sent") {
        return { status: "sent", deliveredBy: "primary", attempts };
      }
      if (outcome.status === "source-error" || outcome.status === "source-empty") {
        // Nguồn hỏng/rỗng TRƯỚC khi gửi gì cả → an toàn để chuyển fallback
        return { status: "needs-fallback", sourceStatus: outcome.status, error: outcome.error ?? null, attempts };
      }
      lastError = outcome.error ?? null;
    } catch (error) {
      attempts = attempt + 1;
      if (error?.code === "SENDTASK_TIMEOUT") {
        return { status: "timedOut", attempts, error };
      }
      if (error instanceof VideoSourceEmptyError || error?.code === "VIDEO_SOURCE_EMPTY") {
        // Pool cạn URL healthy (rỗng/dead hết/host cooldown) TRƯỚC khi gửi gì cả
        // -> an toàn để chuyển fallback thay vì tính là lỗi gửi Zalo.
        return { status: "needs-fallback", sourceStatus: "source-empty", attempts, error };
      }
      if (disableOnMissingGroup && isMissingGroupError(error)) {
        return { status: "missing", attempts, error };
      }
      lastError = error;
    }
  }
  return { status: "delivery-error", attempts, error: lastError };
}

/**
 * Fan-out một record Sendtask tới TẤT CẢ các nhóm đã bật sendTask === true.
 * - Mỗi nhóm gọi sender riêng nên nhận media riêng trong đúng category.
 * - Nguồn TikTok lấy MỘT lần cho cả batch (retry + timeout theo cấu hình);
 *   lỗi/rỗng sẽ chuyển từng nhóm sang fallback thay vì bỏ trắng cả lịch.
 * - Fallback chỉ chạy khi nguồn chính lỗi/rỗng trước khi gửi, đúng MỘT lần,
 *   không bao giờ chạy lại sau lỗi gửi Zalo mơ hồ (tránh gửi trùng).
 * - Concurrency mặc định 3, timeout 180s cho từng nhóm; retry theo từng nhóm,
 *   không retry lại cả batch để tránh gửi trùng nhóm đã thành công.
 * @param {object} api Zalo API client
 * @param {object} record Schedule record (id, kind, category, fallbackKind, ...)
 * @param {object} [options]
 * @returns {Promise<object>} summary của lượt phát
 */
export async function broadcastSendtaskRecord(api, record, options = {}) {
  const logger = options.logger || { log: defaultLog, warn: (line) => defaultLog(line), error: (line) => defaultLog(line) };
  const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : SENDTASK_BROADCAST_DEFAULTS.concurrency;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : SENDTASK_BROADCAST_DEFAULTS.timeoutMs;
  const retry = {
    maxRetries: Number.isFinite(options.retry?.maxRetries) ? options.retry.maxRetries : SENDTASK_RETRY.maxRetries,
    backoffMs: Number.isFinite(options.retry?.backoffMs) ? options.retry.backoffMs : SENDTASK_RETRY.backoffMs,
    disableOnMissingGroup: options.retry?.disableOnMissingGroup !== false,
  };
  const sources = { ...defaultSources(), ...(options.sources || {}) };

  const kind = record.kind || "girl-video";
  const category = record.category || "";
  const caption = record.caption || "";
  const timeToLive = Number(record.ttlMinutes || 60) * 60 * 1000;
  const fallback = resolveFallbackConfig(record);
  const settingsPath = getCanonicalGroupSettingsPath();
  const ranAt = new Date().toISOString();

  // Chuẩn bị nguồn dùng chung (TikTok search một lần, mỗi nhóm random riêng)
  let sharedSource = { state: "ok", mediaList: null, error: null };
  if (kind === "tiktok-search") {
    const query = renderSendtaskQuery(record.queryTemplate, { timestamp: Date.now() });
    sharedSource = await fetchSharedTiktokSource(sources, query, retry, timeoutMs);
  }

  const summaryBase = {
    jobId: record.id || "-",
    ranAt,
    timezone: record.timezone || "",
    kind,
    category,
    primaryKind: kind,
    fallbackKind: fallback.kind || "",
    fallbackCategory: fallback.category || "",
    settingsPath,
  };

  // Chụp snapshot nhóm bật NGAY TRƯỚC khi fan-out
  const enabledTargets = collectEnabledTargets(readGroupSettings());
  const logContext = `${summaryBase.jobId} at=${ranAt} tz=${summaryBase.timezone} primaryKind=${kind}${category ? ` category=${category}` : ""} settings=${settingsPath}`;

  if (enabledTargets.length === 0) {
    logger.warn(`[sendtask] broadcast ${logContext} fallback=${fallback.kind ? `${fallback.kind}/${fallback.category}` : "none"} enabledTargets=0 attempted=0 sent=0 failed=0 timedOut=0 disabledMissing=0 fallbackUsed=0`);
    return {
      ...summaryBase,
      sourceStatus: sharedSource.state,
      enabledTargets: 0,
      attempted: 0,
      sent: 0,
      failed: 0,
      timedOut: 0,
      disabledMissing: 0,
      fallbackUsed: 0,
      deliveries: [],
      failures: [],
    };
  }

  const primaryFn = buildPrimarySender({ kind, category, caption, ttlMinutes: timeToLive, sharedSource, sources });
  const fallbackFn = buildFallbackSender({ fallback, caption, ttlMinutes: timeToLive, sources });
  const groupDelayMs = Number.isFinite(options.groupDelayMs) ? Math.max(0, options.groupDelayMs) : SENDTASK_BROADCAST_DEFAULTS.groupDelayMs;

  const outcomes = await runWithConcurrency(enabledTargets, concurrency, async (threadId, targetIndex) => {
    // Giãn cách điểm bắt đầu giữa các nhóm: các nhóm không dồn download/send
    // vào cùng một khoảnh khắc (giảm 429 từ host nguồn và throttle Zalo).
    if (groupDelayMs > 0 && targetIndex > 0) {
      await sleep(groupDelayMs * Math.min(targetIndex, SENDTASK_GROUP_STAGGER_MAX_INDEX));
    }
    // Ngân sách 12 lần thử URL cho NGUỒN CHÍNH của nhóm này
    const deliveryContext = { videoAttemptBudget: { remaining: SENDTASK_VIDEO_ATTEMPT_LIMIT } };
    const primary = await deliverPrimary(api, threadId, primaryFn, { timeoutMs, retry, deliveryContext });

    if (primary.status !== "needs-fallback") {
      return { ...primary, threadId };
    }

    logger.warn(`[sendtask] target=${threadId} primary=${primary.sourceStatus} -> fallback=${fallback.kind ? `${fallback.kind}/${fallback.category}` : "disabled"}`);

    if (!fallbackFn) {
      return {
        status: "failed",
        sourceFailure: primary.sourceStatus,
        attempts: primary.attempts,
        error: primary.error,
        threadId,
      };
    }

    // Fallback đúng MỘT lần; lỗi ở đây không được thử lại bằng nguồn khác nữa.
    // Fallback có ngân sách thử URL RIÊNG để pool chính cạn URL healthy
    // (dead/cooldown) thì fallback vẫn còn cơ hội chọn được URL sống.
    const fallbackContext = { videoAttemptBudget: { remaining: SENDTASK_VIDEO_ATTEMPT_LIMIT } };
    try {
      const rawFb = await raceWithTimeout(
        Promise.resolve().then(() => fallbackFn(api, threadId, fallbackContext)),
        timeoutMs,
      );
      const fbOutcome = normalizeSenderOutcome(rawFb);
      if (fbOutcome.status === "sent") {
        return { status: "sent", deliveredBy: "fallback", fallbackReason: primary.sourceStatus, attempts: primary.attempts, threadId };
      }
      return {
        status: "failed",
        fallbackReason: primary.sourceStatus,
        fallbackFailed: true,
        attempts: primary.attempts,
        error: fbOutcome.error ?? null,
        threadId,
      };
    } catch (error) {
      if (error?.code === "SENDTASK_TIMEOUT") {
        return { status: "timedOut", fallbackReason: primary.sourceStatus, error, threadId };
      }
      if (retry.disableOnMissingGroup !== false && isMissingGroupError(error)) {
        return { status: "missing", fallbackReason: primary.sourceStatus, error, threadId };
      }
      return {
        status: "failed",
        fallbackReason: primary.sourceStatus,
        fallbackFailed: true,
        attempts: primary.attempts,
        error,
        threadId,
      };
    }
  });
  let sent = 0;
  let failed = 0;
  let timedOut = 0;
  let disabledMissing = 0;
  let fallbackUsed = 0;
  const failures = [];
  const deliveries = [];

  for (const outcome of outcomes) {
    const result = outcome?.ok ? outcome.value : { status: "failed", threadId: "?", error: outcome?.error };
    const threadId = result.threadId;
    if (result.status === "sent") {
      sent += 1;
      const deliveredBy = result.deliveredBy === "fallback" ? "fallback" : "primary";
      if (deliveredBy === "fallback") fallbackUsed += 1;
      deliveries.push({
        threadId,
        status: "sent",
        deliveredBy,
        attempts: result.attempts ?? null,
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      });
      continue;
    }
    if (result.status === "timedOut") {
      timedOut += 1;
      failures.push({
        threadId,
        status: "timedOut",
        attempts: result.attempts,
        error: condenseError(result.error),
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      });
      deliveries.push({ threadId, status: "timedOut", deliveredBy: null, attempts: result.attempts ?? null });
      continue;
    }
    if (result.status === "missing") {
      // API xác nhận nhóm không còn tồn tại -> tắt cờ và persist ngay vào canonical store
      const disabled = outcome.ok
        ? await disableSendTaskForThread(threadId)
        : false;
      if (disabled) disabledMissing += 1;
      failures.push({
        threadId,
        status: "missing",
        attempts: result.attempts,
        error: condenseError(result.error),
        disabled,
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      });
      deliveries.push({ threadId, status: "missing", deliveredBy: null, attempts: result.attempts ?? null });
      continue;
    }
    failed += 1;
    failures.push({
      threadId,
      status: "failed",
      attempts: result.attempts ?? null,
      error: condenseError(result.error),
      ...(result.sourceFailure ? { sourceFailure: result.sourceFailure } : {}),
      ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      ...(result.fallbackFailed ? { fallbackFailed: true } : {}),
    });
    deliveries.push({
      threadId,
      status: "failed",
      deliveredBy: null,
      attempts: result.attempts ?? null,
      ...(result.sourceFailure ? { fallbackEligible: true, fallbackReason: result.sourceFailure } : {}),
    });
  }

  for (const failure of failures) {
    logger.warn(`[sendtask] target=${failure.threadId} status=${failure.status} attempts=${failure.attempts ?? "-"}${failure.disabled ? " disabled=true" : ""}${failure.fallbackReason ? ` fallbackReason=${failure.fallbackReason}` : ""} lastError="${failure.error || ""}"`);
  }

  logger.log(`[sendtask] broadcast ${logContext} fallback=${fallback.kind ? `${fallback.kind}/${fallback.category}` : "none"} enabledTargets=${enabledTargets.length} attempted=${enabledTargets.length} sent=${sent} failed=${failed} timedOut=${timedOut} disabledMissing=${disabledMissing} fallbackUsed=${fallbackUsed}`);

  return {
    ...summaryBase,
    sourceStatus: sharedSource.state,
    ...(sharedSource.state === "error" && sharedSource.error ? { sourceError: condenseError(sharedSource.error) } : {}),
    enabledTargets: enabledTargets.length,
    attempted: enabledTargets.length,
    sent,
    failed,
    timedOut,
    disabledMissing,
    fallbackUsed,
    deliveries,
    failures,
  };
}

export async function executeSendtaskRecord(api, record, options = {}) {
  return broadcastSendtaskRecord(api, record, options);
}

function logManagerStatus(manager, phase, schedules = []) {
  const status = manager.status();
  const timezone = schedules[0]?.timezone || "-";
  const nextRuns = [...manager.handles.entries()]
    .map(([id, handle]) => ({ id, next: handle?.nextInvocation?.() || null }))
    .sort((a, b) => (a.next?.getTime() ?? Infinity) - (b.next?.getTime() ?? Infinity));
  const nextLine = nextRuns[0]?.next ? ` next=${nextRuns[0].next.toISOString()} (${nextRuns[0].id})` : " next=-";
  console.log(
    `[sendtask-scheduler] phase=${phase} jobs=${status.jobs.length} revision=${status.revision} timezone=${timezone}${nextLine}`,
  );
}

export async function initializeScheduler(api, options = {}) {
  const manager = options.manager || getOrCreateSendtaskSchedulerManager(options.schedulerOptions);
  manager.bindTaskFactory(async (record) => {
    // Retry theo từng nhóm diễn ra bên trong broadcaster;
    // không retry lại cả batch vì sẽ gửi trùng cho nhóm đã thành công.
    await executeSendtaskRecord(api, record, {
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      retry: options.retry,
      groupDelayMs: options.groupDelayMs ?? SENDTASK_GROUP_DELAY_DEFAULT_MS,
    });
  });
  const schedules = options.schedules || buildDefaultSendtaskSchedules();
  const activeSchedules = schedules.filter((row) => row.enabled !== false);
  const result = await manager.sync(activeSchedules);
  logManagerStatus(manager, options.schedules ? "reload" : "startup", activeSchedules);
  return { manager, result };
}
