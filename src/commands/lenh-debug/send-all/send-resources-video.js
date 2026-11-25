import fs from "node:fs";
import path from "node:path";
import {
  sendMessageCompleteRequest,
  sendMessageFailed,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { getProjectRoot } from "../../../utils/env.js";
import { removeTemporaryFile } from "../../../api-zalo/media/video-temp-file.js";
import { prepareLocalVideoMedia } from "../../../service-debug/chat-zalo/chat-special/send-video/video-media-prepare.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../shared/command-input-utils.js";

const dataVideoPath = path.join(getProjectRoot(), "assets", "resources", "video");
const PLATFORM = "ZaloVideo";

function listRegularVideoFiles() {
  if (!fs.existsSync(dataVideoPath)) {
    fs.mkdirSync(dataVideoPath, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(dataVideoPath, { withFileTypes: true })
    .filter((entry) => {
      if (!entry || entry.name.startsWith(".")) return false;
      if (entry.isFile()) return true;
      if (entry.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(dataVideoPath, entry.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi"));
}

function selectVideoFile(files, keyword) {
  const trimmed = String(keyword || "").trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    if (index >= 0 && index < files.length) {
      return files[index];
    }
  }

  const lower = trimmed.toLowerCase();
  return (
    files.find((file) => file.toLowerCase() === lower) ||
    files.find((file) => path.parse(file).name.toLowerCase() === lower) ||
    null
  );
}

export async function handleSendVideo(api, message, aliasCommand = "sendresourcesvideo") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "sendresourcesvideo";
  const keyword = extractCommandBody(message, prefix, cmdName);
  const files = listRegularVideoFiles();

  if (!keyword) {
    if (files.length === 0) {
      await sendMessageCompleteRequest(
        api,
        message,
        {
          caption:
            `🎬 Kho video lưu trữ hiện đang trống.\n` +
            `👉 Thêm video mới bằng lệnh: ${prefix}dlrsrc video|<tên_video> (reply video hoặc kèm link).`,
        },
        60000,
      );
      return;
    }

    const fileList = files.map((file, index) => `${index + 1}. ${path.parse(file).name}`).join("\n");
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption:
          `🎬 Danh sách video đã lưu trữ (${files.length}):\n${fileList}\n\n` +
          `👉 Dùng lệnh: ${prefix}${cmdName} <STT hoặc tên video> để gửi video.`,
      },
      60000,
    );
    return;
  }

  if (files.length === 0) {
    await sendMessageFailed(
      api,
      message,
      `Kho video đang trống! Hãy nạp video bằng lệnh ${prefix}dlrsrc video|<tên_video>.`,
      false,
    );
    return;
  }

  const videoFile = selectVideoFile(files, keyword);
  if (!videoFile) {
    await sendMessageFailed(
      api,
      message,
      `Không tìm thấy video với số thứ tự hoặc tên "${keyword}"! Gõ ${prefix}${cmdName} để xem danh sách.`,
      false,
    );
    return;
  }

  const parsed = path.parse(videoFile);
  const fileExt = parsed.ext;
  const videoPath = path.join(dataVideoPath, videoFile);
  const nameLocalVideo = parsed.name;
  const threadType = safeThreadType(message);
  let preparedThumbPath = null;

  try {
    const cachedVideo = await getCachedMedia(PLATFORM, videoFile, fileExt, nameLocalVideo);
    let videoUrl = cachedVideo?.fileUrl || "";
    let thumbnailUrl = cachedVideo?.thumbnailUrl || "";
    let metadata = {
      duration: cachedVideo?.duration || 0,
      width: cachedVideo?.width || 1280,
      height: cachedVideo?.height || 720,
      fileSize: cachedVideo?.fileSize || 0,
    };

    const prepared = await prepareLocalVideoMedia(videoPath).catch(() => null);
    if (prepared) {
      preparedThumbPath = prepared.thumbnailPath;
      metadata = prepared.metadata;
    }

    if (!videoUrl) {
      const linkUploadZalo = await api.uploadAttachment([videoPath], message.threadId, threadType);
      videoUrl =
        linkUploadZalo?.[0]?.fileUrl ||
        linkUploadZalo?.[0]?.hdUrl ||
        linkUploadZalo?.[0]?.normalUrl ||
        "";
      if (!videoUrl) {
        throw new Error("Tải video lên Zalo thất bại.");
      }
    }

    if (!thumbnailUrl && prepared?.thumbnailPath) {
      const thumbUpload = await api.uploadAttachment(
        [prepared.thumbnailPath],
        message.threadId,
        threadType,
      );
      thumbnailUrl =
        thumbUpload?.[0]?.fileUrl ||
        thumbUpload?.[0]?.hdUrl ||
        thumbUpload?.[0]?.normalUrl ||
        thumbUpload?.[0]?.thumbUrl ||
        "";
    }

    setCacheData(
      PLATFORM,
      videoFile,
      {
        fileUrl: videoUrl,
        thumbnailUrl,
        title: nameLocalVideo,
        ...metadata,
      },
      fileExt,
    );

    await api.sendVideo({
      videoUrl,
      threadId: message.threadId,
      threadType,
      message: {
        text: `🎬 Video: ${nameLocalVideo}`,
        type: threadType,
      },
      videoAlreadyUploaded: true,
      ...(thumbnailUrl ? { thumbnail: thumbnailUrl } : {}),
      localThumbnailSource: videoPath,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      fileSize: metadata.fileSize,
      ttl: 3600000,
    });
  } catch (error) {
    console.error("[sendresourcesvideo] Lỗi khi gửi video:", error);
    await sendMessageFailed(api, message, "Có lỗi xảy ra khi gửi video!", false);
  } finally {
    if (preparedThumbPath) {
      await removeTemporaryFile(preparedThumbPath).catch(() => {});
    }
  }
}
