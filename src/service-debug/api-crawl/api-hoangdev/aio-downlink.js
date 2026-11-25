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
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { downloadFile, deleteFile } from "../../../utils/util.js";
import { capitalizeEachWord } from "../../../utils/format-util.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { downloadYoutubeVideo, extractYoutubeId, getVideoFormatByQuality } from "../youtube/youtube-service.js";
import {
  downloadVideoWithYtDlp,
  resolveYtDlpCommand,
  runYtDlpJson,
} from "../youtube/youtube-runtime.js";
import { clearImagePath } from "../../../utils/canvas/index.js";
import { getFfmpegExecutableSync, getFfprobeExecutableSync } from "../../../utils/runtime-dependencies.js";
import { tempDir } from "../../../utils/io-json.js";
import { canContinueReply } from "../../reply-access.js";
import { getTikTokMedia, normalizeTikTokMedia } from "../tiktok/tiktok-api.js";
import { sendTikTokMedia } from "../tiktok/tiktok-service.js";
import { createDownloadProgress } from "../../../utils/interaction-countdown.js";

const execFileAsync = promisify(execFile);
const MAX_IMAGES_PER_MESSAGE = 5;

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
    "-y",
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

export const getDurationVideo = async (filePath) => {
  try {
    return await readDurationMs(filePath);
  } catch {
    return 0;
  }
};

function mapYtDlpInfoToAioPayload(info, originalUrl) {
  const entries = Array.isArray(info?.entries) && info.entries.length > 0 ? info.entries : [info];
  const medias = [];

  for (const entry of entries) {
    if (!entry) continue;
    const entryUrl = entry.webpage_url || entry.url || originalUrl;
    const ext = String(entry.ext || "").toLowerCase();
    const isImage = ["jpg", "jpeg", "png", "webp"].includes(ext) && !entry.duration && entry.vcodec === "none";

    if (isImage && entry.url) {
      medias.push({
        url: entry.url,
        type: "image",
        quality: "HD",
        extension: ext || "jpg",
        thumbnail: entry.thumbnail || entry.url,
      });
      continue;
    }

    const formats = Array.isArray(entry.formats) ? entry.formats : [];
    const progressiveMp4s = formats
      .filter(
        (f) =>
          f?.url &&
          /^https?:\/\//i.test(f.url) &&
          String(f.ext || "").toLowerCase() === "mp4" &&
          f.vcodec &&
          f.vcodec !== "none" &&
          f.acodec &&
          f.acodec !== "none"
      )
      .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

    const bestDirect = progressiveMp4s[0];
    medias.push({
      url: bestDirect?.url || entryUrl,
      ytdlpUrl: entryUrl,
      useYtDlp: !bestDirect?.url,
      ytdlpFormat: "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
      quality: bestDirect?.height ? `${bestDirect.height}p` : entry.height ? `${entry.height}p` : "HD",
      type: "video",
      extension: "mp4",
      thumbnail: entry.thumbnail || entry.thumbnails?.[0]?.url || "",
    });
  }

  return {
    id: info.id || sanitizeUniqueId(originalUrl),
    url: info.webpage_url || originalUrl,
    title: info.title || info.description || "Media",
    author: info.uploader || info.channel || info.creator || "Unknown Author",
    thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || "",
    duration: Number(info.duration) || 0,
    medias,
  };
}

export const getDataDownloadVideo = async (url) => {
  const platform = getMediaType(url);

  // 1. Internal TikTok pipeline for TikTok URLs
  if (platform === "tiktok") {
    try {
      const ttMedia = await getTikTokMedia(url);
      if (ttMedia) {
        const medias =
          ttMedia.kind === "slideshow" && Array.isArray(ttMedia.images)
            ? ttMedia.images.map((img) => ({
                url: img.url,
                type: "image",
                quality: "HD",
                extension: img.extension || "jpg",
                thumbnail: img.url,
              }))
            : ttMedia.video?.url
              ? [
                  {
                    url: ttMedia.video.url,
                    useYtDlp: Boolean(ttMedia.video.useYtDlp),
                    ytdlpUrl: url,
                    type: "video",
                    quality: ttMedia.video.quality || "HD",
                    extension: "mp4",
                    thumbnail: ttMedia.video.cover || "",
                  },
                ]
              : [];
        if (medias.length > 0) {
          return {
            id: ttMedia.id,
            url,
            title: ttMedia.desc || "TikTok",
            author: ttMedia.author?.nickname || ttMedia.author?.uniqueId || "TikTok",
            thumbnail: ttMedia.video?.cover || ttMedia.images?.[0]?.url || "",
            duration: Math.floor((Number(ttMedia.video?.duration) || 0) / 1000),
            music: ttMedia.music,
            medias,
          };
        }
      }
    } catch {}
  }

  // 2. Self-contained universal yt-dlp extractor (FB, IG, Threads, YT, X, Reddit, Pinterest, Bilibili, Douyin, CapCut...)
  if (resolveYtDlpCommand().available) {
    try {
      const info = await runYtDlpJson(url, {}, 30000);
      if (info) {
        const mapped = mapYtDlpInfoToAioPayload(info, url);
        if (mapped.medias.length > 0) {
          return mapped;
        }
      }
    } catch (ytdlpError) {
      if (!process.env.HOANGDEV_API_KEY) {
        throw Object.assign(new Error(ytdlpError?.message || "yt-dlp extraction failed"), {
          code: ytdlpError?.code || "PROVIDER_ERROR",
        });
      }
    }
  }

  // 3. Optional legacy fallback if HOANGDEV_API_KEY is explicitly configured
  const apiKey = process.env.HOANGDEV_API_KEY || API_KEY_HOANGDEV;
  if (!apiKey) {
    throw Object.assign(new Error("yt-dlp unavailable and HOANGDEV_API_KEY missing"), {
      code: "MISSING_DEPENDENCY",
    });
  }

  const response = await axios.get(`${API_URL_DOWNAIO_HOANGDEV}?apikey=${apiKey}&url=${encodeURIComponent(url)}`, {
    timeout: 20000,
    headers: { "Content-Type": "application/json" },
  });
  if (response.data && response.data.success && response.data.data) {
    return response.data.data;
  }
  throw Object.assign(new Error("Invalid AIO response"), { code: "INVALID_RESPONSE" });
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
};

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
    senderName,
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
          logDownloadEvent({ source: "aio", stage: "media", status: "failed", code: "MEDIA_ERROR" });
          if (retryCount >= maxRetries) {
            throw downloadError;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
    }

    try {
      await api.sendMessage(
        {
          msg: `[ ${senderName} ]\n\n👤 Author: ${author}\n🖼️ Caption: ${title}`,
          attachments: [thumbnailPath],
          mentions: [MessageMention(senderId, senderName.length, 2, false)],
          ttl: 3600000,
        },
        message.threadId,
        message.type
      );

      if (selectedMedia.voiceUrl) {
        const voicePath = path.resolve(tempDir, `voice_${Date.now()}.mp3`);
        try {
          await downloadVoiceWithTimeout(selectedMedia.voiceUrl, voicePath, 30000);
          const uploadResult = await api.uploadAttachment([voicePath], message.threadId, message.type);
          const voiceUrl = uploadResult?.[0]?.fileUrl;
          if (voiceUrl) {
            await api.sendVoice(message, voiceUrl, 3600000);
          }
        } finally {
          await deleteFile(voicePath).catch(() => {});
        }
      }
    } finally {
      if (thumbnailPath && thumbnailUrl) {
        await clearImagePath(thumbnailPath);
      }
    }
    return true;
  }

  if ((mediaType === "youtube" || mediaType === "instagram") && duration) {
    if (duration * 1000 > 60 * 60 * 1000) {
      await sendMessageWarningRequest(api, message, {
        caption: "Vì tài nguyên có hạn, không thể tải video có độ dài hơn 60 phút!\nVui lòng chọn video khác.",
      }, 30000);
      return false;
    }
  }

  const cachedMedia = await getCachedMedia(mediaType, uniqueId, quality, title);
  let videoUrl;
  let delivery;
  let progress = null;
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
      delivery = downloaded.delivery;
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
  const { title, author, senderId, senderName } = mediaData;
  const imagePaths = [];

  try {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      if (!image?.url) continue;
      const ext = image.extension || "jpg";
      const imagePath = path.resolve(tempDir, `${Date.now()}_${i}.${ext}`);

      let retryCount = 0;
      const maxRetries = 3;
      let downloadSuccess = false;

      while (retryCount < maxRetries && !downloadSuccess) {
        try {
          await downloadImageWithTimeout(image.url, imagePath, 30000);
          downloadSuccess = true;
        } catch (downloadError) {
          retryCount++;
          logDownloadEvent({ source: "aio", stage: "media", status: "failed", code: "MEDIA_ERROR" });
          if (retryCount >= maxRetries) {
            throw downloadError;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }

      if (downloadSuccess) {
        imagePaths.push(imagePath);
      }
    }

    for (let i = 0; i < imagePaths.length; i += MAX_IMAGES_PER_MESSAGE) {
      const batch = imagePaths.slice(i, i + MAX_IMAGES_PER_MESSAGE);
      const isFirst = i === 0;
      await api.sendMessage(
        {
          msg: isFirst
            ? `[ ${senderName} ]\n\n👤 Author: ${author || "Unknown"}\n🖼️ Caption: ${title || ""}`
            : `[ ${senderName} ] (${i + 1}-${Math.min(i + MAX_IMAGES_PER_MESSAGE, imagePaths.length)}/${imagePaths.length})`,
          attachments: batch,
          mentions: isFirst ? [MessageMention(senderId, senderName.length, 2, false)] : undefined,
          ttl: 3600000,
        },
        message.threadId,
        message.type
      );
    }
  } finally {
    for (const imagePath of imagePaths) {
      await clearImagePath(imagePath);
    }
  }
}

function selectBestFormatsForPlatform(medias = [], preferQualities = []) {
  if (!Array.isArray(medias) || medias.length === 0) return [];
  const images = medias.filter((item) => String(item?.type || "").toLowerCase() === "image");
  const videos = medias.filter((item) => String(item?.type || "").toLowerCase() === "video");
  const audios = medias.filter((item) => String(item?.type || "").toLowerCase() === "audio");

  let chosenVideos = videos;
  if (preferQualities.length > 0 && videos.length > 1) {
    const preferred = videos.filter((v) => {
      const q = String(v?.quality || "").toLowerCase();
      return preferQualities.some((pq) => q.includes(pq));
    });
    if (preferred.length > 0) {
      chosenVideos = preferred;
    } else {
      chosenVideos = [videos[0]];
    }
  }
  return [...images, ...chosenVideos, ...(images.length === 0 && chosenVideos.length === 0 ? audios : [])];
}

export async function handleDownloadCommand(api, message, aliasCommand, dependencies = {}) {
  const originalApi = api;
  const job = createDownloadJob("hoangdev");
  api = job.wrapApi(api);
  let query, mediaType;
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  try {
    query = extractCommandBody(message, prefix, aliasCommand || "download");
    query = readDownloadLink({ body: query })?.url || query;

    if (!query) {
      await sendMessageWarningRequest(api, message, {
        caption: `Vui lòng nhập link cần tải\nVí dụ:\n${prefix}${aliasCommand} <link>`,
      }, 30000);
      return;
    }

    mediaType = getMediaType(query);
    if (!mediaType) {
      await sendMessageWarningRequest(api, message, {
        caption: `Link này hiện chưa được hỗ trợ tải dữ liệu.`,
      }, 30000);
      return;
    }

    const dataDownload = await job.run("source", () =>
      (dependencies.getDataDownloadVideo || getDataDownloadVideo)(query)
    );
    job.stage = "download";
    if (!dataDownload || dataDownload.error) {
      throw Object.assign(new Error("Invalid AIO response"), { code: "INVALID_RESPONSE" });
    }

    if (mediaType === "tiktok") {
      const normalizedTikTok = normalizeTikTokMedia(dataDownload, "hoangdev");
      if (normalizedTikTok?.kind === "slideshow" && normalizedTikTok.images?.length) {
        await sendTikTokMedia(api, message, normalizedTikTok, {
          job,
          isRandom: false,
          typeVideo: normalizedTikTok.video?.quality || "540p",
        });
        return;
      }
    }

    const dataLink = [];
    let uniqueId;
    const rawMedias = Array.isArray(dataDownload.medias) ? dataDownload.medias : [];
    const mapItem = (item) => ({
      url: item.url,
      ytdlpUrl: item.ytdlpUrl || query,
      useYtDlp: Boolean(item.useYtDlp),
      ytdlpFormat: item.ytdlpFormat || "best[ext=mp4]/best",
      quality: item.quality || item.label || "HD",
      type: item.type || "video",
      title: dataDownload.title || "Media",
      thumbnail: item.thumbnail || dataDownload.thumbnail || "",
      extension: item.extension || item.ext || "mp4",
      voiceUrl: dataDownload.music?.url || dataDownload.voice?.url || null,
    });

    switch (mediaType) {
      case "tiktok":
        uniqueId = (dataDownload.title || dataDownload.url || "unknown").replace(/#\w+/g, (m) => m.toLowerCase());
        selectBestFormatsForPlatform(rawMedias, ["no watermark", "hd"]).forEach((item) => dataLink.push(mapItem(item)));
        break;
      case "douyin":
        uniqueId = sanitizeUniqueId(
          (dataDownload.title || dataDownload.url || "unknown").replace(/#\w+/g, (m) => m.toLowerCase())
        );
        selectBestFormatsForPlatform(rawMedias, ["no watermark", "hd"]).forEach((item) => dataLink.push(mapItem(item)));
        break;
      case "youtube":
        uniqueId = sanitizeUniqueId(extractYoutubeId(dataDownload.url || query));
        rawMedias.forEach((item) => dataLink.push(mapItem(item)));
        break;
      case "facebook":
        uniqueId = extractFacebookId(dataDownload.url || query);
        selectBestFormatsForPlatform(rawMedias, ["hd", "1080", "720"]).forEach((item) => dataLink.push(mapItem(item)));
        break;
      case "threads":
        uniqueId = (dataDownload.author || "") + (dataDownload.title || "") || dataDownload.url || "unknown";
        rawMedias.forEach((item) => dataLink.push({ ...mapItem(item), thumbnail: item.thumbnail || item.url }));
        break;
      case "instagram":
        uniqueId = dataDownload.url || dataDownload.title || "unknown";
        rawMedias.forEach((item) => dataLink.push(mapItem(item)));
        break;
      default:
        uniqueId = (dataDownload.url && dataDownload.url.split("/").pop()) || dataDownload.title || "unknown";
        rawMedias.forEach((item) => dataLink.push(mapItem(item)));
        break;
    }

    uniqueId = sanitizeUniqueId(uniqueId);

    if (dataLink.length === 0) {
      throw Object.assign(new Error("No downloadable formats"), { code: "INVALID_RESPONSE" });
    }

    const images = dataLink.filter((item) => String(item?.type || "").toLowerCase() === "image");
    const voices = dataLink.filter((item) => String(item?.type || "").toLowerCase() === "audio");
    const videos = dataLink.filter((item) => String(item?.type || "").toLowerCase() === "video");
    const others = dataLink.filter(
      (item) => !["image", "audio", "video"].includes(String(item?.type || "").toLowerCase())
    );

    if (images.length > 0) {
      await processAndSendMultipleImages(api, message, images, {
        mediaType,
        uniqueId,
        duration: dataDownload.duration,
        title: dataDownload.title,
        author: dataDownload.author,
        senderId,
        senderName,
      });
    }

    if (voices.length > 0 && videos.length === 0) {
      for (const voice of voices) {
        await processAndSendMedia(
          api,
          message,
          {
            selectedMedia: voice,
            mediaType,
            uniqueId,
            duration: dataDownload.duration,
            title: dataDownload.title,
            author: dataDownload.author,
            senderId,
            senderName,
          },
          true
        );
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
        senderName,
      });
      return;
    }

    let listText = `Đây là danh sách các phiên bản có sẵn:\n`;
    listText += `Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự phiên bản bạn muốn tải!\n\n`;
    listText += remainingItems
      .map((item, index) => `${index + 1}. ${item.type} - ${item.quality || "Unknown"} (${item.extension})`)
      .join("\n");

    const listMessage = await sendMessageCompleteRequest(api, message, { caption: listText }, TIME_WAIT_SELECTION);
    const quotedMsgId = listMessage?.message?.msgId || listMessage?.attachment?.[0]?.msgId;
    const quotedMsgIdStr = quotedMsgId ? quotedMsgId.toString() : "";

    await setSelectionsMapData(senderId, {
      quotedMsgId: quotedMsgIdStr,
      collection: remainingItems,
      uniqueId,
      mediaType,
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
      resendPrompt: async () => sendMessageCompleteRequest(api, message, { caption: listText }, TIME_WAIT_SELECTION),
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
            senderName,
          });
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          job.event(job.stage, "failed", error);
          if (job.canFallback() && ["youtube", "tiktok"].includes(mediaType)) {
            const ok = await (dependencies.runPlatformDownload || runPlatformDownload)(
              originalApi,
              replyMessage,
              query,
              mediaType
            );
            return { ok, claimed: true };
          }
          await sendMessageWarningRequest(
            originalApi,
            replyMessage,
            { caption: downloadFailureCaption("AIO", job.stage, error) },
            30000
          );
          return { ok: false, claimed: true };
        }
      },
    });
  } catch (error) {
    job.event(job.stage, "failed", error);
    if (job.canFallback() && ["youtube", "tiktok"].includes(mediaType)) {
      return (dependencies.runPlatformDownload || runPlatformDownload)(originalApi, message, query, mediaType);
    }
    await sendMessageWarningRequest(
      originalApi,
      message,
      {
        caption: downloadFailureCaption("AIO", job.stage, error),
      },
      30000
    );
  }
}

export async function categoryDownload(api, message, platform, uniqueId, selectedMedia, quality) {
  let qualityVideo;
  let tempFilePath;
  try {
    if (platform === "youtube" && !selectedMedia.url?.startsWith("http")) {
      const { format, qualityText } = getVideoFormatByQuality(quality);
      qualityVideo = qualityText;
      tempFilePath = await downloadYoutubeVideo(selectedMedia.url, uniqueId, format);
    } else if (selectedMedia.useYtDlp) {
      qualityVideo = quality;
      tempFilePath = path.join(tempDir, `${platform}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`);
      tempFilePath = await downloadVideoWithYtDlp(selectedMedia.ytdlpUrl || selectedMedia.url, tempFilePath, {
        format: selectedMedia.ytdlpFormat || "best[ext=mp4]/best",
      });
    } else if (platform === "youtube" && /youtube\.com|youtu\.be/i.test(String(selectedMedia.url))) {
      const { format, qualityText } = getVideoFormatByQuality(quality);
      qualityVideo = qualityText;
      tempFilePath = await downloadYoutubeVideo(selectedMedia.url, uniqueId, format);
    } else {
      qualityVideo = quality;
      tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.${selectedMedia.extension || "mp4"}`);
      if (selectedMedia.extension === "m3u8") {
        tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.mp4`);
        await runFfmpegCopy(selectedMedia.url, tempFilePath);
      } else {
        try {
          await downloadFile(selectedMedia.url, tempFilePath);
        } catch (dlError) {
          if (selectedMedia.ytdlpUrl && resolveYtDlpCommand().available && !/^https?:\/\/127\.0\.0\.1|^http:\/\/localhost/i.test(selectedMedia.url)) {
            await deleteFile(tempFilePath).catch(() => {});
            tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.mp4`);
            tempFilePath = await downloadVideoWithYtDlp(selectedMedia.ytdlpUrl, tempFilePath);
          } else {
            throw dlError;
          }
        }
      }
    }

    if (
      selectedMedia.type !== "audio" &&
      (selectedMedia.type === "video" || !/^(mp3|m4a|aac|ogg|wav|flac|opus)$/i.test(selectedMedia.extension || ""))
    ) {
      const delivery = await uploadPreparedVideo(api, message, tempFilePath);
      return { videoUrl: delivery.fileUrl, tempFilePath, delivery };
    }
    const uploadResult = await api.uploadAttachment([tempFilePath], message.threadId, message.type);
    const videoUrl = ensureUploadResult(uploadResult);
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
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== "downlink") return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch {
    logDownloadEvent({ source: "aio", stage: "media", status: "failed", code: "MEDIA_ERROR" });
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.`,
    }, 30000);
    return true;
  }
}

async function downloadVoiceWithTimeout(url, filepath, timeout = 30000) {
  return downloadFile(url, filepath, { timeout });
}

async function downloadImageWithTimeout(url, filepath, timeout = 30000) {
  return downloadFile(url, filepath, { timeout });
}
