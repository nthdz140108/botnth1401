import { runPlatformDownload, logDownloadEvent } from "../download/download-job.js";
import { ensureUploadResult } from "../youtube/youtube-core.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { promisify } from 'util';
import { exec } from 'child_process';

import { getGlobalPrefix } from "../../service.js";
import { MessageMention } from "../../../api-zalo/index.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../../utils/format-util.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { deleteFile, downloadAndSaveVideo, downloadFile } from "../../../utils/util.js";
import { createSearchResultImage } from "../spotify/search-canvas.js";
import {
  getDataDownloadOriginal,
  getDataDownloadVideo,
  getTikTokMedia,
  getTiktokRelated,
  searchTikTokByKeyword,
  TikTokSearchError,
} from "./tiktok-api.js";
import { tempDir } from "../../../utils/io-json.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import { canContinueReply } from "../../reply-access.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  getSelectionsMapData,
  setSelectionsMapData,
} from "../index.js";
import {
  createDownloadProgress,
  extractMessageId,
} from "../../../utils/interaction-countdown.js";

const PLATFORM = "tiktok";
const TIME_WAIT_SELECTION = 60000;
const RELATED_EXPIRE_TIME = 180000;
const HISTORY_EXPIRE_TIME = 3600000;

const relatedVideosMap = new Map();
const userVideoHistoryMap = new Map();

const headers = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  'Accept': '*/*',
  'Accept-Encoding': 'identity;q=1, *;q=0',
  'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
  ...(process.env.TIKTOK_COOKIE ? { Cookie: process.env.TIKTOK_COOKIE } : {}),
};

const tiktokCleanupTimer = setInterval(() => {
  const currentTime = Date.now();
  for (const [msgId, data] of relatedVideosMap.entries()) {
    if (currentTime - data.timestamp > RELATED_EXPIRE_TIME) {
      relatedVideosMap.delete(msgId);
    }
  }
  for (const [userId, data] of userVideoHistoryMap.entries()) {
    if (currentTime - data.timestamp > HISTORY_EXPIRE_TIME) {
      userVideoHistoryMap.delete(userId);
    }
  }
}, 30 * 1000);
tiktokCleanupTimer.unref?.();

export async function searchVideoTiktok(query) {
  return searchTikTokByKeyword(query, 10);
}

export async function sendTikTokMedia(api, message, media, options = {}) {
  const opts = typeof options === "string" ? { typeVideo: options } : (options || {});
  const isRandom = Boolean(opts.isRandom);
  const typeVideo = opts.typeVideo || "540p";
  // Caption bổ sung (ví dụ dòng "> SendTask HH:05 <" từ lịch sendtask): được
  // chèn trước khối "[ Tên người gửi ]" và bù lại vị trí mention tương ứng.
  const captionPrefix = typeof opts.caption === "string" ? opts.caption.trim() : "";
  const captionBlock = captionPrefix ? `${captionPrefix}\n` : "";
  const senderMentionOffset = 2 + captionBlock.length;
  const senderId = message.data?.uidFrom || message.data?.idFrom || message.senderId;
  const senderName = message.data?.dName || message.senderName || "User";

  const traceDownload = action => opts.job ? opts.job.run('download', action) : action();
  const downloadFileFn = (...args) => traceDownload(() => (opts.downloadFile || downloadFile)(...args));
  const downloadVideoFn = (...args) => traceDownload(() => (opts.downloadVideoTiktok || downloadVideoTiktok)(...args));
  const getCachedMediaFn = opts.getCachedMedia || getCachedMedia;
  const setCacheDataFn = opts.setCacheData || setCacheData;
  const getTiktokRelatedFn = opts.getTiktokRelated || getTiktokRelated;
  const sendVoiceMusicFn = opts.sendVoiceMusic || sendVoiceMusic;
  const deleteFileFn = opts.deleteFile || deleteFile;

  if (!media) {
    throw new Error("Không có dữ liệu media TikTok để gửi");
  }

  const uniqueId = String(media.id || Date.now());
  const description = media.desc || "";
  const isSlideshow = media.kind === "slideshow" || (Array.isArray(media.images) && media.images.length > 0 && !media.video?.url);

  // 1. Audio mode (works for both video and slideshow)
  if (typeVideo === "audio") {
    let tempFilePath = null;
    let progress = null;
    try {
      let voiceUrl = null;
      const cachedVoice = await getCachedMediaFn(PLATFORM, uniqueId, "audio", description);
      if (cachedVoice) {
        voiceUrl = cachedVoice.fileUrl;
      } else {
        if (!isRandom) {
          progress = await createDownloadProgress({
            api,
            message,
            caption: "Chờ bé lấy nhạc một chút, xong bé gọi cho hay!\n📊 Chất lượng: audio",
            ttl: 8000,
          });
        }

        tempFilePath = path.join(tempDir, `tiktok_audio_${uniqueId}_${Date.now()}.mp3`);
        let downloadAudioUrl = media.music?.url;
        if (!downloadAudioUrl) {
          const original = await getDataDownloadOriginal(null, uniqueId);
          if (original?.music?.url) downloadAudioUrl = original.music.url;
        }

        if (!downloadAudioUrl) {
          throw new Error("Không tìm thấy link nhạc TikTok");
        }

        tempFilePath = await downloadFileFn(downloadAudioUrl, tempFilePath);
        const uploadResult = await api.uploadAttachment([tempFilePath], message.threadId, message.type);
        voiceUrl = ensureUploadResult(uploadResult);

        if (voiceUrl) {
          setCacheDataFn(PLATFORM, uniqueId, { fileUrl: voiceUrl, title: description }, "audio");
        }
      }

      if (!voiceUrl) {
        throw new Error("Không thể tải lên nhạc TikTok");
      }

      const object = {
        trackId: uniqueId,
        title: media.music?.title || description || "TikTok",
        artists: media.music?.author || media.author?.nickname || "",
        source: "Tiktok",
        caption: `${captionBlock}> From Tiktok <\nNhạc Bạn Chọn Đâyy!!!`,
        imageUrl: media.music?.cover || (media.images?.[0]?.url) || (media.video?.cover),
        voiceUrl: voiceUrl,
        listen: media.stat?.playCount || 0,
        like: media.stat?.diggCount || 0,
        comment: media.stat?.commentCount || 0,
      };
      await sendVoiceMusicFn(api, message, object, 1800000, { throwOnError: true });
      await progress?.complete();
      return true;
    } catch (error) {
      if (error?.code === "SUBSCRIPTION") {
        await sendMessageWarningRequest(api, message, {
          caption: "RapidAPI TikTok chua duoc subscribe hoac API key khong hop le. Hay subscribe API va tao key moi.",
        }, 30000);
        return false;
      }
      throw error;
    } finally {
      if (tempFilePath) await deleteFileFn(tempFilePath);
      await progress?.complete();
    }
  }

  // 2. Slideshow mode
  if (isSlideshow) {
    const jobDir = path.join(tempDir, `tiktok_slide_${Date.now()}_${uniqueId}_${Math.random().toString(36).slice(2, 7)}`);
    if (!fs.existsSync(jobDir)) {
      fs.mkdirSync(jobDir, { recursive: true });
    }

    let progress = null;
    try {
      if (!isRandom) {
        progress = await createDownloadProgress({
          api,
          message,
          caption: `Chờ bé lấy slideshow ảnh (${media.images.length} ảnh) và nhạc một chút, xong bé gọi cho hay!`,
          ttl: 8000,
        });
      }

      const downloadedImagePaths = [];
      let failedImageCount = 0;

      // Concurrent download of images (bounded to 4), preserving order
      const imageResults = new Array(media.images.length).fill(null);
      const concurrency = 4;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(concurrency, media.images.length) }, async () => {
        while (cursor < media.images.length) {
          const i = cursor++;
          const img = media.images[i];
          if (!img || !img.url) {
            failedImageCount++;
            continue;
          }
          const ext = (img.extension || "jpg").replace(/[^a-zA-Z0-9]/g, "") || "jpg";
          const localPath = path.join(jobDir, `image_${i}.${ext}`);
          try {
            await downloadFileFn(img.url, localPath);
            imageResults[i] = localPath;
          } catch (err) {
            logDownloadEvent({ source: "tiktok", stage: "download", status: "failed", code: "IMAGE_DOWNLOAD" });
            failedImageCount++;
          }
        }
      });
      await Promise.all(workers);
      for (const p of imageResults) {
        if (p) downloadedImagePaths.push(p);
      }

      let lastSentImageMsgId = null;

      // If nothing succeeded at all
      if (downloadedImagePaths.length === 0 && !media.music?.url) {
        throw new Error("Không thể tải ảnh hoặc nhạc của slideshow TikTok");
      }

      // Batching max 5 images per message
      if (downloadedImagePaths.length > 0) {
        const batches = [];
        for (let i = 0; i < downloadedImagePaths.length; i += 5) {
          batches.push(downloadedImagePaths.slice(i, i + 5));
        }

        for (let bIndex = 0; bIndex < batches.length; bIndex++) {
          const batch = batches[bIndex];
          const isFirstBatch = bIndex === 0;
          const isLastBatch = bIndex === batches.length - 1;

          let msgText;
          if (isFirstBatch) {
            msgText =
              captionBlock +
              `[ ${senderName} ]\n` +
              `Author: [${media.author?.uniqueId || ""}] ${media.author?.nickname || ""}\n` +
              `Description: ${description}\n` +
              `📊 Slideshow: ${downloadedImagePaths.length} ảnh\n` +
              `💗 Thả tim để nhận nội dung ngẫu nhiên khác`;
          } else {
            msgText = `[ ${senderName} ] - Slideshow (${bIndex * 5 + 1} - ${Math.min((bIndex + 1) * 5, downloadedImagePaths.length)}/${downloadedImagePaths.length})`;
          }

          const sentMsg = await api.sendMessage({
            msg: msgText,
            attachments: batch,
            mentions: isFirstBatch && senderId ? [MessageMention(senderId, senderName.length, senderMentionOffset, false)] : undefined,
            ttl: 3600000,
          }, message.threadId, message.type);

          if (isLastBatch) {
            lastSentImageMsgId = sentMsg?.msgId || sentMsg?.message?.msgId || sentMsg?.attachment?.[0]?.msgId;
          }
        }
      }

      // Voice sending right below the last batch of images
      let voiceSent = false;
      let voiceErrorOccurred = false;
      let voiceUrl = null;
      if (media.music?.url) {
        try {
          const voiceLocalPath = path.join(jobDir, `music_${Date.now()}.mp3`);
          await downloadFileFn(media.music.url, voiceLocalPath);
          const uploadResult = await api.uploadAttachment([voiceLocalPath], message.threadId, message.type);
          voiceUrl = ensureUploadResult(uploadResult);
        } catch (err) {
          logDownloadEvent({ source: "tiktok", stage: "upload", status: "failed", code: "SLIDESHOW_VOICE" });
          voiceErrorOccurred = true;
        }
      }

      if (downloadedImagePaths.length === 0 && !voiceUrl && !voiceSent) {
        throw new Error("Không thể tải ảnh hoặc nhạc của slideshow TikTok");
      }

      if (voiceUrl) {
        try {
          const object = {
            trackId: uniqueId,
            title: media.music.title || description || "TikTok",
            artists: media.music.author || media.author?.nickname || "",
            source: "Tiktok",
            caption: `> From Tiktok <\nNhạc nền Slideshow Bạn Chọn Đâyy!!!`,
            imageUrl: media.music.cover || media.images?.[0]?.url,
            voiceUrl: voiceUrl,
            listen: media.stat?.playCount || 0,
            like: media.stat?.diggCount || 0,
            comment: media.stat?.commentCount || 0,
          };
          await sendVoiceMusicFn(api, message, object, 1800000, { throwOnError: true });
          voiceSent = true;
        } catch (err) {
          logDownloadEvent({ source: "tiktok", stage: "send", status: "failed", code: "SLIDESHOW_VOICE" });
          voiceErrorOccurred = true;
        }
      }

      await progress?.complete();

      // Warnings reporting
      if (downloadedImagePaths.length === 0 && voiceSent) {
        await sendMessageWarningRequest(api, message, {
          caption: `❌ Toàn bộ ${media.images.length} ảnh không tải được, bé chỉ gửi được nhạc nền!`,
        }, 30000);
      } else if (failedImageCount > 0) {
        await sendMessageWarningRequest(api, message, {
          caption: `⚠️ Một số ảnh trong slideshow không thể tải xuống (${failedImageCount}/${media.images.length} ảnh bị lỗi).`,
        }, 30000);
      } else if (voiceErrorOccurred) {
        await sendMessageWarningRequest(api, message, {
          caption: `⚠️ Không thể tải nhạc nền của slideshow.`,
        }, 30000);
      }

      // Register related videos to the last image message msgId
      if (lastSentImageMsgId) {
        try {
          const relatedVideos = await getTiktokRelatedFn(media.id);
          if (relatedVideos && relatedVideos.length > 0) {
            relatedVideosMap.set(lastSentImageMsgId.toString(), {
              videos: relatedVideos,
              timestamp: Date.now(),
              threadId: message.threadId,
              type: message.type,
              senderId,
              senderName,
            });
          }
        } catch (err) {}
      }

      return true;
    } catch (error) {
      if (error?.code === "SUBSCRIPTION") {
        await sendMessageWarningRequest(api, message, {
          caption: "RapidAPI TikTok chua duoc subscribe hoac API key khong hop le. Hay subscribe API va tao key moi.",
        }, 30000);
        return false;
      }
      throw error;
    } finally {
      await progress?.complete();
      try {
        await fs.promises.rm(jobDir, { recursive: true, force: true });
      } catch (err) {}
    }
  }

  // 3. Regular Video mode
  let tempFilePath = null;
  let progress = null;
  try {
    const cachedVideo = await getCachedMediaFn(PLATFORM, uniqueId, typeVideo, description);
    let videoUrl;

    if (cachedVideo) {
      videoUrl = cachedVideo.fileUrl;
    } else {
      if (!isRandom) {
        progress = await createDownloadProgress({
          api,
          message,
          caption: `Chờ bé lấy video một chút, xong bé gọi cho hay!`,
          ttl: 8000,
        });
      }

      try {
        tempFilePath = await downloadVideoFn(media.video.url);
      } catch (error) {
        const original = await getDataDownloadOriginal(null, uniqueId);
        if (original?.video?.url) {
          tempFilePath = await downloadVideoFn(original.video.url);
        } else {
          throw error;
        }
      }

      const uploadResult = await api.uploadAttachment([tempFilePath], message.threadId, message.type);
      videoUrl = ensureUploadResult(uploadResult);

      if (videoUrl) {
        setCacheDataFn(PLATFORM, uniqueId, { fileUrl: videoUrl, title: description }, typeVideo);
      }
    }

    const sentMessage = await api.sendVideo({
      videoUrl,
      videoAlreadyUploaded: true,
      threadId: message.threadId,
      threadType: message.type,
      thumbnail: media.video.cover,
      localThumbnailSource: tempFilePath || undefined,
      message: {
        text:
          captionBlock +
          `[ ${senderName} ]\n` +
          `Author: [${media.author.uniqueId || media.author.unique_id || ""}] ${media.author.nickname || ""}\n` +
          `Description: ${description}\n` +
          `💗 Thả tim để nhận video ngẫu nhiên khác`,
        mentions: senderId ? [MessageMention(senderId, senderName.length, senderMentionOffset, false)] : undefined,
      },
      ttl: 3600000,
    });

    await progress?.complete();

    try {
      const sentMsgId = sentMessage?.msgId || sentMessage?.message?.msgId || sentMessage?.attachment?.[0]?.msgId;
      const relatedVideos = await getTiktokRelatedFn(media.id);
      if (relatedVideos && relatedVideos.length > 0 && sentMsgId) {
        relatedVideosMap.set(sentMsgId.toString(), {
          videos: relatedVideos,
          timestamp: Date.now(),
          threadId: message.threadId,
          type: message.type,
          senderId,
          senderName,
        });
      }
    } catch (err) {}

    return true;
  } catch (error) {
    if (error?.code === "SUBSCRIPTION") {
      await sendMessageWarningRequest(api, message, {
        caption: "RapidAPI TikTok chua duoc subscribe hoac API key khong hop le. Hay subscribe API va tao key moi.",
      }, 30000);
      return false;
    }
    throw error;
  } finally {
    if (tempFilePath) await deleteFileFn(tempFilePath);
    await progress?.complete();
  }
}

export async function sendTikTokVideo(api, message, videoData, isRandom = false, typeVideo = "540p") {
  return sendTikTokMedia(api, message, videoData, { isRandom, typeVideo });
}

export async function getRandomVideoFromArray(api, message, array) {
  const randomIndex = Math.floor(Math.random() * array.length);
  const randomVideo = array[randomIndex];

  const description = randomVideo.desc;
  const cachedVideo = await getCachedMedia(PLATFORM, description, "540p", description);
  let videoUrl;
  let tempFilePath = null;

  if (cachedVideo) {
    videoUrl = cachedVideo.fileUrl;
  } else {
    try {
      tempFilePath = await downloadAndSaveVideo(randomVideo.video.url);
      const uploadResult = await api.uploadAttachment([tempFilePath], message.threadId, message.type);
      videoUrl = uploadResult[0].fileUrl;
      setCacheData(PLATFORM, description, { fileUrl: videoUrl }, "540p", description);
    } catch (error) {
      throw error;
    } finally {
      deleteFile(tempFilePath);
    }
  }

  return videoUrl;
}

const extractTikTokUrl = (text) => {
  const tiktokRegex = /https?:\/\/((?:vm|vt|www)\.)?tiktok\.com\/[^\s]+/i;
  const match = text.match(tiktokRegex);
  return match ? match[0] : null;
};

export async function consumeTikTokSelection(api, message, options = {}) {
  const { media, modifier, claim, record = null, sendMedia = sendTikTokMedia } = options;

  try {
    const claimed = typeof claim === "function" ? await claim() : true;
    if (!claimed) {
      return { ok: false, claimed: false, handled: false };
    }

    let qualityType = "540p";
    switch (String(modifier || "").toLowerCase()) {
      case "audio":
        qualityType = "audio";
        break;
      default:
        qualityType = media?.video?.quality || "540p";
    }

    const sent = await sendMedia(api, message, media, { typeVideo: qualityType });
    return { ok: sent !== false, claimed: true };
  } catch (error) {
    console.error("Lỗi xử lý lựa chọn TikTok:", error);
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.`,
    }, 30000);
    return { ok: false, claimed: true };
  }
}

export async function handleTikTokCommand(api, message, command) {
  const content = removeMention(message);
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  let imagePath = null;
  let registered = false;

  try {
    const keyword = content.replace(`${prefix}${command}`, "").trim();

    if (!keyword) {
      const object = {
        caption: `Vui lòng nhập từ khóa tìm kiếm hoặc link tiktok\nVí dụ:\n${prefix}${command} nội dung cần tìm`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const [query, typeVideo = "normal"] = keyword.split(" ");

    const tiktokUrl = extractTikTokUrl(query);
    if (tiktokUrl) {
      await runPlatformDownload(api, message, tiktokUrl, "tiktok", { typeVideo });
      return;
    }

    const videos = await searchTikTokByKeyword(keyword, 10);

    if (videos && videos.length > 0) {
      let videoListText = "Đây là danh sách video tôi tìm thấy:\n";
      videoListText += `Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự video bạn muốn xem!`;
      videoListText += `\nVD: 1 hoặc 1 audio`;

      imagePath = await createSearchResultImage(videos.map(video => ({
        title: video.desc || "No description",
        artistsNames: `${video.author.nickname} (@${video.author.uniqueId || video.author.unique_id})`,
        thumbnailM: video.video.cover,
        listen: video.stat.playCount || 0,
        like: video.stat.diggCount || 0,
        comment: video.stat.commentCount || 0
      })));

      const object = {
        caption: videoListText,
        imagePath: imagePath,
      };
      const listMessage = await sendMessageCompleteRequest(api, message, object, TIME_WAIT_SELECTION);

      const quotedMsgIdStr = extractMessageId(listMessage);

      // Preview temp thuộc sở hữu session; chỉ xóa đúng một lần khi kết thúc.
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
        seconds: Math.floor(TIME_WAIT_SELECTION / 1000) || 60,
        ownedTempPaths: imagePath ? [imagePath] : [],
        resendPrompt: async () => sendMessageCompleteRequest(api, message, {
          caption: videoListText,
          imagePath: imagePath,
        }, TIME_WAIT_SELECTION),
        onSelect: async (media, index, modifier, replyMessage, claim) => {
          const record = findSelectionRecordForMessage(replyMessage) ||
            getSelectionsMapData().get(senderId);
          return await consumeTikTokSelection(api, replyMessage, {
            media,
            modifier,
            claim,
            record,
          });
        },
      });
      registered = true;
    } else {
      const object = {
        caption: `Không tìm được video phù hợp.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
    }
  } catch (error) {
    const code = error?.code || "";
    let caption = "Đã xảy ra lỗi khi tìm kiếm video TikTok, vui lòng thử lại sau.";
    if (code === "MISSING_DEPENDENCY") {
      caption = "Chức năng tìm kiếm TikTok chưa được cấu hình (thiếu TIKTOK_SEARCH_API_URL hoặc TIKTOK_SEARCH_API_KEY trong .env.local).";
    } else if (code === "SUBSCRIPTION") {
      caption = "Khóa API tìm kiếm TikTok không hợp lệ hoặc đã hết hạn/hết lượt truy cập (401/403).";
    } else if (code === "TIMEOUT") {
      caption = "Hết thời gian chờ phản hồi từ máy chủ tìm kiếm TikTok. Vui lòng thử lại sau.";
    } else if (code === "PROVIDER") {
      caption = "Máy chủ cung cấp dịch vụ tìm kiếm TikTok gặp sự cố. Vui lòng thử lại sau.";
    } else if (code === "INVALID_RESPONSE") {
      caption = "Dữ liệu trả về từ dịch vụ tìm kiếm TikTok không đúng định dạng.";
    } else if (String(error?.message).includes("canvas") || String(error?.stack).includes("createSearchResultImage")) {
      caption = "Lỗi khi tạo hình ảnh danh sách kết quả tìm kiếm.";
    }
    logDownloadEvent({ source: "tiktok-search", stage: "source", status: "failed", code: /^[A-Z_]+$/.test(code) ? code : "UNKNOWN" });
    const object = { caption };
    await sendMessageWarningRequest(api, message, object, 30000);
  } finally {
    if (imagePath && !registered) deleteFile(imagePath);
  }
}

export async function handleTikTokReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Lỗi xử lý reply TikTok:", error);
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
    return true;
  }
}

export async function downloadVideoTiktok(videoUrl) {
  const videoResponse = await axios.get(videoUrl, {
    headers: {
      ...headers,
    },
    responseType: "arraybuffer",
    maxRedirects: 5,
    timeout: 30000,
  });

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const tempFilePath = path.join(tempDir, `tiktok_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`);
  fs.writeFileSync(tempFilePath, videoResponse.data);

  return tempFilePath;
}

function getUnseenVideo(videos, userId) {
  if (!userVideoHistoryMap.has(userId)) {
    userVideoHistoryMap.set(userId, {
      videoIds: new Set(),
      timestamp: Date.now()
    });
  }

  const userHistory = userVideoHistoryMap.get(userId);
  const unseenVideos = videos.filter(video => !userHistory.videoIds.has(video.id));

  if (unseenVideos.length === 0) {
    userHistory.videoIds.clear();
    return videos[Math.floor(Math.random() * videos.length)];
  }

  const randomVideo = unseenVideos[Math.floor(Math.random() * unseenVideos.length)];
  userHistory.videoIds.add(randomVideo.id);
  userHistory.timestamp = Date.now();

  return randomVideo;
}

export async function handleTikTokReaction(api, reaction) {
  try {
    const msgId = reaction.data?.content?.rMsg?.[0]?.gMsgID?.toString();
    if (!msgId || !relatedVideosMap.has(msgId)) return false;

    const relatedData = relatedVideosMap.get(msgId);
    const senderId = reaction.data.uidFrom;
    if (senderId !== relatedData.senderId) return false;

    const rType = reaction.data.content.rType;
    if (rType !== 5) return false;
    relatedVideosMap.delete(msgId);
    const { videos, threadId, type, senderId: senderIdOriginal, senderName: senderNameOriginal } = relatedData;

    const randomMedia = getUnseenVideo(videos, senderIdOriginal);
    if (!randomMedia) return false;

    const reactionMessage = {
      threadId,
      type,
      data: {
        uidFrom: senderIdOriginal,
        dName: senderNameOriginal,
      },
    };

    const typeVideo = randomMedia.video?.quality || "540p";
    await sendTikTokMedia(api, reactionMessage, randomMedia, { isRandom: true, typeVideo });
    return true;
  } catch (error) {
    console.error("Lỗi khi xử lý reaction TikTok:", error);
    return false;
  }
}
