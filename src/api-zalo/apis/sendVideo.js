import fs from "fs";
import path from "path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { appContext } from "../context.js";
import { ZaloApiError } from "../Errors/ZaloApiError.js";
import { encodeAES, getVideoMetadata, handleZaloResponse, makeURL, request } from "../utils.js";
import { getFfmpegExecutableSync } from "../../utils/runtime-dependencies.js";
import { Zalo } from "../zalo.js";
import { MessageType } from "../models/Message.js";
import { tempDir } from "../../utils/io-json.js";
import { API_TYPE, API_VERSION } from "../constants.js";
import { downloadVideoToTempFile, removeTemporaryFile } from "../media/video-temp-file.js";

const DEFAULT_VIDEO_METADATA = Object.freeze({
  duration: 0,
  width: 1280,
  height: 720,
  fileSize: 0,
});
const execFileAsync = promisify(execFile);

function normalizeVideoPath(videoUrl) {
  if (typeof videoUrl !== "string" || !videoUrl.startsWith("file:")) return videoUrl;

  try {
    return fileURLToPath(videoUrl);
  } catch {
    return videoUrl;
  }
}

export async function getVideoMetadataOrFallback(videoUrl, metadataReader = getVideoMetadata) {
  try {
    const metadata = await metadataReader(normalizeVideoPath(videoUrl));
    return {
      duration: metadata?.duration || 0,
      width: metadata?.width || DEFAULT_VIDEO_METADATA.width,
      height: metadata?.height || DEFAULT_VIDEO_METADATA.height,
      fileSize: metadata?.fileSize ?? metadata?.totalSize ?? 0,
    };
  } catch (error) {
    const launchFailure = ["EPERM", "EACCES", "ENOENT"].includes(error?.code)
      || /spawn (?:EPERM|EACCES|ENOENT)/i.test(error?.message || "");
    if (!launchFailure) throw error;
    return { ...DEFAULT_VIDEO_METADATA };
  }
}

export function getFallbackThumbnailUrl(videoUrl) {
  try {
    const parsedUrl = new URL(videoUrl);
    if (!/\.[^/.]+$/.test(parsedUrl.pathname)) return null;
    parsedUrl.pathname = parsedUrl.pathname.replace(/\.[^/.]+$/, ".jpg");
    return parsedUrl.toString();
  } catch {
    return null;
  }
}

/**
 * Chuẩn hóa videoUrl bắt buộc: rỗng/không phải chuỗi là lỗi, không gửi request.
 */
export function requireValidVideoUrl(videoUrl) {
  const normalized = typeof videoUrl === "string" ? videoUrl.trim() : "";
  if (!normalized) throw new ZaloApiError("Missing or invalid video URL");
  return normalized;
}

/**
 * Chuẩn hóa thumbUrl trước khi build payload:
 * - rỗng / "null" / "undefined" là nguyên nhân Zalo trả "Tham số không hợp lệ".
 * - Luồng video đã upload (vd* local) hoặc caller yêu cầu thumbnail tường minh
 *   bắt buộc phải có thumbnail hợp lệ -> throw thay vì gửi request hỏng.
 * - Luồng URL online giữ nguyên hành vi cũ (thumbUrl "" khi fallback không ra URL).
 */
export function resolveThumbnailParam(thumbnailUrl, { videoAlreadyUploaded = false, thumbnailRequested = false } = {}) {
  const normalized = typeof thumbnailUrl === "string" ? thumbnailUrl.trim() : "";
  if (!normalized || /^(null|undefined)$/i.test(normalized)) {
    if (videoAlreadyUploaded || thumbnailRequested) {
      throw new ZaloApiError("Missing or invalid video thumbnail");
    }
    return "";
  }
  return normalized;
}

export function validateVideoMentions(type, msg, mentions) {
  const caption = typeof msg === "string" ? msg : "";
  let totalMentionLen = 0;
  const mentionsFinal =
    Array.isArray(mentions) && type == MessageType.GroupMessage
      ? mentions
        .filter((m) => m.pos >= 0 && m.uid && m.len > 0)
        .map((m) => {
          totalMentionLen += m.len;
          return { pos: m.pos, uid: m.uid, len: m.len, type: m.uid == "-1" ? 1 : 0 };
        })
      : [];
  if (totalMentionLen > caption.length) {
    throw new ZaloApiError("Invalid mentions: total mention characters exceed message length");
  }
  return { mentionsFinal, msgFinal: caption };
}

export function sendVideoFactory(api) {
  if (!api?.zpwServiceMap?.file?.[0]) throw new ZaloApiError("Missing file endpoint (zpwServiceMap.file[0])");
  const directMessageServiceURL = makeURL(`${api.zpwServiceMap.file[0]}/api/message/forward`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
    nretry: 0,
  });
  const groupMessageServiceURL = makeURL(`${api.zpwServiceMap.file[0]}/api/group/forward`, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
    nretry: 0,
  });
  return async function sendVideo({
    videoUrl,
    threadId,
    threadType,
    message = null,
    thumbnail = null,
    ttl = 0,
    duration = 0,
    width = 0,
    height = 0,
    fileSize = 0,
    videoAlreadyUploaded = false,
    localThumbnailSource = null,
  }) {
    if (!appContext.secretKey || !appContext.imei || !appContext.cookie || !appContext.userAgent)
      throw new ZaloApiError("Missing required app context fields");
    const resolvedThreadType = threadType ?? message?.type ?? MessageType.DirectMessage;
    let thumbnailUrl = null;
    const videoPath = normalizeVideoPath(videoUrl);
    const cleanupPaths = [];
    let localVideoPath = videoPath;
    try {
      const isRemoteVideo = /^https?:\/\//i.test(videoUrl);
      const isLocalFile = !isRemoteVideo || localVideoPath !== videoUrl;

      const hasLocalSource = Boolean(localThumbnailSource && fs.existsSync(localThumbnailSource));
      if (isRemoteVideo && !videoAlreadyUploaded) {
        if (hasLocalSource) {
          localVideoPath = localThumbnailSource;
        } else {
          localVideoPath = await downloadVideoToTempFile(videoUrl);
          cleanupPaths.push(localVideoPath);
        }
      }

      if (videoAlreadyUploaded) {
        // Metadata thật do caller đọc từ file gốc (ffprobe); không còn ép
        // mặc định 1280x720/size 0 khiến Zalo trả "Tham số không hợp lệ".
        duration = Number(duration) || 0;
        width = Number(width) > 0 ? Number(width) : 1280;
        height = Number(height) > 0 ? Number(height) : 720;
        fileSize = Number(fileSize) > 0 ? Number(fileSize) : 0;
      } else if (isRemoteVideo || isLocalFile) {
        const metadata = await getVideoMetadataOrFallback(localVideoPath);
        duration = metadata.duration || duration || 0;
        width = metadata.width || 1280;
        height = metadata.height || 720;
        fileSize = metadata.fileSize || 0;
      }

      if (thumbnail) {
        thumbnailUrl = thumbnail;
      } else if (message) {
        const tempThumbnail = path.join(tempDir, `thumbnail_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`);
        cleanupPaths.push(tempThumbnail);
        // Khi video đã upload (videoAlreadyUploaded) thì localVideoPath là URL CDN:
        // ffmpeg đọc URL đó thường thất bại và fallback ".jpg" không tồn tại với
        // fileUrl kiểu zfcloud (không có đuôi file) -> thumbUrl "null" khiến Zalo
        // báo "Tham số không hợp lệ". Ưu tiên extract từ file local gốc nếu có.
        const thumbnailSource = localThumbnailSource || localVideoPath;
        const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
        try {
          await execFileAsync(ffmpegBin, ["-i", thumbnailSource, "-ss", "00:00:01", "-vframes", "1", "-y", tempThumbnail], {
            timeout: 15000,
            windowsHide: true,
          });
          if (!fs.existsSync(tempThumbnail) || fs.statSync(tempThumbnail).size === 0) {
            await execFileAsync(ffmpegBin, ["-i", thumbnailSource, "-vframes", "1", "-y", tempThumbnail], {
              timeout: 15000,
              windowsHide: true,
            });
          }
          const linkThumbnail = await api.uploadAttachment([tempThumbnail], threadId, resolvedThreadType);
          thumbnailUrl = linkThumbnail
            ? linkThumbnail[0]?.hdUrl || linkThumbnail[0]?.normalUrl || linkThumbnail[0]?.fileUrl
            : null;
        } catch {
          thumbnailUrl = getFallbackThumbnailUrl(videoUrl);
        }
      } else {
        thumbnailUrl = getFallbackThumbnailUrl(videoUrl);
      }

      // Không bao giờ gửi request khi tham số bắt buộc chưa hợp lệ
      videoUrl = requireValidVideoUrl(videoUrl);
      thumbnailUrl = resolveThumbnailParam(thumbnailUrl, {
        videoAlreadyUploaded,
        thumbnailRequested: Boolean(thumbnail),
      });

      const payload = {
        params: {
          clientId: String(Date.now()) * 600,
          ttl,
          zsource: 704,
          msgType: 5,
          msgInfo: JSON.stringify({
            videoUrl: String(videoUrl),
            // thumbUrl "null" (string) bị Zalo từ chối "Tham số không hợp lệ"
            thumbUrl: String(thumbnailUrl || ""),
            duration: Number(duration),
            width: Number(width),
            height: Number(height),
            fileSize: Number(fileSize),
            properties: {
              color: -1,
              size: -1,
              type: 1003,
              subType: 0,
              ext: {
                sSrcType: -1,
                sSrcStr: "",
                msg_warning_type: 0,
              },
            },
            title: message ? message.text : "",
          }),
        },
      };

      if (message && message.mentions) {
        const { mentionsFinal } = validateVideoMentions(resolvedThreadType, message.text || "", message.mentions);
        payload.params.mentionInfo = mentionsFinal;
      }

      let url;
      if (resolvedThreadType === MessageType.DirectMessage) {
        url = directMessageServiceURL;
        payload.params.toId = String(threadId);
        payload.params.imei = appContext.imei;
      } else if (resolvedThreadType === MessageType.GroupMessage) {
        url = groupMessageServiceURL;
        payload.params.visibility = 0;
        payload.params.grid = String(threadId);
        payload.params.imei = appContext.imei;
      } else {
        throw new ZaloApiError("Thread type is invalid");
      }

      const encryptedParams = encodeAES(appContext.secretKey, JSON.stringify(payload.params));
      if (!encryptedParams) throw new ZaloApiError("Failed to encrypt message");

      const response = await request(url, {
        method: "POST",
        body: new URLSearchParams({
          params: encryptedParams,
        }),
      });

      const result = await handleZaloResponse(response);
      if (result.error) throw new ZaloApiError(result.error.message, result.error.code);
      return result.data;
    } finally {
      const cleanupErrors = [];
      for (const filePath of cleanupPaths.reverse()) {
        try {
          await removeTemporaryFile(filePath);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Failed to cleanup temporary video artifacts");
      }
    }
  };
}
