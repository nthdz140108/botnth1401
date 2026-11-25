import fs from "fs";
import path from "path";
import { MessageMention } from "../../../../api-zalo/models/Message.js";
import { removeMention } from "../../../../utils/format-util.js";
import { getProjectRoot } from "../../../../utils/env.js";
import {
  downloadVideoToTempFile,
  removeTemporaryFile,
} from "../../../../api-zalo/media/video-temp-file.js";
import {
  VideoToolMissingError,
  VideoFileUnreadableError,
  isToolMissingError,
  prepareLocalVideoMedia as defaultPrepareLocalVideoMedia,
} from "./video-media-prepare.js";

export { VideoToolMissingError, VideoFileUnreadableError, isToolMissingError };

/**
 * Preparer đang hoạt động cho luồng local (mặc định: ffprobe + ffmpeg thật).
 * Test/SendTask smoke có thể inject stub qua setLocalVideoMediaPreparer().
 */
let activeLocalMediaPreparer = defaultPrepareLocalVideoMedia;

export function setLocalVideoMediaPreparer(preparer) {
  activeLocalMediaPreparer = typeof preparer === "function" ? preparer : defaultPrepareLocalVideoMedia;
}

export function getLocalVideoMediaPreparer() {
  return activeLocalMediaPreparer;
}

/**
 * Lỗi nguồn video rỗng/thiếu (folder .mp4 trống hoặc không tồn tại).
 * Scheduler dùng lỗi này để chuyển fallback an toàn (chưa gửi gì cả).
 */
export class VideoSourceEmptyError extends Error {
  constructor(message = "Video source is empty") {
    super(message);
    this.name = "VideoSourceEmptyError";
    this.code = "VIDEO_SOURCE_EMPTY";
  }
}

export const VIDEO_SOURCE_KINDS = Object.freeze({
  LOCAL_DIRECTORY: "local-directory",
});

// Thư mục pool video local, đặt cạnh run.bat / bot.js (ngoài Git).
export const LOCAL_VIDEO_POOL_ROOT = "video";

// Mười pool local ánh xạ từ lệnh vd*, bao gồm vdsex chuyển từ URL online sang local.
export const LOCAL_VIDEO_POOL_DIRS = Object.freeze([
  "vdgirl",
  "vdsexy",
  "vdanime",
  "vdboy",
  "vdchill",
  "vdsad",
  "vdtet",
  "vdcos",
  "vdvuto",
  "vdsex",
]);

// Cấu hình video canonical: mọi lệnh vd* và SendTask video đều quét
// .mp4 trong <project-root>/video/<source> mỗi lượt gửi.
export const VIDEO_TYPES = {
  girl: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdgirl", ttl: 3600000 },
      sexy: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdsexy", ttl: 3600000, type: "Sexy" },
    },
  },
  sexy: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdsexy", ttl: 3600000 },
    },
  },
  anime: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdanime", ttl: 3600000 },
    },
  },
  tet: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdtet", ttl: 336000000 },
    },
  },
  cosplay: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdcos", ttl: 3600000 },
    },
  },
  gai: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdgirl", ttl: 3600000 },
    },
  },
  boy: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdboy", ttl: 3600000 },
    },
  },
  chill: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdchill", ttl: 3600000 },
    },
  },
  vuto: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdvuto", ttl: 3600000 },
    },
  },
  sad: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdsad", ttl: 3600000 },
    },
  },
  sex: {
    variants: {
      default: { kind: VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY, source: "vdsex", ttl: 3600000 },
    },
  },
};

const KEYWORD_MAPPING = {
  girl: {
    sexy: ["sexy", "hot", "gợi cảm"],
  },
};

// Ánh xạ kho link dự phòng đọc từ data-send/*.txt cho các pool không phải vdsex
const REMOTE_FALLBACK_DATA_FILES = Object.freeze({
  vdgirl: Object.freeze(["vdgirl.txt", "girl.txt", "zGirl.txt"]),
  vdsexy: Object.freeze(["vdsexy.txt", "girlsexy.txt"]),
  vdcos: Object.freeze(["vdcos.txt", "cosplay.txt"]),
  vdanime: Object.freeze(["vdanime.txt", "anime.txt"]),
  vdboy: Object.freeze(["vdboy.txt", "boy.txt", "boy6mui.txt"]),
  vdvuto: Object.freeze(["vdvuto.txt", "vuto.txt", "girlnguc.txt"]),
  vdchill: Object.freeze(["vdchill.txt", "chill.txt"]),
  vdsad: Object.freeze(["vdsad.txt", "sad.txt"]),
  vdtet: Object.freeze(["vdtet.txt", "tet.txt"]),
});

/**
 * Log có cấu trúc cho luồng video local: stage tách bạch
 * (local|prepare|video-upload|thumbnail-upload|delivery), kèm attempt/currentLimit
 * và mã lỗi khi có — chỉ ghi basename, không bao giờ log đường dẫn máy.
 */
export function logLocalVideoAction({
  pool = "",
  candidates = 0,
  action = "",
  file = "",
  status = null,
  message = "",
  stage = "local",
  attempt = null,
  limit = null,
  code = null,
}) {
  const parts = [
    "[vd-video]",
    `stage=${stage}`,
    "source_kind=local-directory",
    pool ? `pool=${pool}` : null,
    `candidates=${candidates}`,
    action ? `action=${action}` : null,
    status !== null && status !== undefined ? `status=${status}` : null,
    attempt !== null && attempt !== undefined ? `attempt=${attempt}` : null,
    limit !== null && limit !== undefined ? `limit=${limit}` : null,
    code ? `code=${code}` : null,
    file ? `file=${path.basename(String(file))}` : null,
    message ? `msg=${message}` : null,
  ].filter(Boolean);
  console.log(parts.join(" "));
}

/**
 * Root của pool video local: <project-root>/video/ (đặt cạnh run.bat/bot.js).
 * Cho phép override qua env MYBOT_VIDEO_ROOT (hữu ích cho test/VPS) nhưng luôn
 * tuyệt đối, không phụ thuộc terminal đang đứng ở đâu.
 */
export function resolveVideoPoolRoot(rootDir = process.env.MYBOT_VIDEO_ROOT || getProjectRoot()) {
  return path.join(path.resolve(String(rootDir)), LOCAL_VIDEO_POOL_ROOT);
}

/**
 * Chỉ cho phép tên pool hợp lệ ([a-z0-9_-]+): chặn path traversal và tên tùy ý.
 */
export function sanitizeLocalPoolDir(dirName) {
  if (typeof dirName !== "string") return null;
  const normalized = dirName.trim().toLowerCase();
  return /^[a-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function isMp4FileName(fileName) {
  return typeof fileName === "string" && /\.mp4$/i.test(fileName);
}

/**
 * Quét đệ quy các file .mp4 trong đúng folder pool đã ánh xạ.
 */
export function listLocalVideoCandidates(poolDir, { rootDir = undefined, fsImpl = fs } = {}) {
  const safeDir = sanitizeLocalPoolDir(poolDir);
  if (!safeDir || !fsImpl?.readdirSync) return [];

  const baseDir = path.join(resolveVideoPoolRoot(rootDir), safeDir);
  const candidates = new Set();

  const walk = (dir) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry?.name || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const isSymlink =
          typeof entry.isSymbolicLink === "function"
            ? entry.isSymbolicLink()
            : fsImpl.lstatSync(fullPath).isSymbolicLink();
        if (isSymlink) continue;
      } catch {
        continue;
      }
      if (entry.isDirectory?.()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile?.() || !isMp4FileName(entry.name)) continue;
      const normalized = path.normalize(fullPath);
      const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
      if (!candidates.has(key)) candidates.add(normalized);
    }
  };

  walk(baseDir);
  return Array.from(candidates).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Shuffle Fisher-Yates dùng randomFn injectable (không hoàn lại: caller pop dần).
 */
export function shuffleList(items, randomFn = Math.random) {
  const arr = Array.isArray(items) ? [...items] : [];
  for (let index = arr.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(randomFn() * (index + 1));
    [arr[index], arr[swapIndex]] = [arr[swapIndex], arr[index]];
  }
  return arr;
}

/**
 * Resolver pool video thống nhất cho cả command và scheduler.
 */
export function resolveVideoPoolConfig({ type, content } = {}) {
  const rawType = String(type || "").toLowerCase().trim();
  const normalizedType = rawType.startsWith("vd") && rawType.length > 2 ? rawType.slice(2) : rawType;
  const canonicalType = VIDEO_TYPES[normalizedType] ? normalizedType : (VIDEO_TYPES[rawType] ? rawType : null);
  if (!canonicalType) return null;
  const typeConfig = VIDEO_TYPES[canonicalType];

  let variant = "default";
  const typeKeywords = KEYWORD_MAPPING[canonicalType];

  if (typeKeywords && content) {
    const normalizedContent = String(content).toLowerCase();
    for (const [variantName, keywords] of Object.entries(typeKeywords)) {
      if (keywords.some((keyword) => normalizedContent.includes(keyword))) {
        variant = variantName;
        break;
      }
    }
  }

  const variantConfig = typeConfig.variants[variant] || typeConfig.variants.default;
  if (!variantConfig) return null;

  return {
    kind: variantConfig.kind,
    source: variantConfig.source,
    ttl: variantConfig.ttl,
    variant: variantConfig.type || variant,
  };
}

/**
 * Đọc candidate cho một config đã resolve.
 */
export function loadVideoPoolCandidates(config, options = {}) {
  if (!config) return [];
  if (config.kind === VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY) return listLocalVideoCandidates(config.source, options);
  return [];
}

const VIDEO_UPLOAD_URL_FIELDS = Object.freeze(["fileUrl", "hdUrl", "normalUrl"]);
const THUMBNAIL_UPLOAD_URL_FIELDS = Object.freeze(["fileUrl", "hdUrl", "normalUrl", "thumbUrl"]);

function extractUploadedUrl(uploadResult, fields) {
  const first = Array.isArray(uploadResult) ? uploadResult[0] : uploadResult;
  if (!first || typeof first !== "object") return "";
  for (const field of fields) {
    const value = first[field];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (/^https?:\/\//i.test(trimmed)) return trimmed;
    }
  }
  return "";
}

/**
 * Gửi một video local theo luồng 4 stage: prepare -> video-upload ->
 * thumbnail-upload -> delivery.
 */
export async function sendLocalVideoWithFallback({
  api,
  message,
  videoFiles,
  caption = "",
  mentions = [],
  ttl = 0,
  maxAttempts = 12,
  pool = "",
  propagateErrors = false,
  randomFn = Math.random,
  attemptBudget = null,
  prepareMedia = null,
  resultRef = null,
}) {
  if (!message || !api || typeof api.uploadAttachment !== "function" || typeof api.sendVideo !== "function") {
    return false;
  }

  const candidates = Array.from(
    new Set((Array.isArray(videoFiles) ? videoFiles : []).map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean)),
  );

  logLocalVideoAction({ pool, candidates: candidates.length, action: "scan" });

  if (candidates.length === 0) {
    logLocalVideoAction({ pool, action: "failure", message: "Local pool is missing or has no .mp4 files" });
    if (propagateErrors) {
      throw new VideoSourceEmptyError(`Local pool ${pool || "(anonymous)"} is empty or missing under ${LOCAL_VIDEO_POOL_ROOT}/`);
    }
    return false;
  }

  const requestedAttempts = Number.isFinite(maxAttempts) ? Math.floor(maxAttempts) : 12;
  const hardAttemptLimit = Math.max(0, Math.min(12, requestedAttempts));
  const sharedRemaining = Number.isFinite(attemptBudget?.remaining)
    ? Math.max(0, Math.floor(attemptBudget.remaining))
    : hardAttemptLimit;
  const effectiveAttemptLimit = Math.min(hardAttemptLimit, sharedRemaining);

  const prepare = typeof prepareMedia === "function" ? prepareMedia : activeLocalMediaPreparer;
  const remaining = shuffleList(candidates, randomFn);
  let attemptsCount = 0;
  let lastError = null;
  let stopReason = "";

  const recordResult = (ok) => {
    if (resultRef && typeof resultRef === "object") {
      resultRef.success = ok;
      resultRef.stopReason = stopReason;
      resultRef.lastError = lastError;
      resultRef.attemptsCount = attemptsCount;
      resultRef.candidatesCount = candidates.length;
      resultRef.effectiveAttemptLimit = effectiveAttemptLimit;
    }
    return ok;
  };

  while (remaining.length > 0 && attemptsCount < effectiveAttemptLimit && !stopReason) {
    const filePath = remaining.shift();
    attemptsCount += 1;
    if (attemptBudget && Number.isFinite(attemptBudget.remaining)) {
      attemptBudget.remaining = Math.max(0, attemptBudget.remaining - 1);
    }

    let prepared;
    try {
      prepared = await prepare(filePath);
    } catch (error) {
      if (
        error instanceof VideoToolMissingError ||
        error?.code === "VIDEO_TOOL_MISSING" ||
        isToolMissingError(error)
      ) {
        stopReason = "tool-missing";
        lastError = error instanceof VideoToolMissingError ? error : new VideoToolMissingError(error?.message || "Tool error");
        logLocalVideoAction({
          stage: "prepare",
          pool,
          action: "failure",
          code: error?.code || null,
          attempt: attemptsCount,
          limit: effectiveAttemptLimit,
          message: "ffmpeg/ffprobe unavailable - aborting this turn",
        });
        break;
      }
      lastError = error;
      logLocalVideoAction({
        stage: "prepare",
        pool,
        action: "skip",
        file: filePath,
        code: error?.code || null,
        attempt: attemptsCount,
        limit: effectiveAttemptLimit,
        message: error?.message || String(error),
      });
      continue;
    }

    try {
      let uploadedResult;
      try {
        uploadedResult = await api.uploadAttachment([filePath], message.threadId, message.type);
      } catch (error) {
        stopReason = "video-upload";
        lastError = error;
        logLocalVideoAction({
          stage: "video-upload",
          pool,
          action: "failure",
          file: filePath,
          code: error?.code ?? null,
          status: error?.status ?? null,
          retryable: error?.retryable ?? null,
          attempt: attemptsCount,
          limit: effectiveAttemptLimit,
          message: error?.message || String(error),
        });
        break;
      }

      const uploadedVideoUrl = extractUploadedUrl(uploadedResult, VIDEO_UPLOAD_URL_FIELDS);
      if (!uploadedVideoUrl) {
        stopReason = "video-upload-contract";
        lastError = new Error("Upload result has no usable video URL (fileUrl/hdUrl/normalUrl)");
        logLocalVideoAction({
          stage: "video-upload",
          pool,
          action: "failure",
          code: "UPLOAD_CONTRACT_INVALID",
          attempt: attemptsCount,
          limit: effectiveAttemptLimit,
          message: lastError.message,
        });
        break;
      }
      logLocalVideoAction({
        stage: "video-upload",
        pool,
        action: "done",
        status: 200,
        file: filePath,
        attempt: attemptsCount,
        limit: effectiveAttemptLimit,
      });

      let thumbnailUrl = "";
      try {
        thumbnailUrl = extractUploadedUrl(
          await api.uploadAttachment([prepared.thumbnailPath], message.threadId, message.type),
          THUMBNAIL_UPLOAD_URL_FIELDS,
        );
      } catch (error) {
        stopReason = "thumbnail-upload";
        lastError = error;
        logLocalVideoAction({
          stage: "thumbnail-upload",
          pool,
          action: "failure",
          code: error?.code ?? null,
          attempt: attemptsCount,
          limit: effectiveAttemptLimit,
          message: error?.message || String(error),
        });
        break;
      }
      if (!thumbnailUrl) {
        stopReason = "thumbnail-upload";
        lastError = new Error("Upload result has no usable thumbnail URL (fileUrl/hdUrl/normalUrl/thumbUrl)");
        logLocalVideoAction({
          stage: "thumbnail-upload",
          pool,
          action: "failure",
          code: "UPLOAD_CONTRACT_INVALID",
          attempt: attemptsCount,
          limit: effectiveAttemptLimit,
          message: lastError.message,
        });
        break;
      }

      try {
        await api.sendVideo({
          videoUrl: uploadedVideoUrl,
          threadId: message.threadId,
          threadType: message.type,
          message: {
            text: caption,
            type: message.type,
            ...(Array.isArray(mentions) && mentions.length > 0 ? { mentions } : {}),
          },
          ttl,
          videoAlreadyUploaded: true,
          thumbnail: thumbnailUrl,
          duration: prepared.metadata.duration,
          width: prepared.metadata.width,
          height: prepared.metadata.height,
          fileSize: prepared.metadata.fileSize,
        });
      } catch (error) {
        stopReason = "delivery";
        lastError = error;
        logLocalVideoAction({
          stage: "delivery",
          pool,
          action: "failure",
          file: filePath,
          code: error?.code ?? null,
          attempt: attemptsCount,
          limit: effectiveAttemptLimit,
          message: error?.message || String(error),
        });
        break;
      }

      logLocalVideoAction({
        stage: "delivery",
        pool,
        action: "success",
        status: 200,
        file: filePath,
        attempt: attemptsCount,
        limit: effectiveAttemptLimit,
      });
      return recordResult(true);
    } finally {
      try {
        await removeTemporaryFile(prepared.thumbnailPath);
      } catch {}
    }
  }

  logLocalVideoAction({
    pool,
    candidates: candidates.length,
    action: "failure",
    message: stopReason
      ? `Stopped early (${stopReason}) after ${attemptsCount}/${effectiveAttemptLimit} attempts`
      : `All local candidate attempts exhausted (${attemptsCount}/${effectiveAttemptLimit})`,
  });

  if (propagateErrors) {
    if (stopReason && lastError) throw lastError;
    throw new VideoSourceEmptyError(
      `Local pool ${pool || "(anonymous)"} exhausted without a delivery attempt (attempts=${attemptsCount}/${effectiveAttemptLimit})`,
    );
  }
  return recordResult(false);
}

async function dispatchResolvedVideoPool({
  api,
  message,
  config,
  caption = "",
  mentions = [],
  ttl,
  propagateErrors = false,
  randomFn = Math.random,
  attemptBudget = null,
  maxAttempts = 12,
  candidates = null,
  resultRef = null,
}) {
  if (!config || !message) return false;

  const poolCandidates = candidates === null ? loadVideoPoolCandidates(config) : candidates;

  if (config.kind === VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY) {
    return await sendLocalVideoWithFallback({
      api,
      message,
      videoFiles: poolCandidates,
      caption,
      mentions,
      ttl,
      maxAttempts,
      pool: config.source,
      propagateErrors,
      randomFn,
      attemptBudget,
      resultRef,
    });
  }

  if (propagateErrors) {
    throw new VideoSourceEmptyError(`Unsupported video source kind: ${config.kind}`);
  }
  return false;
}

function isRemoteVideoFallbackAllowed(poolName) {
  if (!poolName || poolName === "vdsex") return false;
  if (process.env.MYBOT_DISABLE_REMOTE_VIDEO_FALLBACK === "1") return false;
  if (process.env.NODE_TEST_CONTEXT && process.env.MYBOT_ENABLE_REMOTE_VIDEO_FALLBACK !== "1") {
    return false;
  }
  return Boolean(REMOTE_FALLBACK_DATA_FILES[poolName]);
}

function loadRemoteMp4FallbackUrls(poolName) {
  const fileNames = REMOTE_FALLBACK_DATA_FILES[poolName];
  if (!Array.isArray(fileNames) || fileNames.length === 0) return [];

  const dataSendDir = path.join(
    getProjectRoot(),
    "src",
    "service-debug",
    "chat-zalo",
    "chat-special",
    "data-send",
  );

  const urls = new Set();
  for (const fileName of fileNames) {
    const filePath = path.join(dataSendDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf8");
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        if (/^https:\/\/\S+\.mp4(?:[?#]\S*)?$/i.test(line)) {
          urls.add(line);
        }
      }
    } catch {}
    if (urls.size > 0) break;
  }

  return Array.from(urls);
}

async function tryDeliverRemoteFallbackVideo({ api, message, config, caption, mentions }) {
  const remoteUrls = loadRemoteMp4FallbackUrls(config.source);
  if (remoteUrls.length === 0) return false;

  const shuffled = shuffleList(remoteUrls).slice(0, 3);
  for (const remoteUrl of shuffled) {
    let tempVideoPath = null;
    try {
      tempVideoPath = await downloadVideoToTempFile(remoteUrl);
      const ok = await sendLocalVideoWithFallback({
        api,
        message,
        videoFiles: [tempVideoPath],
        caption,
        mentions,
        ttl: config.ttl,
        maxAttempts: 1,
        pool: config.source,
      });
      if (ok) return true;
    } catch {
      // Thử URL kế tiếp trong danh sách dự phòng
    } finally {
      if (tempVideoPath) {
        await removeTemporaryFile(tempVideoPath).catch(() => {});
      }
    }
  }

  return false;
}

/**
 * Handler chính cho toàn bộ command vd*
 */
export const handleVideoCommand = async (api, message, type) => {
  const { dName: senderName = "", uidFrom: senderId = "" } = message?.data || {};
  const content = removeMention(message);

  const config = resolveVideoPoolConfig({ type, content });
  if (!config) return;

  const threadType = message.type ?? 1;
  const caption = `[ ${senderName} ] ${config.variant !== "default" ? `( ${config.variant} )` : ""}`;
  const mentions =
    senderId && threadType === 1 ? [MessageMention(senderId, senderName.length, 2, false)] : [];

  // Quét pool local trước tiên cho mọi lệnh vd*
  const candidates = loadVideoPoolCandidates(config);
  const resultRef = { stopReason: "", lastError: null };
  let success = await dispatchResolvedVideoPool({
    api,
    message,
    config,
    caption,
    mentions,
    ttl: config.ttl,
    candidates,
    resultRef,
  });

  // Fallback sang danh sách URL .mp4 hợp lệ trong data-send/*.txt cho các mục ngoài vdsex
  if (
    !success &&
    candidates.length === 0 &&
    config.kind === VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY &&
    isRemoteVideoFallbackAllowed(config.source)
  ) {
    success = await tryDeliverRemoteFallbackVideo({
      api,
      message,
      config,
      caption,
      mentions,
    });
  }

  if (!success) {
    let errorMsg = "Đã xảy ra lỗi khi xử lý lệnh video. Vui lòng thử lại sau.";
    const isEmptyLocalSource =
      config.kind === VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY && candidates.length === 0;

    if (isEmptyLocalSource) {
      errorMsg = `Nguồn video "${LOCAL_VIDEO_POOL_ROOT}/${config.source}" đang thiếu hoặc trống. Vui lòng bổ sung file .mp4 rồi thử lại sau.`;
    } else if (resultRef.stopReason === "tool-missing" || resultRef.lastError instanceof VideoToolMissingError) {
      errorMsg = "Lỗi công cụ media (FFmpeg/FFprobe không khả dụng hoặc bị lỗi). Vui lòng kiểm tra môi trường hệ thống.";
    } else if (resultRef.stopReason === "video-upload" || resultRef.stopReason === "video-upload-contract") {
      errorMsg = `Lỗi khi tải video lên máy chủ Zalo (${resultRef.lastError?.message || "upload thất bại"}). Vui lòng thử lại sau.`;
    } else if (resultRef.stopReason === "delivery") {
      errorMsg = `Lỗi máy chủ Zalo từ chối gửi video (${resultRef.lastError?.message || "gửi thất bại"}). Vui lòng thử lại sau.`;
    } else if (resultRef.lastError instanceof VideoFileUnreadableError) {
      errorMsg = `File video trong nguồn "${LOCAL_VIDEO_POOL_ROOT}/${config.source}" không thể đọc được hoặc bị hỏng. Vui lòng kiểm tra lại file media.`;
    }

    await api.sendMessage(
      {
        msg: errorMsg,
        quote: message,
      },
      message.threadId,
      threadType,
    );
  }
};

/**
 * Helper gửi video ngẫu nhiên cho scheduler.
 */
export async function sendRandomGirlVideo(
  api,
  message,
  caption = "",
  type = "default",
  ttl = 0,
  { candidates = null, ...fallbackOptions } = {},
) {
  const config = resolveVideoPoolConfig({ type: type === "default" ? "girl" : type });
  if (!config) return false;

  return await dispatchResolvedVideoPool({
    api,
    message,
    config,
    caption,
    ttl,
    candidates,
    ...fallbackOptions,
  });
}
