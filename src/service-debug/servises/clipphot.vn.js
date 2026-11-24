import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs"; // Import fs/promises thay vì require('fs')
import { tempDir } from "../../utils/io-json.js";
import { getFfmpegExecutableSync } from "../../utils/runtime-dependencies.js";
import { sendMessageCompleteRequest, sendMessageWarningRequest } from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { deleteFile } from "../../utils/util.js";
import { createSearchResultImage } from "./canvas/Seach.canvas.js";
import { MessageType } from "../../api-zalo/models/index.js";
import {
  setSelectionsMapData,
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
} from "../api-crawl/index.js";
import { canContinueReply } from "../reply-access.js";
import { getGlobalPrefix } from "../service.js";

const execFileAsync = promisify(execFile);
const BASE_URL = "https://clipphot.org";
const TIME_TO_SELECT = 60000;

// Hàm kiểm tra xem ffmpeg có trong PATH hoặc runtime-dependencies không
async function checkFffmpeg() {
  const ffmpegBin = getFfmpegExecutableSync();
  if (!ffmpegBin) {
    console.error("FFmpeg không được tìm thấy trong PATH hoặc ffmpeg-static.");
    return false;
  }
  try {
    await execFileAsync(ffmpegBin, ["-version"]);
    return true;
  } catch (err) {
    console.error("FFmpeg không thực thi được:", err.message);
    return false;
  }
}

// Hàm kiểm tra nội dung file m3u8
async function checkM3u8Content(m3u8Url) {
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        Referer: BASE_URL,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
    });
    const content = response.data;
    console.log("Nội dung file m3u8:", content); // Log nội dung để debug
    // Kiểm tra nếu file m3u8 chứa tham chiếu đến .png hoặc các định dạng không phải video
    if (content.includes(".png") || content.includes(".jpg") || content.includes(".jpeg")) {
      console.warn("File m3u8 chứa tham chiếu đến định dạng không phải video.");
      return false;
    }
    // Kiểm tra xem có chứa định dạng video hợp lệ (.ts, .mp4) không
    if (!content.includes(".ts") && !content.includes(".mp4")) {
      console.warn("File m3u8 không chứa định dạng video hợp lệ (.ts hoặc .mp4).");
      return false;
    }
    return true;
  } catch (err) {
    console.error("Lỗi khi kiểm tra file m3u8:", err.message);
    return false;
  }
}

// Hàm loại bỏ các đoạn không hợp lệ trong m3u8
async function sanitizeM3u8(m3u8Url) {
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        Referer: BASE_URL,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
    });
    let content = response.data;
    // Loại bỏ các dòng chứa .png, .jpg, .jpeg
    const lines = content.split('\n');
    const filteredLines = lines.filter(line => !line.includes('.png') && !line.includes('.jpg') && !line.includes('.jpeg'));
    if (filteredLines.length === lines.length) {
      // Nếu không có gì bị lọc, trả về null để dùng URL gốc
      return null;
    }
    // Kiểm tra xem file còn đoạn video hợp lệ không
    if (!filteredLines.some(line => line.includes('.ts') || line.includes('.mp4'))) {
      console.warn("File m3u8 sau khi lọc không chứa đoạn video hợp lệ.");
      return null;
    }
    content = filteredLines.join('\n');
    const tempM3u8 = path.join(tempDir, `temp-${Date.now()}.m3u8`);
    await fs.writeFile(tempM3u8, content);
    return tempM3u8;
  } catch (err) {
    console.error("Lỗi khi sanitize file m3u8:", err.message);
    return null;
  }
}

export async function searchClip(rawKeyword, pageNumber = 1) {
  const keyword = rawKeyword.replace(/^!+/, "").trim();
  const results = [];

  try {
    const pageUrl = keyword
      ? `${BASE_URL}/page/${pageNumber}/?s=${encodeURIComponent(keyword)}`
      : `${BASE_URL}/page/${pageNumber}/`;

    const { data } = await axios.get(pageUrl);
    const $ = cheerio.load(data);

    $("#recent-content .ht_grid_1_4").each((_, el) => {
      const $el = $(el);
      const title = $el.find(".entry-title a").text().trim();
      const href = $el.find(".entry-title a").attr("href");
      const img = $el.find("img").attr("src");
      const date = $el.find(".entry-meta .entry-date").text().trim();

      if (title && href && img) {
        results.push({ title, href, img, date });
      }
    });

    return results;
  } catch (err) {
    console.error("Lỗi khi tìm clip:", err.message);
    return [];
  }
}

async function getM3u8UrlFromPage(url) {
  try {
    const pageRes = await axios.get(url);
    const $ = cheerio.load(pageRes.data);

    const mv_id = $(".video#imdb-play").attr("data-id");
    if (!mv_id) return null;

    const formData = new URLSearchParams();
    formData.append("mv_id", mv_id);
    formData.append("action", "imdb_source");
    formData.append("cache", "true");

    const ajax = await axios.post(`${BASE_URL}/wp-admin/admin-ajax.php`, formData, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: url,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      },
    });

    const embed = ajax.data?.data?.replace(/\\/g, "");
    if (!embed) return null;

    const embedRes = await axios.get(embed, {
      headers: { Referer: BASE_URL, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" },
    });

    const match = embedRes.data.match(/file_play\s*=\s*["']([^"']+stream\.m3u8)["']/);
    return match ? new URL(match[1], embed).href : null;
  } catch (err) {
    console.error("Lỗi khi trích xuất m3u8:", err.message);
    return null;
  }
}

export async function handleClipphotCommand(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  let imagePath = null;
  let registered = false;

  try {
    const prefix = await getGlobalPrefix();
    let content = removeMention(message).replace(`${prefix}${aliasCommand}`, "").trim();
    let page = 1;

    const pageMatch = content.match(/\bpage\s+(\d+)/i);
    if (pageMatch) {
      page = parseInt(pageMatch[1]);
      content = content.replace(pageMatch[0], "").trim();
    }

    const clips = await searchClip(content, page);

    if (clips.length === 0) {
      await sendMessageWarningRequest(api, message, {
        caption: `Không tìm thấy kết quả nào cho từ khóa: ${content || "(trang chủ)"}${page > 1 ? ` (trang ${page})` : ""}`,
      }, 30000);
      return;
    }

    const formatted = clips.map(c => ({
      title: c.title,
      thumbnailM: c.img,
    }));

    imagePath = await createSearchResultImage(formatted);

    const listCaption = `Danh sách clip (trang ${page}):\nVui lòng trả lời HOẶC gửi trực tiếp số thứ tự để xem video.`;
    const response = await sendMessageCompleteRequest(api, message, {
      caption: listCaption,
      imagePath,
    }, TIME_TO_SELECT);

    const msgId = response?.message?.msgId || response?.attachment?.[0]?.msgId;
    const cliMsgId = response?.message?.cliMsgId || response?.attachment?.[0]?.cliMsgId;

    // Preview temp thuộc sở hữu session; chỉ xóa đúng một lần khi kết thúc.
    await setSelectionsMapData(senderId, {
      platform: "clipphot",
      collection: clips,
      quotedMsgId: msgId?.toString(),
      cliMsgId: cliMsgId?.toString(),
      timestamp: Date.now(),
      api,
      sentMessage: response,
      messageContext: message,
      threadId: message.threadId,
      type: message.type,
      seconds: 60,
      ownedTempPaths: imagePath ? [imagePath] : [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: listCaption,
        imagePath,
      }, TIME_TO_SELECT),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendClipphotVideo(api, replyMessage, media);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error("Lỗi khi gửi video clipphot:", error);
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;
  } catch (err) {
    console.error("Lỗi xử lý lệnh clipphot:", err);
    await sendMessageWarningRequest(api, message, {
      caption: "Đã xảy ra lỗi, vui lòng thử lại sau.",
    }, 30000);
  } finally {
    if (imagePath && !registered) {
      await deleteFile(imagePath);
    }
  }
}

export async function handleClipphotReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    if (!message.data.quote || !message.data.quote.globalMsgId) return false;
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== "clipphot") return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (err) {
    console.error("Lỗi khi xử lý reply clipphot:", err);
    return true;
  }
}

export async function handleSendClipphotVideo(api, message, selected) {
  await sendMessageCompleteRequest(api, message, {
    caption: "Đang xử lý video, vui lòng đợi chút nhoa...",
  }, 30000);

  // Kiểm tra ffmpeg trong PATH
  const isFffmpegAvailable = await checkFffmpeg();
  if (!isFffmpegAvailable) {
    await sendMessageWarningRequest(api, message, {
      caption: "FFmpeg không được tìm thấy. Vui lòng cài đặt FFmpeg và thêm vào PATH hệ thống.",
    }, 30000);
    return false;
  }

  const m3u8Url = await getM3u8UrlFromPage(selected.href);
  if (!m3u8Url) {
    await sendMessageWarningRequest(api, message, {
      caption: "Không thể lấy link phát video.",
    }, 30000);
    return false;
  }

  // Kiểm tra nội dung file m3u8
  const isM3u8Valid = await checkM3u8Content(m3u8Url);
  let inputUrl = m3u8Url;
  let tempM3u8 = null;
  if (!isM3u8Valid) {
    // Nếu không hợp lệ, thử sanitize
    tempM3u8 = await sanitizeM3u8(m3u8Url);
    if (!tempM3u8) {
      await sendMessageWarningRequest(api, message, {
        caption: "File m3u8 không hợp lệ hoặc không chứa nội dung video, không thể xử lý.",
      }, 30000);
      return false;
    }
    inputUrl = tempM3u8; // Sử dụng file m3u8 đã sanitize cục bộ
  }

  const safeTitle = selected.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 100);
  const mp4File = path.join(tempDir, `${safeTitle}.mp4`);

  try {
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    await fs.mkdir(path.dirname(mp4File), { recursive: true });
    await execFileAsync(ffmpegBin, [
      "-y",
      "-headers",
      `Referer: ${BASE_URL}\r\n`,
      "-i",
      inputUrl,
      "-c",
      "copy",
      "-bsf:a",
      "aac_adtstoasc",
      mp4File,
    ]);
    const uploadResult = await api.uploadAttachment([mp4File], message.data.uidFrom, MessageType.DirectMessage);
    const videoUrl = uploadResult?.[0]?.fileUrl;

    if (!videoUrl) throw new Error("Không thể upload video.");

    await api.sendVideo({
      videoUrl,
      threadId: message.data.uidFrom,
      threadType: MessageType.DirectMessage,
      message: { text: selected.title },
      ttl: 1800000,
    });

    await sendMessageCompleteRequest(api, message, {
      caption: "Đã gửi video. Vui lòng kiểm tra tin nhắn riêng :d ",
    }, 30000);
    return true;
  } catch (err) {
    console.error("Lỗi trong quá trình gửi video:", err);
    await sendMessageWarningRequest(api, message, {
      caption: `Lỗi trong quá trình gửi video: ${err.message}`,
    }, 30000);
    return false;
  } finally {
    // Operation temp chỉ dọn sau khi thao tác gửi cuối cùng resolve/reject.
    await deleteFile(mp4File).catch(() => {});
    if (tempM3u8) await deleteFile(tempM3u8).catch(() => {});
  }
}