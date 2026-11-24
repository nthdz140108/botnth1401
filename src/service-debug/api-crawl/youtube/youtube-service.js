import { createDownloadJob, logDownloadEvent } from "../download/download-job.js";
import fs from "fs";
import path from "path";
import schedule from "node-schedule";
import { Worker } from "worker_threads";


import { MessageMention } from "../../../api-zalo/index.js";
import { deleteFile } from "../../../utils/util.js";
import { removeMention } from "../../../utils/format-util.js";
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
import { getYoutubeAuthOptions } from "./youtube-auth.js";
import {
  createDownloadProgress,
  extractMessageId,
} from "../../../utils/interaction-countdown.js";

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  "Mozilla/5.0 (Linux; Android 14; Pixel 7 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
];

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
      return { format: YOUTUBE_FORMAT_MAX, qualityText: "Cao nhat", timeNotify: 24000 };
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
    if (!videoInfo) throw new Error("Khong the lay thong tin video");
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
  if (!publishedTime) return "Khong xac dinh";
  const timeMap = {
    "second ago": "giay truoc",
    "seconds ago": "giay truoc",
    "minute ago": "phut truoc",
    "minutes ago": "phut truoc",
    "hour ago": "gio truoc",
    "hours ago": "gio truoc",
    "day ago": "ngay truoc",
    "days ago": "ngay truoc",
    "week ago": "tuan truoc",
    "weeks ago": "tuan truoc",
    "month ago": "thang truoc",
    "months ago": "thang truoc",
    "year ago": "nam truoc",
    "years ago": "nam truoc",
  };
  let vietnameseTime = String(publishedTime);
  for (const [eng, viet] of Object.entries(timeMap)) vietnameseTime = vietnameseTime.replace(eng, viet);
  return vietnameseTime;
};

if (process.env.NODE_ENV !== "test") {
  // Dọn dẹp map nội bộ đã bị loại bỏ: lifecycle bảng chọn do store chung quản lý.
}

export async function handleSendMediaYoutube(api, message, video, qualityParam, videoPath, isAdminLevelHigh) {
  const job = createDownloadJob("youtube");
  api = job.wrapApi(api);
  const { format, qualityText, timeNotify } = getVideoFormat(qualityParam);
  const cachedVideo = await getCachedMedia(PLATFORM, video.videoId, qualityText, video.title);
  let videoUrl;
  let duration = null;
  let progress = null;
  // File media tải về chỉ được xóa sau khi thao tác gửi cuối cùng kết thúc.
  let fetchedPath = null;

  try {
    if (cachedVideo) {
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
            if (!videoUrl) throw new Error("Missing uploaded audio URL");
          } catch (error) {
            throw normalizeYoutubeWorkflowError("upload", error);
          }
        } else {
          try {
            const uploadVideo = await api.uploadAttachment([fetchedPath], message.threadId, message.type);
            videoUrl = ensureUploadResult(uploadVideo);
          } catch (error) {
            throw error?.stage === "upload" ? error : normalizeYoutubeWorkflowError("upload", error);
          }
        }
        duration = await getDurationVideo(fetchedPath);
        setCacheData(PLATFORM, video.videoId, { fileUrl: videoUrl, title: video.title, duration }, qualityText);
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
        caption: `> From Youtube <\nNhac Ban Chon Day!!!`,
        imageUrl: video.thumbnail,
        voiceUrl: videoUrl,
        viewCount: video.viewCount,
        publishedTime: convertPublishedTimeToVietnamese(video.publishedTime),
      }, 1800000, { throwOnError: true });
    } else {
      try {
        await api.sendVideo({
        videoUrl,
        threadId: message.threadId,
        threadType: message.type,
        thumbnail: video.thumbnail,
        localThumbnailSource: fetchedPath || undefined,
        duration,
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

    await progress?.complete();

    return true;
  } finally {
    // Dọn file operation temp sau khi gửi cuối resolve/reject.
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
        caption: `Vi tai nguyen co han, Khong the lay video co do dai hon 30 phut!\nVui long chon lai video khac hoac truy cap vao link sau de xem day du: ${video.url}`,
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
          caption: "Tai len video that bai. Vui long thu chon lai sau.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      if (error?.stage === "send") {
        await sendMessageWarningRequest(api, message, {
          caption: "Khong the gui video sau khi tai len. Vui long thu chon lai sau.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      const kind = classifyYoutubeError(error);
      if (kind === "unavailable") {
        await sendMessageWarningRequest(api, message, {
          caption: "Video nay hien khong kha dung. Hay chon mot video khac trong danh sach.",
        }, 60000);
        return { ok: false, claimed: true };
      }
      if (kind === "auth") {
        await sendMessageWarningRequest(api, message, {
          caption: "YouTube can cookie hoac dang nhap de tiep tuc xu ly video nay.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      if (kind === "runtime") {
        await sendMessageWarningRequest(api, message, {
          caption: "Loi cau hinh runtime YouTube. Vui long kiem tra Deno va thu lai.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      if (kind === "timeout") {
        await sendMessageWarningRequest(api, message, {
          caption: "Xu ly YouTube bi qua thoi gian cho phep. Vui long thu lai sau.",
        }, 30000);
        return { ok: false, claimed: true };
      }
      throw error;
    }
  } catch (error) {
    logDownloadEvent({ source: "youtube", stage: error?.stage || "source", status: "failed", code: classifyYoutubeError(error).toUpperCase() });
    await sendMessageWarningRequest(api, message, {
      caption: "Da xay ra loi khi xu ly tin nhan cua ban. Vui long thu lai sau.",
    }, 30000);
    return { ok: false, claimed: true };
  }
}

export async function handleYoutubeCommand(api, message, aliasCommand) {
  const content = removeMention(message);
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const isAdminLevelHigh = isAdmin(senderId);
  let imagePath = null;
  let registered = false;

  try {
    const keyword = content.replace(`${prefix}${aliasCommand}`, "").trim();
    if (!keyword) {
      return await sendMessageCompleteRequest(api, message, {
        caption: `Vui long nhap tu khoa tim kiem hoac link\nVi du:\n${prefix}${aliasCommand} Noi Dung Can Tim`,
      }, 30000);
    }

        const [query, typeVideo = "normal"] = keyword.split(" ");
        const url = normalizeYoutubeUrl(query);
        if (url) {
          let videoInfo;
          try {
            videoInfo = await getYoutubeVideoInfo(url);
          } catch (error) {
            if (error?.kind === "unavailable") {
              return await sendMessageWarningRequest(api, message, {
                caption: "Video nay hien khong kha dung. Hay chon mot video khac trong danh sach.",
              }, 60000);
            }
            if (error?.kind === "auth") {
              return await sendMessageWarningRequest(api, message, {
                caption: "YouTube can cookie hoac dang nhap de tiep tuc xu ly video nay.",
              }, 30000);
            }
            if (error?.kind === "runtime") {
              return await sendMessageWarningRequest(api, message, {
                caption: "Loi cau hinh runtime YouTube. Vui long kiem tra Deno va thu lai.",
              }, 30000);
            }
            if (error?.kind === "timeout") {
              return await sendMessageWarningRequest(api, message, {
                caption: "Xu ly YouTube bi qua thoi gian cho phep. Vui long thu lai sau.",
              }, 30000);
            }
            throw error;
          }
          const durationMs = (videoInfo.duration || 0) * 1000;
          if (!isAdminLevelHigh && durationMs > 30 * 60 * 1000) {
            return await sendMessageWarningRequest(api, message, {
              caption: `Vi tai nguyen co han, Khong the lay video co do dai hon 30 phut!\nVui long truy cap vao link sau de xem day du: ${url}`,
        }, 30000);
      }
      return await handleSendMediaYoutube(api, message, videoInfo, typeVideo, null, isAdminLevelHigh);
    }

    const [searchQuery, numberVideo = 30] = keyword.split("&&");
    const limit = Math.min(CONFIG.maxResults, Math.max(1, parseInt(numberVideo, 10) || CONFIG.maxResults));
    const videos = await runYoutubeSearch(searchQuery, limit);
    if (videos.length === 0) {
      return await sendMessageWarningRequest(api, message, {
        caption: `Khong tim thay video phu hop voi cum tu: ${searchQuery}`,
      }, 30000);
    }

    imagePath = await createSearchResultImage(videos.map((video) => ({
      title: video.title,
      artistsNames: video.channelName,
      thumbnailM: video.thumbnail,
      view: video.viewCount,
      publishedTime: video.publishedTime,
    })));

    const selectionCaption = "Day la danh sach video toi tim thay tu Youtube:\nHay tra loi tin nhan nay HOAC gui so thu tu de chon video ban muon xem!\n\nVD: 1 hoac 1 audio";

    const listMessage = await sendMessageCompleteRequest(api, message, {
      caption: selectionCaption,
      imagePath,
    }, CONFIG.timeWaitSelection);

    const quotedMsgIdStr = extractMessageId(listMessage);

    // Preview temp (ảnh danh sách) thuộc sở hữu của session: chỉ bị xóa đúng một
    // lần khi session kết thúc (thành công / hết hạn). resendPrompt dùng lại
    // chính ảnh này khi cần mở lại bảng sau lỗi.
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
    const caption = error?.stage === "upload"
      ? "Tai len video that bai. Vui long thu lai sau."
      : error?.stage === "send"
        ? "Khong the gui video sau khi tai len. Vui long thu lai sau."
        : "Co loi xay ra khi xu ly video!";
    await sendMessageWarningRequest(api, message, {
      caption,
    }, 30000);
    return true;
  } finally {
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleYoutubeReply(api, message) {
  // Adapter mỏng: toàn bộ claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    logDownloadEvent({ source: "youtube", stage: error?.stage || "source", status: "failed", code: classifyYoutubeError(error).toUpperCase() });
    await sendMessageWarningRequest(api, message, {
      caption: "Da xay ra loi khi xu ly tin nhan cua ban. Vui long thu lai sau.",
    }, 30000);
    return true;
  }
}
