import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import axios from "axios";
import { MessageMention } from "../../../../api-zalo/models/index.js";
import { MessageType } from "../../../../api-zalo/models/Message.js";
import { createTextScrollingGif, createRandomVibrantGif } from "./create-gif.js";
import { getGlobalPrefix } from "../../../service.js";
import {
  sendMessageWarningRequest,
  sendMessageProcessingRequest,
} from "../../chat-style/chat-style.js";
import { dataGifPath, tempDir } from "../../../../utils/io-json.js";
import { deleteFile, downloadFile } from "../../../../utils/util.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
} from "../../../../utils/runtime-dependencies.js";
import {
  extractCommandBody,
  getQuotedText,
  safeThreadType,
} from "../../../../commands/shared/command-input-utils.js";

configureFluentFfmpeg();

const CLIENT_KEY = "my_bot_app";
const TENOR_V1_PUBLIC_KEY = "LIVDSRZULELA";

function normalizeTenorFormats(gif) {
  if (!gif || typeof gif !== "object") return null;
  if (gif.media_formats && typeof gif.media_formats === "object") return gif.media_formats;
  if (Array.isArray(gif.media) && gif.media[0] && typeof gif.media[0] === "object") return gif.media[0];
  return null;
}

function selectGifFormat(formats) {
  if (!formats || typeof formats !== "object") return null;
  if (formats.mediumgif?.url?.trim()) return { url: formats.mediumgif.url.trim(), ext: ".gif", id: null };
  if (formats.nanogif?.url?.trim()) return { url: formats.nanogif.url.trim(), ext: ".gif", id: null };
  if (formats.gif?.url?.trim()) return { url: formats.gif.url.trim(), ext: ".gif", id: null };
  if (formats.mp4?.url?.trim()) return { url: formats.mp4.url.trim(), ext: ".mp4", id: null };
  if (formats.webp?.url?.trim()) return { url: formats.webp.url.trim(), ext: ".webp", id: null };
  return null;
}

async function searchTenorGifCandidates(searchTerm, limit = 16) {
  const apikey = String(process.env.TENOR_API_KEY || "").trim();
  const headers = { "User-Agent": "TH_MYBOT/3.0 (Node.js)" };

  if (apikey && apikey !== "API_KEY") {
    try {
      const response = await axios.get("https://tenor.googleapis.com/v2/search", {
        params: {
          q: searchTerm,
          key: apikey,
          client_key: CLIENT_KEY,
          limit,
        },
        timeout: 10000,
        headers,
      });
      const results = Array.isArray(response.data?.results) ? response.data.results : [];
      const mapped = results
        .map((item) => {
          const picked = selectGifFormat(normalizeTenorFormats(item));
          return picked ? { ...picked, id: item.id || "unknown", usedV2Key: apikey } : null;
        })
        .filter(Boolean);
      if (mapped.length > 0) return mapped;
    } catch {
      // Fallback sang Tenor v1 public endpoint
    }
  }

  const v1Resp = await axios.get("https://g.tenor.com/v1/search", {
    params: {
      q: searchTerm,
      key: TENOR_V1_PUBLIC_KEY,
      limit,
      contentfilter: "high",
    },
    timeout: 10000,
    headers,
  });
  const v1Results = Array.isArray(v1Resp.data?.results) ? v1Resp.data.results : [];
  return v1Results
    .map((item) => {
      const picked = selectGifFormat(normalizeTenorFormats(item));
      return picked ? { ...picked, id: item.id || "unknown", usedV2Key: "" } : null;
    })
    .filter(Boolean);
}

export async function handleTenorGifCommand(api, message, aliasCommand = "gifmeme") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "gifmeme";
  const msgType = safeThreadType(message, MessageType.DirectMessage);
  const isGroup = msgType === MessageType.GroupMessage;
  let gifPath = null;

  const senderName = message.data?.dName || "Người dùng";
  const senderId = message.data?.uidFrom;

  try {
    let searchTerm = extractCommandBody(message, prefix, cmdName);
    if (searchTerm.startsWith("<") && searchTerm.endsWith(">")) {
      searchTerm = searchTerm.slice(1, -1).trim();
    }

    if (!searchTerm) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `${senderName}, vui lòng nhập từ khóa để tìm GIF! Ví dụ: ${prefix}${cmdName} cười`,
        },
        30000,
      );
      return;
    }

    await sendMessageProcessingRequest(
      api,
      message,
      {
        caption: `${senderName}, đang tìm kiếm GIF với từ khóa "${searchTerm}", vui lòng chờ...`,
      },
      60000,
    );

    const validGifs = await searchTenorGifCandidates(searchTerm, 16);
    if (validGifs.length === 0) {
      await api.sendMessage(
        {
          msg: `${senderName}, không tìm thấy GIF nào với từ khóa "${searchTerm}". Vui lòng thử từ khóa khác.`,
          quote: message,
          ttl: 60000,
        },
        threadId,
        msgType,
      );
      return;
    }

    const selectedGif = validGifs[Math.floor(Math.random() * validGifs.length)];
    fs.mkdirSync(tempDir, { recursive: true });
    const id = randomUUID();
    gifPath = path.join(tempDir, `tenor_media_${id}${selectedGif.ext}`);

    await downloadFileWithRetry(selectedGif.url, gifPath, 3, 1500);

    if (!gifPath.endsWith(".gif")) {
      const tempGifPath = path.join(tempDir, `converted_gif_${id}.gif`);
      await new Promise((resolve, reject) => {
        configureFluentFfmpeg();
        const cmd = ffmpeg(gifPath);
        const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
        cmd.setFfmpegPath(ffmpegBin);
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            cmd.kill("SIGKILL");
          } catch {}
          reject(new Error("FFmpeg GIF conversion timed out"));
        }, 20000);
        cmd
          .setDuration(10)
          .outputOptions(["-vf", "fps=15,scale=240:-1:flags=lanczos", "-loop", "0"])
          .toFormat("gif")
          .on("end", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          })
          .on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
          })
          .save(tempGifPath);
      });
      await deleteFile(gifPath).catch(() => {});
      gifPath = tempGifPath;
    }

    await api.sendMessage(
      {
        msg: `${senderName}, đây là GIF của bạn!`,
        attachments: [gifPath],
        ...(isGroup && senderId
          ? { mentions: [MessageMention(senderId, senderName.length, 0)] }
          : {}),
        ttl: 3600000,
      },
      threadId,
      msgType,
    );

    if (selectedGif.usedV2Key && selectedGif.id !== "unknown") {
      const shareUrl = `https://tenor.googleapis.com/v2/registershare?id=${encodeURIComponent(selectedGif.id)}&key=${encodeURIComponent(selectedGif.usedV2Key)}&q=${encodeURIComponent(searchTerm)}&client_key=${CLIENT_KEY}`;
      axios.get(shareUrl, { timeout: 4000, headers: { "User-Agent": "TH_MYBOT/3.0 (Node.js)" } }).catch(() => {});
    }
  } catch (error) {
    const msg = String(error?.message || "");
    let errorMessage = `${senderName}, lỗi khi tìm kiếm GIF. Vui lòng thử lại sau.`;
    if (msg.includes("429")) {
      errorMessage = `${senderName}, máy chủ Tenor đang bận, vui lòng thử lại sau vài phút.`;
    } else if (msg.includes("401") || msg.includes("403")) {
      errorMessage = `${senderName}, lỗi xác thực API Tenor. Vui lòng kiểm tra cấu hình TENOR_API_KEY.`;
    }

    await api.sendMessage(
      {
        msg: errorMessage,
        quote: message,
      },
      threadId,
      msgType,
    );
  } finally {
    if (gifPath && fs.existsSync(gifPath)) {
      await deleteFile(gifPath).catch(() => {});
    }
  }
}

async function downloadFileWithRetry(url, destination, maxRetries = 3, initialDelay = 1500) {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await downloadFile(url, destination);
      const stats = fs.statSync(destination);
      if (stats.size === 0) {
        throw new Error(`File tải xuống tại ${destination} rỗng`);
      }
      return;
    } catch (error) {
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      } else {
        throw error;
      }
    }
  }
}

export async function handleGifTextCommand(api, message, aliasCommand = "giftext") {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "giftext";
  const msgType = safeThreadType(message, MessageType.DirectMessage);
  const senderName = message.data?.dName || "Người dùng";
  const senderId = message.data?.uidFrom;

  let text = extractCommandBody(message, prefix, cmdName);
  if (!text) {
    text = getQuotedText(message);
  }

  if (!text) {
    await sendGifTextInstructions(api, message, threadId, msgType, senderName, cmdName);
    return;
  }

  await createAndSendTextGif(api, message, threadId, text, msgType, senderName, senderId);
}

async function sendGifTextInstructions(api, message, threadId, msgType, senderName, cmdName = "giftext") {
  try {
    const prefix = getGlobalPrefix();
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `${senderName}, vui lòng nhập văn bản để tạo GIF! Ví dụ: ${prefix}${cmdName} Chúc mừng năm mới`,
      },
      30000,
    );
  } catch {
    await api.sendMessage(
      { msg: `${senderName}, vui lòng nhập văn bản sau lệnh để tạo GIF.`, quote: message },
      threadId,
      msgType,
    );
  }
}

async function createAndSendTextGif(api, message, threadId, text, msgType, senderName) {
  let gifPath = null;
  try {
    if (text.length > 500) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `${senderName}, văn bản quá dài! Vui lòng sử dụng văn bản tối đa 500 ký tự.`,
        },
        30000,
      );
      return;
    }

    await sendMessageProcessingRequest(
      api,
      message,
      {
        caption: `${senderName}, đang tạo GIF văn bản, vui lòng chờ...`,
      },
      60000,
    );

    gifPath = await createTextScrollingGif(text);

    // Không truyền mentions vào chuỗi msg rỗng để tránh lỗi validate mention của Zalo
    await api.sendMessage(
      {
        msg: "",
        attachments: [gifPath],
        quote: message,
        ttl: 3600000,
      },
      threadId,
      msgType,
    );
  } catch {
    await api.sendMessage(
      {
        msg: `${senderName}, lỗi khi tạo GIF văn bản. Vui lòng thử lại sau.`,
        quote: message,
      },
      threadId,
      msgType,
    );
  } finally {
    if (gifPath) await deleteFile(gifPath).catch(() => {});
  }
}

function listRealLocalGifs() {
  if (!fs.existsSync(dataGifPath)) return [];
  try {
    return fs
      .readdirSync(dataGifPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry &&
          !entry.name.startsWith(".") &&
          entry.isFile() &&
          /\.gif$/i.test(entry.name),
      )
      .map((entry) => path.join(dataGifPath, entry.name));
  } catch {
    return [];
  }
}

export async function sendGifRemote(api, message) {
  const msgType = safeThreadType(message, MessageType.DirectMessage);
  const senderName = message.data?.dName || "Người dùng";
  let generatedGifPath = null;

  try {
    const localGifs = listRealLocalGifs();
    if (localGifs.length > 0) {
      const pickedGif = localGifs[Math.floor(Math.random() * localGifs.length)];
      await api.sendMessage(
        {
          msg: "",
          attachments: [pickedGif],
          quote: message,
          ttl: 3600000,
        },
        message.threadId,
        msgType,
      );
      return;
    }

    generatedGifPath = await createRandomVibrantGif();
    await api.sendMessage(
      {
        msg: "",
        attachments: [generatedGifPath],
        quote: message,
        ttl: 3600000,
      },
      message.threadId,
      msgType,
    );
  } catch {
    await api.sendMessage(
      {
        msg: `${senderName}, đã xảy ra lỗi khi gửi GIF. Vui lòng thử lại sau.`,
        quote: message,
        ttl: 60000,
      },
      message.threadId,
      msgType,
    );
  } finally {
    if (generatedGifPath) {
      await deleteFile(generatedGifPath).catch(() => {});
    }
  }
}

export async function sendGifLocal(api, message) {
  await sendGifRemote(api, message);
}
