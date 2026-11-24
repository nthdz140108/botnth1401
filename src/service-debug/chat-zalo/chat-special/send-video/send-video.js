import fs from "fs";
import path from "path";
import { MessageMention } from "../../../../api-zalo/models/Message.js";
import { removeMention } from "../../../../utils/format-util.js";
import { getProjectRoot } from "../../../../utils/env.js";
import { removeTemporaryFile } from "../../../../api-zalo/media/video-temp-file.js";
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
// .mp4 trong <project-root>/video/<source> mỗi lượt gửi. Không còn nguồn URL
// online, không còn fallback, không còn health store.
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
 * - Chỉ nhận file thường có đuôi .mp4 (không phân biệt hoa/thường).
 * - Bỏ qua symlink, node_modules, thư mục ẩn và mọi file phụ (.part, audio, crawler...).
 * - Kết quả chuẩn hóa, dedupe và sort để test ổn định; shuffle diễn ra sau.
 * Mỗi lệnh/lượt SendTask quét lại nên thêm/xóa video không cần restart bot.
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
      // Dedupe case-insensitive trên Windows (FS không phân biệt hoa/thường)
      // nhưng giữ nguyên chữ của đường dẫn chuẩn hóa khi trả kết quả.
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
 * Resolver pool video thống nhất cho cả command và scheduler: mọi lệnh vd*
 * và SendTask video đều đi qua đây và chỉ trả về LOCAL_DIRECTORY.
 * So khớp chính xác theo VIDEO_TYPES, không dùng substring hay fallback
 * chéo giữa các loại (sex chỉ ra folder vdsex local, sexy chỉ ra vdsexy).
 * @param {object} params
 * @param {string} params.type Loại video canonical (vd: sex, sexy, girl, ...)
 * @param {string} [params.content] Nội dung lệnh dùng chọn variant theo keyword
 * @returns {{ kind: string, source: string, ttl: number, variant: string } | null}
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
 * Đọc candidate cho một config đã resolve: local-directory quét .mp4 trong
 * video/<source> mỗi lượt gọi. Không còn nhánh URL.
 */
export function loadVideoPoolCandidates(config, options = {}) {
  if (!config) return [];
  if (config.kind === VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY) return listLocalVideoCandidates(config.source, options);
  return [];
}

// Các trường URL hợp lệ Zalo trả về sau upload; thumbnail có thêm thumbUrl
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
 *
 * Chính sách fallback:
 * - prepare: thiếu ffmpeg/ffprobe dừng NGAY cả lượt (không quét nốt pool);
 *   chính file MP4 không đọc được (stat/ffprobe/frame rỗng) mới bỏ qua sang file khác.
 * - video-upload: request lỗi TRƯỚC khi hoàn tất -> thử candidate khác;
 *   kết quả sai contract (không có fileUrl/hdUrl/normalUrl) -> dừng ngay.
 * - thumbnail-upload: lỗi hoặc sai contract -> dừng ngay.
 * - delivery: Zalo từ chối gửi (vd code 114 / "Tham số không hợp lệ") -> dừng
 *   ngay tuyệt đối, không upload thêm video nào.
 *
 * Trần thử vẫn là min(12, số file, budget), shuffle không hoàn lại. Thumbnail tạm
 * luôn được dọn trong finally.
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

    // ---- stage=prepare: metadata thật + frame đầu JPEG từ file gốc
    let prepared;
    try {
      prepared = await prepare(filePath);
    } catch (error) {
      if (
        error instanceof VideoToolMissingError ||
        error?.code === "VIDEO_TOOL_MISSING" ||
        isToolMissingError(error)
      ) {
        // Môi trường thiếu tool là lỗi chung, không phải của một file: dừng cả lượt
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
      // File MP4 không đọc được -> chỉ bỏ qua đúng file này
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
      // ---- stage=video-upload
      let uploadedResult;
      try {
        uploadedResult = await api.uploadAttachment([filePath], message.threadId, message.type);
      } catch (error) {
        // Upload errors are COMMON to the whole send when they come from the
        // transport, endpoint or Zalo itself (timeout/network, HTTP 4xx/5xx,
        // auth/cookie, param or app-code rejections): the remaining candidates
        // share the same endpoint, so scanning the pool would only repeat the
        // failure ~11 more times. Only a per-file prepare/read failure (handled
        // in the prepare stage above) advances to the next candidate.
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
        // Kết quả trả về sai contract: trạng thái Zalo mơ hồ -> dừng ngay
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

      // ---- stage=thumbnail-upload
      let thumbnailUrl = "";
      try {
        thumbnailUrl = extractUploadedUrl(
          await api.uploadAttachment([prepared.thumbnailPath], message.threadId, message.type),
          THUMBNAIL_UPLOAD_URL_FIELDS,
        );
      } catch (error) {
        // Upload thumbnail lỗi: payload sẽ thiếu thumbUrl hợp lệ -> dừng ngay
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

      // ---- stage=delivery
      try {
        await api.sendVideo({
          videoUrl: uploadedVideoUrl,
          threadId: message.threadId,
          threadType: message.type,
          message: {
            text: caption,
            // Để validateVideoMentions phân biệt group/direct
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
        // Zalo từ chối bước gửi: KHÔNG thử thêm file nào nữa (tránh upload trùng)
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
      // Luôn dọn thumbnail tạm của candidate này, kể cả khi dừng giữa chừng
      try {
        await removeTemporaryFile(prepared.thumbnailPath);
      } catch {
        // Lỗi dọn dẹp không được che lỗi chính
      }
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
    // Dừng theo chính sách (tool/contract/delivery): giữ nguyên lỗi gốc để
    // scheduler xếp loại delivery-error, không fallback nguồn sau kết quả mơ hồ.
    if (stopReason && lastError) throw lastError;
    // Cạn candidate mà chưa từng chạm delivery (rỗng/hỏng hết/budget hết):
    // nguồn không dùng được trước khi gửi gì cả -> scheduler được fallback.
    throw new VideoSourceEmptyError(
      `Local pool ${pool || "(anonymous)"} exhausted without a delivery attempt (attempts=${attemptsCount}/${effectiveAttemptLimit})`,
    );
  }
  return recordResult(false);
}

/**
 * Dispatcher chung cho nguồn đã resolve — mọi bề mặt (direct command, alias,
 * scheduler SendTask) đi qua đây, không vá riêng từng handler.
 * Chỉ hỗ trợ nhánh LOCAL_DIRECTORY; cấu hình không hợp lệ trả false.
 */
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

/**
 * Handler chính cho toàn bộ command vd*
 */
export const handleVideoCommand = async (api, message, type) => {
  const { dName: senderName = "", uidFrom: senderId = "" } = message?.data || {};
  const content = removeMention(message);

  const config = resolveVideoPoolConfig({ type, content });
  if (!config) return;

  const caption = `[ ${senderName} ] ${config.variant !== "default" ? `( ${config.variant} )` : ""}`;
  const mentions = senderId ? [MessageMention(senderId, senderName.length, 2, false)] : [];

  // Quét pool đúng một lần cho lượt lệnh này; thêm/xóa video có hiệu lực ở lượt kế tiếp.
  const candidates = loadVideoPoolCandidates(config);
  const resultRef = { stopReason: "", lastError: null };
  const success = await dispatchResolvedVideoPool({
    api,
    message,
    config,
    caption,
    mentions,
    ttl: config.ttl,
    candidates,
    resultRef,
  });

  if (!success) {
    let errorMsg = "Đã xảy ra lỗi khi xử lý lệnh video. Vui lòng thử lại sau.";
    const isEmptyLocalSource =
      config.kind === VIDEO_SOURCE_KINDS.LOCAL_DIRECTORY && candidates.length === 0;

    if (isEmptyLocalSource) {
      errorMsg = `Nguồn video "${LOCAL_VIDEO_POOL_ROOT}/${config.source}" đang thiếu hoặc trống. Vui lòng bổ sung file .mp4 rồi thử lại sau.`;
    } else if (resultRef.stopReason === "tool-missing" || resultRef.lastError instanceof VideoToolMissingError) {
      errorMsg = `Lỗi công cụ media (FFmpeg/FFprobe không khả dụng hoặc bị lỗi). Vui lòng kiểm tra môi trường hệ thống.`;
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
      message.type,
    );
  }
};

/**
 * Helper gửi video ngẫu nhiên cho scheduler.
 * Dùng chung resolveVideoPoolConfig với command để đảm bảo cùng một mapping pool.
 * `candidates` cho phép scheduler truyền snapshot đã tải một lần mỗi lượt
 * broadcast; mỗi nhóm vẫn shuffle/random độc lập bên trong.
 */
export async function sendRandomGirlVideo(
  api,
  message,
  caption = "",
  type = "default",
  ttl = 0,
  { candidates = null, ...fallbackOptions } = {}
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
