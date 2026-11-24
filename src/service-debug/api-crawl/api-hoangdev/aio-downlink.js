import { platformFromUrl, readDownloadLink } from "../download/download-input.js";
import { uploadPreparedVideo, videoPayload, isCompleteVideoCache } from "../download/video-delivery.js";
import { createDownloadJob, runPlatformDownload, downloadFailureCaption, logDownloadEvent } from "../download/download-job.js";
import { ensureUploadResult } from "../youtube/youtube-core.js";
import axios from "axios";
import { execFile } from "node:child_process";
import path from "path";
import fs from "fs";
import { promisify } from "node:util";
import { getGlobalPrefix } from "../../service.js";
import { MessageMention } from "../../../api-zalo/index.js";
import {
  sendMessageCompleteRequest,
  sendMessageProcessingRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { downloadFile, deleteFile } from "../../../utils/util.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import { capitalizeEachWord, removeMention } from "../../../utils/format-util.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  getSelectionsMapData,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { downloadYoutubeVideo, extractYoutubeId, getVideoFormatByQuality } from "../youtube/youtube-service.js";
import { clearImagePath } from "../../../utils/canvas/index.js";
import { getFfmpegExecutableSync, getFfprobeExecutableSync } from "../../../utils/runtime-dependencies.js";
import { tempDir } from "../../../utils/io-json.js";
import { canContinueReply } from "../../reply-access.js";
import { normalizeTikTokMedia } from "../tiktok/tiktok-api.js";
import { sendTikTokMedia } from "../tiktok/tiktok-service.js";
import {
  createDownloadProgress,
  extractMessageId,
} from "../../../utils/interaction-countdown.js";

const execFileAsync = promisify(execFile);

function buildFfprobeDurationArgs(filePath) {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ];
}

function buildFfmpegCopyArgs(inputUrl, outputPath) {
  return [
    "-i",
    inputUrl,
    "-c",
    "copy",
    "-bsf:a",
    "aac_adtstoasc",
    outputPath,
  ];
}

async function runFfmpegCopy(inputUrl, outputPath) {
  const ffmpegBinary = getFfmpegExecutableSync();
  if (!ffmpegBinary) {
    throw new Error("FFmpeg không được cài đặt hoặc không thể truy cập");
  }
  await execFileAsync(ffmpegBinary, buildFfmpegCopyArgs(inputUrl, outputPath), {
    timeout: 60000,
    windowsHide: true,
  });
}

async function readDurationMs(filePath) {
  const ffprobeBinary = getFfprobeExecutableSync();
  if (!ffprobeBinary) {
    throw new Error("FFprobe không được cài đặt hoặc không thể truy cập");
  }
  const { stdout } = await execFileAsync(ffprobeBinary, buildFfprobeDurationArgs(filePath), {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true,
  });
  return (parseFloat(stdout) || 0) * 1000;
}

const sanitizeUniqueId = (id) =>
  String(id || "unknown")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 64) || "unknown";

export const API_KEY_HOANGDEV = process.env.HOANGDEV_API_KEY || "";
export const API_URL_DOWNAIO_HOANGDEV = "https://hoangdev.io.vn/Aio/aio-download";

const MEDIA_TYPES = {
  "tiktok.": "tiktok",
  "douyin.": "douyin",
  "capcut.": "capcut",
  "threads.": "threads",
  "instagram.": "instagram",
  "facebook.": "facebook",
  "fb.": "facebook",
  "espn.": "espn",
  "pinterest.": "pinterest",
  "imdb.": "imdb",
  "imgur.": "imgur",
  "ifunny.": "ifunny",
  "izlesene.": "izlesene",
  "reddit.": "reddit",
  "youtube.": "youtube",
  "youtu.": "youtube",
  "twitter.": "twitter",
  "x.com": "twitter",
  "vimeo.": "vimeo",
  "snapchat.": "snapchat",
  "bilibili.": "bilibili",
  "dailymotion.": "dailymotion",
  "sharechat.": "sharechat",
  "likee.": "likee",
  "linkedin.": "linkedin",
  "tumblr.com": "tumblr",
  "hipi.co.in": "hipi",
  "t.me": "telegram",
  "telegram.": "telegram",
  "getstickerpack.com": "getstickerpack",
  "bitchute.com": "bitchute",
  "febspot.com": "febspot",
  "9gag.com": "9gag",
  "ok.ru": "oke",
  "oke.ru": "oke",
  "vk.com": "vk-vkvideo",
  "vk.ru": "vk-vkvideo",
  "vkvideo.": "vk-vkvideo",
  "rumble.com": "rumble",
  "streamable.com": "streamable",
  "ted.com": "ted",
  "tv.sohu.com": "sohutv",
  "sohu.com": "sohutv",
  "xiaohongshu.": "xiaohongshu",
  "ixigua.": "ixigua",
  "weibo.": "weibo",
  "sina.com": "sina",
  "miaopai.": "miaopai",
  "meipai.": "meipai",
  "xiaoying.tv": "xiaoying",
  "national.video": "national",
  "yingke.": "yingke",
  "soundcloud.": "soundcloud",
  "mixcloud.": "mixcloud",
  "spotify.": "spotify",
  "deezer.": "deezer",
  "zingmp3.vn": "zingmp3",
  "bandcamp.": "bandcamp",
  "kuaishou.": "kuaishou",
  "qq.": "qq",
  "bluesky.": "bluesky",
};

const getMediaType = (text) => readDownloadLink({ body: String(text || "") })?.platform || platformFromUrl(text);

const extractFacebookId = (url) => {
  let uniqueId;
  if (typeof url === "string") {
    if (url.includes("/v/")) uniqueId = url.split("/v/")[1];
    if (url.includes("/r/")) uniqueId = url.split("/r/")[1];
    if (uniqueId) uniqueId = uniqueId.replace("/", "");
    if (!uniqueId) uniqueId = url;
  } else {
    uniqueId = `unknown_${Date.now()}`;
  }
  return sanitizeUniqueId(uniqueId);
};

export const getDurationVideo = async (path) => {
  try {
    return await readDurationMs(path);
  } catch {
    return 0;
  }
};

export const getDataDownloadVideo = async (url) => {
  if (!API_KEY_HOANGDEV) throw Object.assign(new Error("HoangDev key missing"), { code: "MISSING_DEPENDENCY" });
  try {
    const response = await axios.get(`${API_URL_DOWNAIO_HOANGDEV}?apikey=${API_KEY_HOANGDEV}&url=${encodeURIComponent(url)}`, {
      timeout: 20000,
      headers: {
        "Content-Type": "application/json",
      },
    });
    if (response.data && response.data.success && response.data.data) {
      return response.data.data;
    }
    throw Object.assign(new Error("Invalid HoangDev response"), { code: "INVALID_RESPONSE" });
  } catch (error) {
    throw error;
  }
};

const typeText = (type) => {
  switch (type) {
    case "video":
      return "video";
    case "audio":
      return "nhạc";
    case "image":
      return "ảnh";
    default:
      return "tập tin";
  }
}

const TIME_WAIT_SELECTION = 60000;

export async function processAndSendMedia(api, message, mediaData, isMultipleImages = false) {
  const {
    selectedMedia,
    mediaType,
    uniqueId,
    duration,
    title,
    author,
    senderId,
    senderName
  } = mediaData;

  const quality = selectedMedia?.quality || "default";
  const typeFile = String(selectedMedia?.type || "").toLowerCase();
  const safeUniqueId = sanitizeUniqueId(uniqueId);

  if (typeFile === "image") {
    const thumbnailPath = path.resolve(tempDir, `${safeUniqueId}_${Date.now()}.${selectedMedia.extension || "jpg"}`);
    const thumbnailUrl = selectedMedia.url;

    if (thumbnailUrl) {
      let retryCount = 0;
      const maxRetries = 3;
      let downloadSuccess = false;

      while (retryCount < maxRetries && !downloadSuccess) {
        try {
          await downloadImageWithTimeout(thumbnailUrl, thumbnailPath, 30000);
          downloadSuccess = true;
        } catch (downloadError) {
          retryCount++;
          logDownloadEvent({ source: "hoangdev", stage: "media", status: "failed", code: "MEDIA_ERROR" });
          if (retryCount >= maxRetries) {
            throw downloadError;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    try {
      await api.sendMessage({
        msg: `[ ${senderName} ]\n\n👤 Author: ${author}\n🖼️ Caption: ${title}`,
        attachments: [thumbnailPath],
        mentions: [MessageMention(senderId, senderName.length, 2, false)],
        ttl: 3600000,
      }, message.threadId, message.type);

      if (selectedMedia.voiceUrl) {
        const voicePath = path.resolve(tempDir, `voice_${Date.now()}.mp3`);
        try {

          let retryCount = 0;
          const maxRetries = 3;
          let downloadSuccess = false;

          while (retryCount < maxRetries && !downloadSuccess) {
            try {
              await downloadVoiceWithTimeout(selectedMedia.voiceUrl, voicePath, 30000);
              downloadSuccess = true;
            } catch (downloadError) {
              retryCount++;
              logDownloadEvent({ source: "hoangdev", stage: "media", status: "failed", code: "MEDIA_ERROR" });
              if (retryCount >= maxRetries) {
                throw downloadError;
              }
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          if (downloadSuccess) {
            const uploadResult = await api.uploadAttachment([voicePath], message.threadId, message.type);
            const voiceUrl = uploadResult[0].fileUrl;

            if (voiceUrl) {
              await api.sendVoice(message, voiceUrl, 3600000);
            }
          }

        } catch (error) {
          throw error;
        } finally {
          await deleteFile(voicePath).catch(() => {});
        }
      }
    } finally {
      // Dọn operation temp của lần thử sau khi gửi cuối kết thúc.
      if (thumbnailPath && thumbnailUrl) {
        await clearImagePath(thumbnailPath);
      }
    }
    return true;
  }

  if ((mediaType === "youtube" || mediaType === "instagram") && duration) {
    if (duration * 1000 > 60 * 60 * 1000) {
      const object = {
        caption: "Vì tài nguyên có hạn, Không thể lấy video có độ dài hơn 60 phút!\nVui lòng chọn video khác.",
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return false;
    }
  }

  const cachedMedia = await getCachedMedia(mediaType, uniqueId, quality, title);
  let videoUrl;
  let delivery;
  let progress = null;
  // Operation temp của lần thử này: chỉ xóa sau khi gửi cuối resolve/reject.
  let operationTempPath = null;

  try {
    if (cachedMedia && (typeFile !== "video" || isCompleteVideoCache(cachedMedia))) {
      delivery = cachedMedia;
      videoUrl = cachedMedia.fileUrl;
    } else {
      if (!isMultipleImages) {
        progress = await createDownloadProgress({
          api,
          message,
          caption: `Chờ bé lấy ${typeText(typeFile)} một chút, xong bé gọi cho hay.\n\n⏳ ${title}\n📊 Chất lượng: ${quality}`,
          ttl: 8000,
        });
      }

      const downloaded = await categoryDownload(api, message, mediaType, uniqueId, selectedMedia, quality);
      if (!downloaded || !downloaded.videoUrl) {
        throw Object.assign(new Error("Media download failed"), { code: "DOWNLOAD_FAILED" });
      }
      delivery = downloaded?.delivery;
      videoUrl = downloaded.videoUrl;
      operationTempPath = downloaded.tempFilePath || null;
    }

    if (typeFile === "audio") {
      await api.sendVoice(message, videoUrl, 3600000);
      return true;
    } else if (typeFile === "video") {
      await api.sendVideo({
        ...videoPayload(delivery),
        videoAlreadyUploaded: true,
        threadId: message.threadId,
        threadType: message.type,
        message: {
          text:
            `[ ${senderName} ]\n` +
            `🎥 Nền Tảng: ${capitalizeEachWord(mediaType)}\n` +
            `🎬 Tiêu Đề: ${title}\n` +
            `${author && author !== "Unknown Author" ? `👤 Người Đăng: ${author}\n` : ""}` +
            `📊 Chất lượng: ${quality}`,
          mentions: [MessageMention(senderId, senderName.length, 2, false)],
        },
        ttl: 3600000,
      });
      await setCacheData(mediaType, uniqueId, { ...delivery, title }, quality);
      return true;
    }
    return false;
  } finally {
    await progress?.complete();
    if (operationTempPath) {
      await deleteFile(operationTempPath).catch(() => {});
    }
  }
}

export async function processAndSendMultipleImages(api, message, images, mediaData) {
  const {
    mediaType,
    title,
    author,
    senderId,
    senderName
  } = mediaData;

  const imagePaths = [];

  try {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      const imagePath = path.resolve(tempDir, `${Date.now()}_${i}.${image.extension}`);

      let retryCount = 0;
      const maxRetries = 3;
      let downloadSuccess = false;

      while (retryCount < maxRetries && !downloadSuccess) {
        try {
          await downloadImageWithTimeout(image.url, imagePath, 30000);
          downloadSuccess = true;
        } catch (downloadError) {
          retryCount++;
          logDownloadEvent({ source: "hoangdev", stage: "media", status: "failed", code: "MEDIA_ERROR" });
          if (retryCount >= maxRetries) {
            throw downloadError;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (downloadSuccess) {
        imagePaths.push(imagePath);
      }
    }

    await api.sendMessage({
      msg: `[ ${senderName} ]\n\n👤 Author: ${author}\n🖼️ Caption: ${title}`,
      attachments: imagePaths,
      mentions: [MessageMention(senderId, senderName.length, 2, false)],
      ttl: 3600000,
    }, message.threadId, message.type);

  } finally {
    for (const imagePath of imagePaths) {
      await clearImagePath(imagePath);
    }
  }
}

export async function handleDownloadCommand(api, message, aliasCommand, dependencies = {}) {
  const originalApi = api;
  const job = createDownloadJob("hoangdev");
  api = job.wrapApi(api);
  let query, mediaType;
  const content = removeMention(message);
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  try {
    query = content.replace(`${prefix}${aliasCommand}`, "").trim();

    if (!query) {
      const object = {
        caption: `Vui lòng nhập link cần tải\nVí dụ:\n${prefix}${aliasCommand} <link>`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    mediaType = getMediaType(query);
    if (!mediaType) {
      const object = {
        caption: `Link này em chưa hỗ trợ tải dữ liệu.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    let dataDownload = await job.run("source", () => (dependencies.getDataDownloadVideo || getDataDownloadVideo)(query));
    job.stage = "download";
    if (!dataDownload || dataDownload.error) {
      throw Object.assign(new Error("Invalid HoangDev response"), { code: "INVALID_RESPONSE" });
    }

    if (mediaType === "tiktok") {
      const normalizedTikTok = normalizeTikTokMedia(dataDownload, "hoangdev");
      if (normalizedTikTok?.kind === "slideshow" && normalizedTikTok.images?.length) {
        await sendTikTokMedia(api, message, normalizedTikTok, { job, isRandom: false, typeVideo: normalizedTikTok.video?.quality || "540p" });
        return;
      }
    }

    const dataLink = [];
    let uniqueId;

    switch (mediaType) {
      case "tiktok":
        uniqueId = (dataDownload.title || dataDownload.url || "unknown").replace(/#\w+/g, (match) => match.toLowerCase());
        dataDownload.medias.forEach((item) => {
          dataLink.push({
            url: item.url,
            quality: item.quality,
            type: item.type,
            title: dataDownload.title,
            thumbnail: item.thumbnail || dataDownload.thumbnail,
            extension: item.extension,
            voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
          });
        });
        break;
      case "douyin":
        uniqueId = sanitizeUniqueId((dataDownload.title || dataDownload.url || "unknown").replace(/#\w+/g, (match) => match.toLowerCase()));
        (dataDownload.medias || []).forEach((item) => {
          if (String(item?.quality || "").toLowerCase() === "no watermark") {
            dataLink.push({
              url: item.url,
              quality: item.quality,
              type: item.type,
              title: dataDownload.title,
              thumbnail: item.thumbnail || dataDownload.thumbnail,
              extension: item.extension,
              voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
            });
          }
        });
        break;
      case "youtube":
        uniqueId = sanitizeUniqueId(extractYoutubeId(dataDownload.url));
        (dataDownload.medias || []).forEach((item) => {
          dataLink.push({
            url: item.url,
            quality: item.quality || item.label || "Unknown",
            type: item.type,
            title: dataDownload.title,
            thumbnail: dataDownload.thumbnail,
            extension: item.extension || item.ext || "mp4",
            voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
          });
        });
        break;
      case "facebook":
        uniqueId = extractFacebookId(dataDownload.url);
        (dataDownload.medias || []).forEach((item) => {
          if (String(item?.quality || "").toLowerCase() === "hd" || String(item?.type || "").toLowerCase() === "image") {
            dataLink.push({
              url: item.url,
              quality: item.quality,
              type: item.type,
              title: dataDownload.title,
              thumbnail: item.thumbnail || dataDownload.thumbnail,
              extension: item.extension,
              voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
            });
          }
        });
        break;
      case "threads":
        uniqueId = (dataDownload.author + dataDownload.title) || dataDownload.url || "unknown";
        dataDownload.medias.forEach((item) => {
          dataLink.push({
            url: item.url,
            quality: item.quality,
            type: item.type,
            title: dataDownload.title,
            thumbnail: item.thumbnail || item.url,
            extension: item.extension,
            voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
          });
        });
        break;
      case "instagram":
        uniqueId = dataDownload.url || dataDownload.title || "unknown";
        dataDownload.medias.forEach((item) => {
          dataLink.push({
            url: item.url,
            quality: item.quality,
            type: item.type,
            title: dataDownload.title,
            thumbnail: item.thumbnail || dataDownload.thumbnail,
            extension: item.extension,
            voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
          });
        });
        break;
      case "spotify":
      case "telegram":
      case "dailymotion":
      case "likee":
      case "sina":
      case "ixigua":
      case "vk-vkvideo":
      case "oke":
      case "deezer":
      case "kuaishou":
      case "qq":
      case "bluesky":
      case "pornbox":
        uniqueId = (dataDownload.url && dataDownload.url.split("/").pop()) || dataDownload.title || "unknown";
        dataDownload.medias.forEach((item) => {
          dataLink.push({
            url: item.url,
            quality: item.quality,
            type: item.type,
            title: dataDownload.title,
            thumbnail: item.thumbnail || dataDownload.thumbnail,
            extension: item.extension,
            voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
          });
        });
        break;
      default:
        uniqueId = (dataDownload.url && dataDownload.url.split("/").pop()) || dataDownload.title || "unknown";
        dataDownload.medias.forEach((item) => {
          dataLink.push({
            url: item.url,
            quality: item.quality,
            type: item.type,
            title: dataDownload.title,
            thumbnail: item.thumbnail || dataDownload.thumbnail,
            extension: item.extension,
            voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
          });
        });
        break;
    }

    uniqueId = sanitizeUniqueId(uniqueId);

    if (dataLink.length === 0) {
      throw Object.assign(new Error("No downloadable formats"), { code: "INVALID_RESPONSE" });
    }

    const images = dataLink.filter(item => String(item?.type || "").toLowerCase() === 'image');
    const voices = dataLink.filter(item => String(item?.type || "").toLowerCase() === 'audio');
    const videos = dataLink.filter(item => String(item?.type || "").toLowerCase() === 'video');
    const others = dataLink.filter(item => !['image', 'audio', 'video'].includes(String(item?.type || "").toLowerCase()));

    if (images.length > 0) {
      await processAndSendMultipleImages(api, message, images, {
        mediaType,
        uniqueId,
        duration: dataDownload.duration,
        title: dataDownload.title,
        author: dataDownload.author,
        senderId,
        senderName
      });
    }

    if (voices.length > 0) {
      for (const voice of voices) {
        await processAndSendMedia(api, message, {
          selectedMedia: voice,
          mediaType,
          uniqueId,
          duration: dataDownload.duration,
          title: dataDownload.title,
          author: dataDownload.author,
          senderId,
          senderName
        }, true);
      }
    }

    if (videos.length === 0 && others.length === 0) {
      return;
    }

    const remainingItems = [...videos, ...others];
    if (remainingItems.length === 1) {
      await processAndSendMedia(api, message, {
        selectedMedia: remainingItems[0],
        mediaType,
        uniqueId,
        duration: dataDownload.duration,
        title: dataDownload.title,
        author: dataDownload.author,
        senderId,
        senderName
      });
      return;
    }

    let listText = `Đây là danh sách các phiên bản có sẵn:\n`;
    listText += `Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự phiên bản bạn muốn tải!\n\n`;
    listText += remainingItems
      .map((item, index) => `${index + 1}. ${item.type} - ${item.quality || "Unknown"} (${item.extension})`)
      .join("\n");

    const object = {
      caption: listText,
    };

    const listMessage = await sendMessageCompleteRequest(api, message, object, TIME_WAIT_SELECTION);
    const quotedMsgId = listMessage?.message?.msgId || listMessage?.attachment?.[0]?.msgId;
    const quotedMsgIdStr = quotedMsgId ? quotedMsgId.toString() : "";

    // Bảng chọn AIO không có preview image; resendPrompt gửi lại đúng payload.
    await setSelectionsMapData(senderId, {
      quotedMsgId: quotedMsgIdStr,
      collection: remainingItems,
      uniqueId: uniqueId,
      mediaType: mediaType,
      title: dataDownload.title,
      duration: dataDownload.duration || 0,
      author: dataDownload.author || "Unknown Author",
      timestamp: Date.now(),
      platform: "downlink",
      replyAccess: "public",
      api,
      sentMessage: listMessage,
      messageContext: message,
      threadId: message.threadId,
      type: message.type,
      seconds: Math.floor(TIME_WAIT_SELECTION / 1000) || 60,
      ownedTempPaths: [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: listText,
      }, TIME_WAIT_SELECTION),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await processAndSendMedia(api, replyMessage, {
            selectedMedia: media,
            mediaType,
            uniqueId,
            duration: dataDownload.duration || 0,
            title: dataDownload.title,
            author: dataDownload.author || "Unknown Author",
            senderId,
            senderName
          });
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          job.event(job.stage, "failed", error);
          if (job.canFallback() && ["youtube", "tiktok"].includes(mediaType)) {
            const ok = await (dependencies.runPlatformDownload || runPlatformDownload)(originalApi, replyMessage, query, mediaType);
            return { ok, claimed: true };
          }
          await sendMessageWarningRequest(originalApi, replyMessage, { caption: downloadFailureCaption("HoangDev", job.stage, error) }, 30000);
          return { ok: false, claimed: true };
        }
      },
    });
  } catch (error) {
    job.event(job.stage, "failed", error);
    if (job.canFallback() && ["youtube", "tiktok"].includes(mediaType)) {
      return (dependencies.runPlatformDownload || runPlatformDownload)(originalApi, message, query, mediaType);
    }
    await sendMessageWarningRequest(originalApi, message, {
      caption: downloadFailureCaption("HoangDev", job.stage, error),
    }, 30000);
  }
}

/**
 * Tải + upload media, trả về `{ videoUrl, tempFilePath }`.
 * KHÔNG tự xóa file tạm tại đây: caller phải xóa sau khi thao tác gửi cuối
 * cùng (sendVideo/sendVoice) resolve hoặc reject.
 */
export async function categoryDownload(api, message, platform, uniqueId, selectedMedia, quality) {
  let qualityVideo;
  let tempFilePath;
  try {
    switch (platform) {
      case "youtube":
        const { format, qualityText } = getVideoFormatByQuality(quality);
        qualityVideo = qualityText;
        tempFilePath = await downloadYoutubeVideo(selectedMedia.url, uniqueId, format);
        break;
      default:
        qualityVideo = quality;
        tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.${selectedMedia.extension}`);
        if (selectedMedia.extension === 'm3u8') {
          tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.mp4`);
          await runFfmpegCopy(selectedMedia.url, tempFilePath);
        } else {
          await downloadFile(selectedMedia.url, tempFilePath);
        }
        break;
    }

    if (selectedMedia.type !== 'audio' && (selectedMedia.type === "video" || !/^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(selectedMedia.extension || ''))) {
      const delivery = await uploadPreparedVideo(api, message, tempFilePath);
      return { videoUrl: delivery.fileUrl, tempFilePath, delivery };
    }
    const uploadResult = await api.uploadAttachment([tempFilePath], message.threadId, message.type);
    const videoUrl = uploadResult[0].fileUrl;
    const duration = await getDurationVideo(tempFilePath);
    await setCacheData(platform, uniqueId, { fileUrl: videoUrl, title: selectedMedia.title, duration }, qualityVideo);
    return { videoUrl, tempFilePath };
  } catch (error) {
    if (tempFilePath) {
      await deleteFile(tempFilePath).catch(() => {});
    }
    throw error;
  }
}

export async function handleDownloadReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== "downlink") return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    logDownloadEvent({ source: "hoangdev", stage: "media", status: "failed", code: "MEDIA_ERROR" });
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
    return true;
  }
}

async function downloadVoiceWithTimeout(url, filepath, timeout = 30000) {
  return downloadFile(url, filepath, { timeout });
}

async function downloadImageWithTimeout(url, filepath, timeout = 30000) {
  return downloadFile(url, filepath, { timeout });
}
