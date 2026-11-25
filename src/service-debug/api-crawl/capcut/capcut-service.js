import axios from "axios";
import crypto from "node:crypto";
import path from "node:path";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { downloadAndSaveVideo, deleteFile } from "../../../utils/util.js";
import { createSearchResultImage } from "../../../utils/canvas/search-canvas.js";
import { canContinueReply } from "../../reply-access.js";
import { createDownloadProgress } from "../../../utils/interaction-countdown.js";
import { uploadPreparedVideo, videoPayload, isCompleteVideoCache } from "../download/video-delivery.js";
import { tempDir } from "../../../utils/io-json.js";
import {
  downloadVideoWithYtDlp,
  resolveYtDlpCommand,
  runYtDlpJson,
} from "../youtube/youtube-runtime.js";
import { searchTikTokByKeyword, searchTikTokFallback } from "../tiktok/tiktok-api.js";

const PLATFORM = "capcut";
const CONFIG = {
  maxResults: 10,
  timeWaitSelection: 60000,
};

function extractCapcutUrl(text) {
  const match = String(text || "").match(
    /https?:\/\/(?:(?:www|m|vt|vm)\.)?(?:capcut\.com|capcutshare\.com)\/[^\s]+/i
  );
  return match ? match[0] : null;
}

async function extractDirectCapcutTemplate(url) {
  // 1. Try yt-dlp CapCut extractor
  if (resolveYtDlpCommand().available) {
    try {
      const info = await runYtDlpJson(url);
      if (info && (info.url || info.webpage_url || info.formats?.length)) {
        const directMp4 =
          info.formats?.find((f) => f?.ext === "mp4" && f?.url && f?.acodec !== "none" && f?.vcodec !== "none")?.url ||
          info.url ||
          "";
        return {
          id: String(info.id || crypto.createHash("md5").update(url).digest("hex").slice(0, 12)),
          title: info.title || info.description || "CapCut Template",
          author: { nickname: info.uploader || info.creator || "CapCut Creator" },
          cover_url: info.thumbnail || info.thumbnails?.[0]?.url || "",
          video_url: directMp4 || url,
          useYtDlp: !directMp4 || !/^https?:\/\//i.test(directMp4),
          template_url: info.webpage_url || url,
          duration: (Number(info.duration) || 0) * 1000,
          play_amount: info.view_count || 0,
          like_count: info.like_count || 0,
          usage_amount: info.repost_count || 0,
        };
      }
    } catch {}
  }

  // 2. Fallback: follow redirects and inspect SSR JSON on capcut.com
  try {
    const res = await axios.get(url, {
      timeout: 12000,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Referer: "https://www.capcut.com/",
      },
    });
    const html = String(res.data || "");
    const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/) || html.match(/"play_url"\s*:\s*"([^"]+)"/);
    const coverMatch = html.match(/"cover_url"\s*:\s*"([^"]+)"/) || html.match(/property="og:image"\s+content="([^"]+)"/);
    const titleMatch = html.match(/"short_title"\s*:\s*"([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/i);
    if (videoMatch?.[1]) {
      const cleanVideoUrl = JSON.parse(`"${videoMatch[1]}"`);
      const cleanCoverUrl = coverMatch?.[1] ? JSON.parse(`"${coverMatch[1]}"`) : "";
      return {
        id: crypto.createHash("md5").update(url).digest("hex").slice(0, 12),
        title: titleMatch?.[1]?.trim() || "CapCut Template",
        author: { nickname: "CapCut Creator" },
        cover_url: cleanCoverUrl,
        video_url: cleanVideoUrl,
        useYtDlp: false,
        template_url: url,
        duration: 0,
        play_amount: 0,
        like_count: 0,
        usage_amount: 0,
      };
    }
  } catch {}

  return null;
}

export const searchCapcut = async (query, limit = CONFIG.maxResults) => {
  const boundedLimit = Math.min(12, Math.max(1, parseInt(limit, 10) || CONFIG.maxResults));
  const searchKeyword = `capcut template ${query}`.trim();

  // 1. Try TikTok search API if configured or TikTok fallback
  try {
    let ttVideos = [];
    try {
      ttVideos = await searchTikTokByKeyword(searchKeyword, boundedLimit);
    } catch {
      ttVideos = await searchTikTokFallback(searchKeyword, boundedLimit);
    }
    if (Array.isArray(ttVideos) && ttVideos.length > 0) {
      return ttVideos.slice(0, boundedLimit).map((item) => ({
        id: String(item.id),
        title: item.desc || `CapCut: ${query}`,
        author: { nickname: item.author?.nickname || item.author?.uniqueId || "CapCut Creator" },
        cover_url: item.video?.cover || "",
        video_url: item.video?.url || "",
        useYtDlp: Boolean(item.video?.useYtDlp),
        template_url: item.webpageUrl || `https://www.tiktok.com/@${item.author?.uniqueId || "capcut"}/video/${item.id}`,
        duration: item.video?.duration || 0,
        play_amount: item.stat?.playCount || 0,
        like_count: item.stat?.diggCount || 0,
        usage_amount: item.stat?.shareCount || 0,
      }));
    }
  } catch {}

  // 2. Universal yt-dlp dynamic search fallback
  if (resolveYtDlpCommand().available) {
    try {
      const raw = await runYtDlpJson(`ytsearch${Math.min(boundedLimit, 8)}:${searchKeyword}`, {
        flatPlaylist: true,
        skipDownload: true,
      });
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      const mapped = entries
        .filter((e) => e?.id && e?.title)
        .map((e) => {
          const pageUrl = e.webpage_url || `https://www.youtube.com/watch?v=${e.id}`;
          return {
            id: String(e.id),
            title: e.title,
            author: { nickname: e.channel || e.uploader || "CapCut Creator" },
            cover_url: e.thumbnail || e.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
            video_url: pageUrl,
            useYtDlp: true,
            template_url: pageUrl,
            duration: (Number(e.duration) || 0) * 1000,
            play_amount: e.view_count || 0,
            like_count: e.like_count || 0,
            usage_amount: 0,
          };
        });
      if (mapped.length > 0) return mapped;
    } catch {}
  }

  const unavailableResult = [];
  Object.defineProperty(unavailableResult, "unavailable", {
    value: !resolveYtDlpCommand().available,
    enumerable: false,
  });
  return unavailableResult;
};

export async function handleCapcutCommand(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  const commandContent = extractCommandBody(message, prefix, aliasCommand || "capcut");
  const [rawKeyword, numberTemplate] = commandContent.split("&&");
  const keyword = String(rawKeyword || "").trim();
  let imagePath;
  let registered = false;

  try {
    if (!keyword) {
      return await sendMessageCompleteRequest(api, message, {
        caption: `Vui lòng nhập từ khóa hoặc dán link mẫu CapCut\nVí dụ:\n${prefix}${aliasCommand} mẫu trend biến hình\n${prefix}${aliasCommand} https://www.capcut.com/t/...`,
      }, 30000);
    }

    const directCapcutUrl = extractCapcutUrl(keyword);
    if (directCapcutUrl) {
      const template = await extractDirectCapcutTemplate(directCapcutUrl);
      if (!template) {
        return await sendMessageWarningRequest(api, message, {
          caption: !resolveYtDlpCommand().available
            ? "Chưa thể giải mã link CapCut vì thiếu công cụ yt-dlp trong .runtime/bin."
            : "Link mẫu CapCut không hợp lệ hoặc không thể lấy video từ link này.",
        }, 30000);
      }
      return await handleSendTemplateCapcut(api, message, template);
    }

    const limit = Math.min(12, Math.max(1, parseInt(numberTemplate, 10) || CONFIG.maxResults));
    const searchResults = await searchCapcut(keyword, limit);

    if (searchResults.unavailable) {
      return await sendMessageWarningRequest(api, message, {
        caption: `Chức năng tìm kiếm mẫu CapCut cần công cụ yt-dlp (.runtime/bin/yt-dlp) hoặc cấu hình tìm kiếm video.`,
      }, 30000);
    }

    if (searchResults.length === 0) {
      return await sendMessageWarningRequest(api, message, {
        caption: `Không tìm thấy template phù hợp với cụm từ: ${keyword}`,
      }, 30000);
    }

    const templates = searchResults.map((template) => ({
      title: template.title,
      artistsNames: template.author?.nickname || "CapCut Creator",
      thumbnailM: template.cover_url,
      view: template.play_amount,
      like: template.like_count,
      usage: template.usage_amount,
    }));

    imagePath = await createSearchResultImage(templates);

    const listCaption = `Đây là kết quả tìm kiếm template CapCut của bạn.\nReply tin nhắn này HOẶC gửi trực tiếp số thứ tự để chọn template.`;

    const searchResultMessage = await sendMessageCompleteRequest(api, message, {
      caption: listCaption,
      imagePath,
    }, CONFIG.timeWaitSelection);

    const quotedMsgId = searchResultMessage?.message?.msgId || searchResultMessage?.attachment?.[0]?.msgId;
    const quotedMsgIdStr = quotedMsgId ? quotedMsgId.toString() : "";

    await setSelectionsMapData(senderId, {
      quotedMsgId: quotedMsgIdStr,
      collection: searchResults,
      platform: PLATFORM,
      replyAccess: "public",
      api,
      sentMessage: searchResultMessage,
      messageContext: message,
      threadId: message.threadId,
      type: message.type,
      seconds: Math.floor(CONFIG.timeWaitSelection / 1000) || 60,
      ownedTempPaths: imagePath ? [imagePath] : [],
      resendPrompt: async () =>
        sendMessageCompleteRequest(api, message, {
          caption: listCaption,
          imagePath,
        }, CONFIG.timeWaitSelection),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTemplateCapcut(api, replyMessage, media);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error("Lỗi gửi template CapCut:", error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption: "Đã xảy ra lỗi khi tải template CapCut. Vui lòng chọn mẫu khác.",
          }, 30000);
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;
  } catch (error) {
    console.error("Lỗi khi xử lý tìm kiếm CapCut:", error);
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi tìm kiếm template CapCut, vui lòng thử lại sau.`,
    }, 30000);
  } finally {
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleCapcutReply(api, message) {
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Lỗi xử lý reply Capcut:", error);
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.`,
    }, 30000);
    return true;
  }
}

export async function handleSendTemplateCapcut(api, message, template) {
  const senderName = message.data.dName;
  const templateId = String(template.id || Date.now());
  const cachedVideo = await getCachedMedia(PLATFORM, templateId, "template", template.title);
  let delivery = null;
  let progress = null;
  let tempFilePath = null;

  try {
    if (isCompleteVideoCache(cachedVideo)) {
      delivery = cachedVideo;
    } else {
      progress = await createDownloadProgress({
        api,
        message,
        caption: `Chờ bé lấy video mẫu CapCut một chút, xong bé gọi cho hay!`,
        ttl: 8000,
      });

      const targetUrl = template.video_url || template.template_url;
      if (template.useYtDlp || /youtube\.com|youtu\.be|capcut\.com\/(t|template)/i.test(String(targetUrl))) {
        const outPath = path.join(tempDir, `capcut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`);
        tempFilePath = await downloadVideoWithYtDlp(targetUrl, outPath);
      } else {
        try {
          tempFilePath = await downloadAndSaveVideo(targetUrl);
        } catch {
          const outPath = path.join(tempDir, `capcut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp4`);
          tempFilePath = await downloadVideoWithYtDlp(template.template_url || targetUrl, outPath);
        }
      }

      delivery = await uploadPreparedVideo(api, message, tempFilePath);
      await setCacheData(PLATFORM, templateId, { ...delivery, title: template.title }, "template");
    }

    await progress?.complete();

    await api.sendVideo({
      ...videoPayload(delivery),
      videoAlreadyUploaded: true,
      threadId: message.threadId,
      threadType: message.type,
      thumbnail: delivery.thumbnail || template.cover_url,
      message: {
        text:
          `[ ${senderName} ]\n` +
          `🎬 Template: ${template.title}\n` +
          `⏱️ Thời Lượng: ${template.duration ? `${(template.duration / 1000).toFixed(0)}s` : "Không rõ"}\n` +
          (template.play_amount ? `👁️ Lượt Xem: ${template.play_amount}\n` : "") +
          (template.like_count ? `❤️ Lượt Thích: ${template.like_count}\n` : "") +
          `🔗 Nguồn: ${template.template_url || template.video_url}`,
      },
      ttl: 3600000,
    });

    return true;
  } finally {
    if (tempFilePath) await deleteFile(tempFilePath).catch(() => {});
    await progress?.complete();
  }
}
