import { uploadPreparedVideo, videoPayload, isCompleteVideoCache } from "../download/video-delivery.js";
import { createDownloadJob, logDownloadEvent } from "../download/download-job.js";
import fs from "fs";
import path from "path";
import schedule from "node-schedule";
import { Worker } from "worker_threads";

import { MessageMention } from "../../../api-zalo/index.js";
import { deleteFile } from "../../../utils/util.js";
import { removeMention } from "../../../utils/format-util.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { getDurationVideo } from "../api-hoangdev/aio-downlink.js";
import { tempDir } from "../../../utils/io-json.js";
import { createSearchResultImage } from "../spotify/search-canvas.js";
import { isAdmin } from "../../../index.js";
import { uploadAudioFile } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { canContinueReply } from "../../reply-access.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  getSelectionsMapData,
  setSelectionsMapData,
} from "../index.js";
import {
  YOUTUBE_AUDIO_FORMAT,
  YOUTUBE_FORMAT_360,
  YOUTUBE_FORMAT_720,
  YOUTUBE_FORMAT_1080,
  YOUTUBE_FORMAT_MAX,
  buildYoutubePayloadBase,
  buildYoutubeProcessingCaption,
  buildYoutubeVideoCaption,
  createYoutubeJobDir,
  cleanupYoutubeFiles,
  classifyYoutubeError,
  ensureNonEmptyFile,
  ensureUploadResult,
  normalizeYoutubeWorkflowError,
  runYoutubeDownload,
  runYoutubeVideoInfo,
  runYoutubeSearch,
} from "./youtube-core.js";
import { resolveYtDlpCommand } from "./youtube-runtime.js";
import { getYoutubeAuthOptions } from "./youtube-auth.js";
import {
  createDownloadProgress,
  extractMessageId,
} from "../../../utils/interaction-countdown.js";

const CONFIG = {
  maxResults: 10,
  timeWaitSelection: 60000,
};

const PLATFORM = "youtube";

export const audioFormat = YOUTUBE_AUDIO_FORMAT;

export const extractYoutubeId = (url) => {
  try {
    let uniqueId = null;
    if (url.includes("?v=")) uniqueId = url.split("?v=")[1];
    else if (url.includes("&v=")) uniqueId = url.split("&v=")[1];
    if (!uniqueId) {
      const match = url.match(/youtu\.be\/([^?&#/]+)/);
      uniqueId = match ? match[1] : null;
    }
    if (!uniqueId && url.includes("/shorts/")) {
      uniqueId = url.split("/shorts/")[1]?.split(/[?&#/]/)[0] || null;
    }
    if (!uniqueId && url.includes("/live/")) {
      uniqueId = url.split("/live/")[1]?.split(/[?&#/]/)[0] || null;
    }
    if (!uniqueId && url.includes("/embed/")) {
      uniqueId = url.split("/embed/")[1]?.split(/[?&#/]/)[0] || null;
    }
    return uniqueId?.split(/[&?#]/)[0] || url;
  } catch {
    return url;
  }
};

export const normalizeYoutubeUrl = (url) => {
  if (!url) return null;
  const text = String(url).trim();
  if (!/^https?:\/\//i.test(text)) return null;
  if (!/youtube\.com|youtu\.be/i.test(text)) return null;
  const videoId = extractYoutubeId(text);
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
};

export const isYoutubeUrl = (url) => Boolean(normalizeYoutubeUrl(url));

export const getVideoFormat = (qualityParam) => {
  switch (String(qualityParam || "").toLowerCase()) {
    case "audio":
      return { format: audioFormat, qualityText: "audio", timeNotify: 8000 };
    case "low":
      return { format: YOUTUBE_FORMAT_360, qualityText: "360p", timeNotify: 8000 };
    case "high":
      return { format: YOUTUBE_FORMAT_1080, qualityText: "1080p", timeNotify: 16000 };
    case "max":
      return { format: YOUTUBE_FORMAT_MAX, qualityText: "Cao nhất", timeNotify: 24000 };
    default:
      return { format: YOUTUBE_FORMAT_720, qualityText: "720p", timeNotify: 10000 };
  }
};

export const getVideoFormatByQuality = (qualityParam) => {
  switch (String(qualityParam || "").toLowerCase()) {
    case "360p":
      return getVideoFormat("low");
    case "1080p":
      return getVideoFormat("high");
    case "max":
      return getVideoFormat("max");
    case "audio":
      return getVideoFormat("audio");
    default:
      return getVideoFormat("default");
  }
};

export const getYoutubeVideoInfo = async (videoUrl) => {
  try {
    const videoInfo = await runYoutubeVideoInfo(videoUrl);
    if (!videoInfo) throw new Error("Không thể lấy thông tin video");
    return {
      videoId: videoInfo.videoId,
      title: videoInfo.title,
      description: videoInfo.description,
      duration: videoInfo.duration,
      thumbnail: videoInfo.thumbnail,
      viewCount: videoInfo.viewCount?.toString?.() || String(videoInfo.viewCount || "0"),
      likeCount: videoInfo.likeCount,
      commentCount: videoInfo.commentCount,
      channelId: videoInfo.channelId,
      channelName: videoInfo.channelName,
      publishedTime: videoInfo.publishedTime,
      categories: videoInfo.categories,
      tags: videoInfo.tags,
      isLive: videoInfo.isLive,
      url: videoInfo.url,
    };
  } catch (error) {
    const kind = classifyYoutubeError(error);
    if (kind !== "generic") {
      const info = new Error(error.message);
      info.kind = kind;
      throw info;
    }
    throw error;
  }
};

export const downloadYoutubeVideo = async (videoUrl, videoId, format) => {
  const ext = format === audioFormat ? "m4a" : "mp4";
  const videoPath = path.join(tempDir, `youtube_${videoId}_${Date.now()}.${ext}`);
  await runYoutubeDownload(videoUrl, videoPath, format);
  return videoPath;
};

const convertPublishedTimeToVietnamese = (publishedTime) => {
  if (!publishedTime) return "Không xác định";
  const timeMap = {
    "seconds ago": "giây trước",
    "second ago": "giây trước",
    "minutes ago": "phút trước",
    "minute ago": "phút trước",
    "hours ago": "giờ trước",
    "hour ago": "giờ trước",
    "days ago": "ngày trước",
    "day ago": "ngày trước",
    "weeks ago": "tuần trước",
    "week ago": "tuần trước",
    "months ago": "tháng trước",
    "month ago": "tháng trước",
    "years ago": "năm trước",
    "year ago": "năm trước",
  };
  let vietnameseTime = String(publishedTime);
  for (const [eng, viet] of Object.entries(timeMap)) {
    vietnameseTime = vietnameseTime.replace(eng, viet);
  }
  return vietnameseTime;
};

function formatYoutubeDiagnosticCaption(error) {
  if (error?.stage === "upload") {
    return "Tải lên video thất bại. Vui lòng thử lại sau.";
  }
  if (error?.stage === "send") {
    return "Không thể gửi video sau khi tải lên. Vui lòng thử lại sau.";
  }
  if (!resolveYtDlpCommand().available) {
    return "Máy chủ chưa cài đặt công cụ yt-dlp (.runtime/bin/yt-dlp hoặc PATH). Vui lòng chạy bộ cài công cụ media rồi thử lại.";
  }
  const kind = error?.kind || classifyYoutubeError(error);
  if (kind === "unavailable") {
    return "Video này hiện không khả dụng (riêng tư, giới hạn vùng hoặc bản quyền). Vui lòng chọn video khác.";
  }
  if (kind === "auth") {
    return "YouTube yêu cầu xác thực cookie hoặc đăng nhập (cấu hình YOUTUBE_COOKIES_FILE) để xử lý video này.";
  }
  if (kind === "runtime") {
    return "Lỗi môi trường công cụ giải mã YouTube (yt-dlp / ffmpeg). Vui lòng kiểm tra thư mục .runtime/bin và thử lại.";
  }
  if (kind === "timeout") {
    return "Xử lý dữ liệu YouTube bị quá thời gian cho phép. Vui lòng thử lại sau.";
  }
  return "Đã xảy ra lỗi khi xử lý dữ liệu YouTube! Vui lòng thử lại sau.";
}

export async function handleSendMediaYoutube(api, message, video, qualityParam, videoPath, isAdminLevelHigh) {
  const job = createDownloadJob("youtube");
  api = job.wrapApi(api);
  const { format, qualityText, timeNotify } = getVideoFormat(qualityParam);
  const cachedVideo = await getCachedMedia(PLATFORM, video.videoId, qualityText, video.title);
  let videoUrl;
  let delivery;
  let duration = null;
  let progress = null;
  let fetchedPath = null;

  try {
    if (cachedVideo && (format === audioFormat || isCompleteVideoCache(cachedVideo))) {
      delivery = cachedVideo;
      videoUrl = cachedVideo.fileUrl;
      duration = cachedVideo.duration;
    } else {
      progress = await createDownloadProgress({
        api,
        message,
        caption: buildYoutubeProcessingCaption(qualityText),
        ttl: timeNotify,
      });

      try {
        try {
          fetchedPath = await job.run("download", () => downloadYoutubeVideo(video.url, video.videoId, format));
          ensureNonEmptyFile(fetchedPath);
        } catch (error) {
          throw normalizeYoutubeWorkflowError("download", error);
        }
        if (format === audioFormat) {
          try {
            videoUrl = await uploadAudioFile(fetchedPath, api, message);
            videoUrl = ensureUploadResult([{ fileUrl: videoUrl }]);
          } catch (error) {
            throw normalizeYoutubeWorkflowError("upload", error);
          }
        } else {
          try {
            delivery = await uploadPreparedVideo(api, message, fetchedPath, { job });
            videoUrl = delivery.fileUrl;
          } catch (error) {
            throw error?.stage === "upload" ? error : normalizeYoutubeWorkflowError("upload", error);
          }
        }
        duration = await getDurationVideo(fetchedPath);
        if (format === audioFormat) {
          await setCacheData(PLATFORM, video.videoId, { fileUrl: videoUrl, title: video.title, duration }, qualityText);
        }
      } catch (error) {
        if (fetchedPath) {
          await deleteFile(fetchedPath).catch(() => {});
          fetchedPath = null;
        }
        throw error;
      }
    }

    if (format === audioFormat) {
      await sendVoiceMusic(api, message, {
        trackId: video.videoId,
        title: video.title,
        artists: video.channelName,
        source: "Youtube",
        caption: `> From YouTube <\nNhạc bạn chọn đây!!!`,
        imageUrl: video.thumbnail,
        voiceUrl: videoUrl,
        viewCount: video.viewCount,
        publishedTime: convertPublishedTimeToVietnamese(video.publishedTime),
      }, 1800000, { throwOnError: true });
    } else {
      try {
        await api.sendVideo({
          ...videoPayload(delivery),
          threadId: message.threadId,
          threadType: message.type,
          videoAlreadyUploaded: true,
          message: {
            text: buildYoutubeVideoCaption({
              senderName: message.data.dName,
              title: video.title,
              channelName: video.channelName,
              viewCount: video.viewCount,
              publishedTime: video.publishedTime,
              qualityText,
            }),
            mentions: [MessageMention(message.data.uidFrom, message.data.dName.length, 2, false)],
          },
          ttl: isAdminLevelHigh ? 14400000 : 3600000,
        });
      } catch (error) {
        throw normalizeYoutubeWorkflowError("send", error);
      }
    }

    if (format !== audioFormat) {
      await setCacheData(PLATFORM, video.videoId, { ...delivery, title: video.title }, qualityText);
    }
    await progress?.complete();

    return true;
  } finally {
    if (fetchedPath) await deleteFile(fetchedPath).catch(() => {});
    await progress?.complete();
  }
}

export async function consumeYoutubeSelection(api, message, options = {}) {
  const { video, qualityParam, claim, record = null, sendMedia = handleSendMediaYoutube } = options;
  const senderId = message.data.uidFrom;

  try {
    const isAdminLevelHigh = isAdmin(senderId);
    const durationMs = (Number(video?.duration) || 0) * 1000;
    if (!isAdminLevelHigh && durationMs > 30 * 60 * 1000) {
      await sendMessageWarningRequest(api, message, {
        caption: `Vì tài nguyên có hạn, không thể tải video có độ dài hơn 30 phút!\nVui lòng chọn video khác hoặc xem trực tiếp tại: ${video.url}`,
      }, 30000);
      return { ok: false, claimed: false };
    }

    const claimed = typeof claim === "function" ? await claim() : true;
    if (!claimed) {
      return { ok: false, claimed: false, handled: false };
    }

    try {
      const sent = await sendMedia(api, message, video, qualityParam || "default", null, isAdminLevelHigh);
      return { ok: sent !== false, claimed: true };
    } catch (error) {
      if (error?.stage === "upload") {
        await sendMessageWarningRequest(api, message, {
          caption: "Tải lên video thất bại. Vui lòng thử chọn lại sau.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      if (error?.stage === "send") {
        await sendMessageWarningRequest(api, message, {
          caption: "Không thể gửi video sau khi tải lên. Vui lòng thử chọn lại sau.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      const kind = classifyYoutubeError(error);
      if (kind === "unavailable") {
        await sendMessageWarningRequest(api, message, {
          caption: "Video này hiện không khả dụng. Hãy chọn một video khác trong danh sách.",
        }, 60000);
        return { ok: false, claimed: true };
      }
      if (kind === "auth") {
        await sendMessageWarningRequest(api, message, {
          caption: "YouTube yêu cầu cookie hoặc đăng nhập (YOUTUBE_COOKIES_FILE) để xử lý video này.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      if (kind === "runtime") {
        await sendMessageWarningRequest(api, message, {
          caption: formatYoutubeDiagnosticCaption(error),
        }, 30000);
        return { ok: false, claimed: true };
      }
      if (kind === "timeout") {
        await sendMessageWarningRequest(api, message, {
          caption: "Xử lý YouTube bị quá thời gian cho phép. Vui lòng thử lại sau.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      throw error;
    }
  } catch (error) {
    logDownloadEvent({ source: "youtube", stage: error?.stage || "source", status: "failed", code: classifyYoutubeError(error).toUpperCase() });
    await sendMessageWarningRequest(api, message, {
      caption: formatYoutubeDiagnosticCaption(error),
    }, 30000);
    return { ok: false, claimed: true };
  }
}

export async function handleYoutubeCommand(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const isAdminLevelHigh = isAdmin(senderId);
  let imagePath = null;
  let registered = false;

  try {
    const keyword = extractCommandBody(message, prefix, aliasCommand || "youtube");
    if (!keyword) {
      return await sendMessageCompleteRequest(api, message, {
        caption: `Vui lòng nhập từ khóa tìm kiếm hoặc link YouTube\nVí dụ:\n${prefix}${aliasCommand} Nội dung cần tìm`,
      }, 30000);
    }

    const [query, typeVideo = "normal"] = keyword.split(/\s+/);
    const url = normalizeYoutubeUrl(query);
    if (url) {
      let videoInfo;
      try {
        videoInfo = await getYoutubeVideoInfo(url);
      } catch (error) {
        if (error?.kind === "unavailable") {
          return await sendMessageWarningRequest(api, message, {
            caption: "Video này hiện không khả dụng. Hãy thử một link YouTube khác.",
          }, 60000);
        }
        if (error?.kind === "auth") {
          return await sendMessageWarningRequest(api, message, {
            caption: "YouTube yêu cầu cookie hoặc đăng nhập (YOUTUBE_COOKIES_FILE) để tiếp tục xử lý video này.",
          }, 30000);
        }
        if (error?.kind === "runtime") {
          return await sendMessageWarningRequest(api, message, {
            caption: formatYoutubeDiagnosticCaption(error),
          }, 30000);
        }
        if (error?.kind === "timeout") {
          return await sendMessageWarningRequest(api, message, {
            caption: "Xử lý YouTube bị quá thời gian cho phép. Vui lòng thử lại sau.",
          }, 30000);
        }
        throw error;
      }
      const durationMs = (videoInfo.duration || 0) * 1000;
      if (!isAdminLevelHigh && durationMs > 30 * 60 * 1000) {
        return await sendMessageWarningRequest(api, message, {
          caption: `Vì tài nguyên có hạn, không thể tải video có độ dài hơn 30 phút!\nVui lòng xem đầy đủ tại link sau: ${url}`,
        }, 30000);
      }
      return await handleSendMediaYoutube(api, message, videoInfo, typeVideo, null, isAdminLevelHigh);
    }

    const [searchQuery, numberVideo = 30] = keyword.split("&&");
    const cleanSearch = String(searchQuery || "").trim();
    const limit = Math.min(CONFIG.maxResults, Math.max(1, parseInt(numberVideo, 10) || CONFIG.maxResults));
    const videos = await runYoutubeSearch(cleanSearch, limit);
    if (videos.length === 0) {
      return await sendMessageWarningRequest(api, message, {
        caption: `Không tìm thấy video phù hợp với cụm từ: ${cleanSearch}`,
      }, 30000);
    }

    imagePath = await createSearchResultImage(videos.map((video) => ({
      title: video.title,
      artistsNames: video.channelName,
      thumbnailM: video.thumbnail,
      view: video.viewCount,
      publishedTime: video.publishedTime,
    })));

    const selectionCaption =
      "Đây là danh sách video tôi tìm thấy từ YouTube:\nHãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự để chọn video bạn muốn xem!\n\nVD: 1 hoặc 1 audio";

    const listMessage = await sendMessageCompleteRequest(api, message, {
      caption: selectionCaption,
      imagePath,
    }, CONFIG.timeWaitSelection);

    const quotedMsgIdStr = extractMessageId(listMessage);

    await setSelectionsMapData(senderId, {
      quotedMsgId: quotedMsgIdStr,
      collection: videos,
      timestamp: Date.now(),
      platform: PLATFORM,
      replyAccess: "public",
      api,
      sentMessage: listMessage,
      messageContext: message,
      threadId: message.threadId,
      type: message.type,
      seconds: Math.floor(CONFIG.timeWaitSelection / 1000) || 60,
      ownedTempPaths: imagePath ? [imagePath] : [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: selectionCaption,
        imagePath,
      }, CONFIG.timeWaitSelection),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const record = findSelectionRecordForMessage(replyMessage) ||
          getSelectionsMapData().get(senderId);
        return await consumeYoutubeSelection(api, replyMessage, {
          video: media,
          qualityParam: modifier,
          claim,
          record,
        });
      },
    });
    registered = true;
    return true;
  } catch (error) {
    logDownloadEvent({ source: "youtube", stage: error?.stage || "source", status: "failed", code: classifyYoutubeError(error).toUpperCase() });
    const caption = formatYoutubeDiagnosticCaption(error);
    await sendMessageWarningRequest(api, message, {
      caption,
    }, 30000);
    return true;
  } finally {
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleYoutubeReply(api, message) {
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    logDownloadEvent({ source: "youtube", stage: error?.stage || "source", status: "failed", code: classifyYoutubeError(error).toUpperCase() });
    await sendMessageWarningRequest(api, message, {
      caption: "Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.",
    }, 30000);
    return true;
  }
}
