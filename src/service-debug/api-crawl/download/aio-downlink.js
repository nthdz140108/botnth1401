import { platformFromUrl, readDownloadLink } from "../download/download-input.js";
import { logDownloadEvent, downloadErrorCode } from './download-job.js';
import { uploadPreparedVideo, videoPayload, isCompleteVideoCache } from "../download/video-delivery.js";
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
import { capitalizeEachWord, removeMention } from "../../../utils/format-util.js";
import { setSelectionsMapData, deleteSelectionsMapData } from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { clearImagePath } from "../../../utils/canvas/index.js";
import { getFfmpegExecutableSync, getFfprobeExecutableSync } from "../../../utils/runtime-dependencies.js";
import { tempDir } from "../../../utils/io-json.js";
import { getBotId } from "../../../index.js";
import { canContinueReply } from "../../reply-access.js";
import { normalizeTikTokMedia } from "../tiktok/tiktok-api.js";
import { sendTikTokMedia } from "../tiktok/tiktok-service.js";
import {
  createDownloadProgress,
  openMediaSelection,
  completeInteractionCountdown,
  recallBotMessage,
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
export const API_URL_INSTAGRAM_THREADS = "https://kemapis.eu.org/api/instagram/media";
export const API_URL_OTHER_PLATFORMS = "https://api.zeidteam.xyz/media-downloader/atd2";

export const MEDIA_TYPES = {
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

export const getMediaType = (text) => readDownloadLink({ body: String(text || "") })?.platform || platformFromUrl(text);

const extractFacebookId = (url) => {
  let uniqueId;
  if (typeof url === "string") {
    if (url.includes("/v/")) uniqueId = url.split("/v/")[1];
    if (url.includes("/r/")) uniqueId = url.split("/r/")[1];
    if (uniqueId) uniqueId = uniqueId.replace("/", '');
    if (!uniqueId) uniqueId = url;
  } else {
    uniqueId = "unknown_" + Date.now();
  }
  return sanitizeUniqueId(uniqueId);
};

export const getDurationVideo = async (path) => {
  try {
    return await readDurationMs(path);
  } catch (error) {
    return 0;
  }
};

export const getDataDownloadVideo = async (url) => {
  const isFacebook = /facebook\.com|fb\.com/.test(url);
  const candidates = isFacebook
    ? [
        {
          name: "hoangdev",
          request: `${API_URL_DOWNAIO_HOANGDEV}?apikey=${API_KEY_HOANGDEV}&url=${encodeURIComponent(url)}`,
        },
        {
          name: "zeidteam",
          request: `${API_URL_OTHER_PLATFORMS}?url=${encodeURIComponent(url)}`,
        },
      ]
    : /instagram\.com|threads\.net|threads\.com/.test(url)
      ? [
          {
            name: "instagram-threads",
            request: `${API_URL_INSTAGRAM_THREADS}?url=${encodeURIComponent(url)}`,
          },
          {
            name: "hoangdev",
            request: `${API_URL_DOWNAIO_HOANGDEV}?apikey=${API_KEY_HOANGDEV}&url=${encodeURIComponent(url)}`,
          },
        ]
      : [
          {
            name: "hoangdev",
            request: `${API_URL_DOWNAIO_HOANGDEV}?apikey=${API_KEY_HOANGDEV}&url=${encodeURIComponent(url)}`,
          },
          {
            name: "zeidteam",
            request: `${API_URL_OTHER_PLATFORMS}?url=${encodeURIComponent(url)}`,
          },
        ];

  for (const candidate of candidates) {
    if (candidate.name === "hoangdev" && !API_KEY_HOANGDEV) {
      continue; // Bỏ qua hoangdev nếu chưa cấu hình HOANGDEV_API_KEY, chuyển sang nguồn dự phòng
    }
    try {
      const response = await axios.get(candidate.request, {
        timeout: 20000,
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (candidate.name === "hoangdev") {
        if (response.data && response.data.success && response.data.data) {
          return response.data.data;
        }
      } else {
        const data = response.data;
        if (data && Array.isArray(data.medias) && data.medias.length > 0) {
          return data;
        }
      }

      console.error(`[download] API ${candidate.name} không trả về dữ liệu hợp lệ`);
    } catch (error) {
      logDownloadEvent({ source: candidate.name, stage: "source", status: "failed", code: downloadErrorCode(error) });
    }
  }

  return null;
};// Các hàm còn lại giữ nguyên
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

const downloadSelectionsMap = new Map();
const TIME_WAIT_SELECTION = 60000;

async function downloadImageWithTimeout(url, filepath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Download timeout'));
    }, timeout);

    const response = axios({
      url,
      method: "GET",
      responseType: "stream",
      timeout: timeout,
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
        "Referer": "https://www.tiktok.com/",
      },
    });

    response.then(res => {
      const writer = fs.createWriteStream(filepath);
      res.data.pipe(writer);
      
      writer.on("finish", () => {
        clearTimeout(timeoutId);
        resolve(filepath);
      });
      
      writer.on("error", (error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
    }).catch(error => {
      clearTimeout(timeoutId);
      reject(error);
    });
  });
}

async function processAndSendMultipleImages(api, message, images, mediaData) {
  const {
    mediaType,
    uniqueId,
    title,
    author,
    senderId,
    senderName
  } = mediaData;

  const imagePaths = [];
  const maxImagesPerMessage = 5;
  const safeUniqueId = sanitizeUniqueId(uniqueId);

  try {
    for (let i = 0; i < images.length; i++) {
      const image = images[i];
      if (!image?.url || !image?.extension) continue;
      const imagePath = path.resolve(tempDir, `${safeUniqueId}_${Date.now()}_${i}.${image.extension}`);
      
      let retryCount = 0;
      const maxRetries = 3;
      let downloadSuccess = false;
      
      while (retryCount < maxRetries && !downloadSuccess) {
        try {
          await downloadImageWithTimeout(image.url, imagePath, 30000);
          if (fs.existsSync(imagePath)) {
            downloadSuccess = true;
            imagePaths.push(imagePath);
          }
        } catch (downloadError) {
          retryCount++;
          logDownloadEvent({ source: "aio", stage: "download", status: "failed", code: downloadErrorCode(downloadError) });
          if (retryCount >= maxRetries) {
            continue;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (imagePaths.length > 0) {
      for (let i = 0; i < imagePaths.length; i += maxImagesPerMessage) {
        const chunk = imagePaths.slice(i, i + maxImagesPerMessage);
        await api.sendMessage({
          msg: `[ ${senderName} ]\n\n👤 Tác giả: ${author || "Không rõ"}\n🖼️ Tiêu đề: ${title || "Không có tiêu đề"}`,
          attachments: chunk,
          mentions: [MessageMention(senderId, senderName.length, 2, false)],
          ttl: 3600000,
        }, message.threadId, message.type);
      }
    } else {
      await api.sendMessage({
        msg: `Không tải được bất kỳ ảnh nào từ link này. Có thể link không chứa ảnh hoặc API gặp lỗi.`,
        ttl: 30000,
      }, message.threadId, message.type);
    }
  } catch (error) {
    await api.sendMessage({
      msg: `Lỗi khi xử lý ảnh: ${error.message}`,
      ttl: 30000,
    }, message.threadId, message.type);
  } finally {
    for (const imagePath of imagePaths) {
      try {
        await clearImagePath(imagePath);
      } catch (cleanupError) {
        console.warn("Không thể xóa file tam thoi:", cleanupError.message);
      }
    }
  }
}

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

    try {
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
            logDownloadEvent({ source: "aio", stage: "download", status: "failed", code: downloadErrorCode(downloadError) });
            if (retryCount >= maxRetries) {
              throw downloadError;
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      }

      await api.sendMessage({
        msg: `[ ${senderName} ]\n\n👤 Author: ${author}\n🖼️ Caption: ${title}`,
        attachments: [thumbnailPath],
        mentions: [MessageMention(senderId, senderName.length, 2, false)],
        ttl: 3600000,
      }, message.threadId, message.type);
    } finally {
      if (thumbnailUrl) {
        await clearImagePath(thumbnailPath);
      }
    }
    return;
  }

  if ((mediaType === "youtube" || mediaType === "instagram") && duration) {
    if (duration * 1000 > 60 * 60 * 1000) {
      const object = {
        caption: "Vì tài nguyên có hạn, Không thể lấy video có độ dài hơn 60 phút!\nVui lòng chọn video khác.",
      };
      return await sendMessageWarningRequest(api, message, object, 30000);
    }
  }

  const cachedMedia = await getCachedMedia(mediaType, safeUniqueId, quality, title);
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

      const downloaded = await categoryDownload(api, message, mediaType, safeUniqueId, selectedMedia, quality);
      delivery = downloaded?.delivery;
      videoUrl = typeof downloaded === "string" ? downloaded : downloaded?.videoUrl;
      operationTempPath = typeof downloaded === "object" ? downloaded?.tempFilePath || null : null;
      if (!videoUrl) {
        const object = {
          caption: `Không tải được dữ liệu video ${quality}. Vui lòng thử lại sau.`,
        };
        await sendMessageWarningRequest(api, message, object, 30000);
        return;
      }
    }

    if (typeFile === "video") {
      await api.sendVideo({
        ...videoPayload(delivery),
        threadId: message.threadId,
        threadType: message.type,
        message: {
          text:
            `[ ${senderName} ]\n` +
            `🎥 Nền Tảng: ${capitalizeEachWord(mediaType)}\n` +
            `👤 Author: ${author || "Không rõ"}\n` +
            `📼 Caption: ${title || "Không có tiêu đề"}\n` +
            `📊 Chất lượng: ${quality}`,
          mentions: [MessageMention(senderId, senderName.length, 2, false)],
        },
        ttl: 3600000,
      });
      await setCacheData(mediaType, safeUniqueId, { ...delivery, title }, quality);
    } else if (typeFile === "audio" && mediaType !== "tiktok") {
      try {
        await progress?.complete();
        await api.sendVoice(message, videoUrl, 3600000);
      } catch (error) {
        logDownloadEvent({ source: "aio", stage: error.stage || "send", status: "failed", code: downloadErrorCode(error) });
        await api.sendMessage({
          msg: `Không thể tải audio từ ${capitalizeEachWord(mediaType)}`,
          ttl: 30000,
        }, message.threadId, message.type);
      }
    }
  } finally {
    await progress?.complete();
    if (operationTempPath) {
      await deleteFile(operationTempPath).catch(() => {});
    }
  }
}

function getPrimaryMediaItem(images, videos, voices, others) {
  if (images.length > 0) return images[0];
  if (videos.length > 0) return videos[0];
  if (voices.length > 0) return voices[0];
  if (others.length > 0) return others[0];
  return null;
}

export async function handleDownloadCommand(api, message, aliasCommand) {
  const content = removeMention(message).trim();
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  try {
    const query = content.replace(`${prefix}${aliasCommand}`, "").trim();
    if (!query) {
      const object = {
        caption: `Vui lòng nhập link cần tải\nVí dụ:\n${prefix}${aliasCommand} <link>`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    return await handleDownloadUrl(api, message, query, senderId, senderName);
  } catch (error) {
    logDownloadEvent({ source: "aio", stage: error.stage || "send", status: "failed", code: downloadErrorCode(error) });
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý lệnh tải dữ liệu: ${error.message}`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
  }
}

export async function handleDownloadUrl(api, message, query, senderId, senderName) {
  try {
    const mediaType = getMediaType(query);
    if (!mediaType) {
      const object = {
        caption: `Link không được hỗ trợ. Vui lòng thử link từ các nền tảng được hỗ trợ.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    let dataDownload = await getDataDownloadVideo(query);
    if (!dataDownload || dataDownload.error) {
      const hint = !API_KEY_HOANGDEV ? " (Lưu ý: HOANGDEV_API_KEY chưa cấu hình và nguồn dự phòng không phản hồi)" : "";
      const object = {
        caption: `Link không hợp lệ hoặc máy chủ tải dữ liệu hiện không phản hồi${hint}. Vui lòng thử lại sau.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    if (mediaType === "tiktok") {
      const normalizedTikTok = normalizeTikTokMedia(dataDownload, "hoangdev");
      if (normalizedTikTok) {
        await sendTikTokMedia(api, message, normalizedTikTok, { isRandom: false, typeVideo: normalizedTikTok.video?.quality || "540p" });
        return;
      }
    }

    const dataLink = [];
    let uniqueId;

    switch (mediaType) {
      case "facebook":
        uniqueId = extractFacebookId(dataDownload.url);
        (dataDownload.medias || []).forEach((item) => {
          const itemType = String(item?.type || "").toLowerCase();
          const itemQuality = String(item?.quality || "").toLowerCase();
          if (itemType === "image" || (itemType === "video" && itemQuality === "hd")) {
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
      case "tiktok":
        uniqueId = sanitizeUniqueId((dataDownload.title || dataDownload.url || "unknown").replace(/#\w+/g, (match) => match.toLowerCase()));
        (dataDownload.medias || []).forEach((item) => {
          const itemType = String(item?.type || "").toLowerCase();
          const itemQuality = String(item?.quality || "").toLowerCase();
          if (itemType === "video" && (itemQuality === "hd" || itemQuality === "no watermark" || itemQuality === "hd_no_watermark")) {
            dataLink.push({
              url: item.url,
              quality: item.quality,
              type: item.type,
              title: dataDownload.title,
              thumbnail: item.thumbnail || dataDownload.thumbnail,
              extension: item.extension,
            });
          }
        });
        (dataDownload.medias || []).forEach((item) => {
          const itemType = String(item?.type || "").toLowerCase();
          if (itemType !== "video" && itemType !== "audio") {
            dataLink.push({
              url: item.url,
              quality: item.quality,
              type: item.type,
              title: dataDownload.title,
              thumbnail: item.thumbnail || dataDownload.thumbnail,
              extension: item.extension,
            });
          }
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
        uniqueId = extractFacebookId(dataDownload.url);
        dataDownload.medias.forEach((item) => {
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
      const object = {
        caption: `Không tìm thấy dữ liệu tải về phù hợp cho link này!\nVui lòng thử lại với link khác.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const images = dataLink.filter(item => String(item?.type || "").toLowerCase() === 'image');
    const videos = dataLink.filter(item => String(item?.type || "").toLowerCase() === 'video');
    const voices = dataLink.filter(item => String(item?.type || "").toLowerCase() === 'audio');
    const others = dataLink.filter(item => !['image', 'audio', 'video'].includes(String(item?.type || "").toLowerCase()));

    const primaryMedia = getPrimaryMediaItem(images, videos, voices, others);
    if (!primaryMedia) {
      const object = {
        caption: `Không tìm thấy dữ liệu tải về phù hợp cho link này!\nVui lòng thử lại với link khác.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    await processAndSendMedia(api, message, {
      selectedMedia: primaryMedia,
      mediaType,
      uniqueId,
      duration: dataDownload.duration,
      title: dataDownload.title,
      author: dataDownload.author,
      senderId,
      senderName
    });
  } catch (error) {
    logDownloadEvent({ source: "aio", stage: error.stage || "send", status: "failed", code: downloadErrorCode(error) });
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý link tải dữ liệu: ${error.message}`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
  }
}

export async function categoryDownload(api, message, platform, uniqueId, selectedMedia, quality) {
  let qualityVideo;
  let tempFilePath;
  try {
    await fs.promises.access(tempDir, fs.constants.W_OK).catch(() => {
      throw new Error(`Không có quyền ghi vào thư mục tạm: ${tempDir}`);
    });

    if (selectedMedia.extension === 'm3u8') {
      if (!getFfmpegExecutableSync()) {
        throw new Error('FFmpeg không được cài đặt hoặc không thể truy cập');
      }
    }

    qualityVideo = quality;
    tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.${selectedMedia.extension}`);
    if (selectedMedia.extension === 'm3u8') {
      tempFilePath = path.join(tempDir, `${platform}_${Date.now()}.mp4`);
      await runFfmpegCopy(selectedMedia.url, tempFilePath);
    } else {
      let retryCount = 0;
      const maxRetries = 3;
      let downloadSuccess = false;

      while (retryCount < maxRetries && !downloadSuccess) {
        try {
          await downloadFile(selectedMedia.url, tempFilePath, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
              "Referer": "https://www.tiktok.com/",
            },
          });
          downloadSuccess = true;
        } catch (downloadError) {
          retryCount++;
          logDownloadEvent({ source: platform, stage: "download", status: "failed", code: "DOWNLOAD_FAILED" });
          if (retryCount >= maxRetries) {
            throw downloadError;
          }
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
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
    if (tempFilePath) await deleteFile(tempFilePath).catch(() => {});
    logDownloadEvent({ source: platform, stage: error.stage || "download", status: "failed", code: "MEDIA_ERROR" });
    return null;
  }
}

export async function handleDownloadReply(api, message) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const idBot = getBotId();

  try {
    if (!message.data.quote || !message.data.quote.globalMsgId) return false;

    const quotedMsgId = message.data.quote.globalMsgId.toString();
    if (!downloadSelectionsMap.has(quotedMsgId)) return false;

    const downloadData = downloadSelectionsMap.get(quotedMsgId);
    const replyState = {
      userRequest: downloadData.userRequest,
      replyAccess: "public",
      threadId: downloadData.threadId,
    };
    if (!canContinueReply(replyState, senderId, message.threadId)) return false;

    const content = removeMention(message);
    const [selection] = content.split(" ");
    const selectedIndex = parseInt(selection) - 1;

    if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= downloadData.collection.length) {
      const object = {
        caption: `Lựa chọn không hợp lệ. Vui lòng chọn một số từ danh sách (1-${downloadData.collection.length}).`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return true;
    }

    if (downloadData.selectionSession?.claim) {
      await downloadData.selectionSession.claim();
    } else {
      completeInteractionCountdown(`download_${quotedMsgId}`);
      const msgDel = {
        type: message.type,
        threadId: message.threadId,
        data: {
          cliMsgId: message.data.quote.cliMsgId,
          msgId: message.data.quote.globalMsgId,
          uidFrom: idBot,
        },
      };
      await recallBotMessage({ api, message: msgDel }).catch(() => {});
    }
    downloadSelectionsMap.delete(quotedMsgId);
    deleteSelectionsMapData(senderId);

    await processAndSendMedia(api, message, {
      selectedMedia: downloadData.collection[selectedIndex],
      mediaType: downloadData.mediaType,
      uniqueId: downloadData.uniqueId,
      duration: downloadData.duration,
      title: downloadData.title,
      author: downloadData.author,
      senderId,
      senderName
    });

    return true;
  } catch (error) {
    logDownloadEvent({ source: "aio", stage: error.stage || "send", status: "failed", code: downloadErrorCode(error) });
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn: ${error.message}`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
    return true;
  }
}
