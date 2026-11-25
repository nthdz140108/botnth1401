import axios from "axios";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { getGlobalPrefix } from "../../../service.js";
import { checkExstentionFileRemote, deleteFile, downloadFile } from "../../../../utils/util.js";
import { MessageMention, MessageType } from "../../../../api-zalo/index.js";
import { tempDir } from "../../../../utils/io-json.js";
import { getVideoMetadata } from "../../../../api-zalo/utils.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
} from "../../../../utils/runtime-dependencies.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../../../commands/shared/command-input-utils.js";

configureFluentFfmpeg();

const CLIENT_KEY = "my_bot_app";
const TENOR_V1_PUBLIC_KEY = "LIVDSRZULELA";

function normalizeTenorItem(item) {
  if (!item || typeof item !== "object") return null;
  if (item.media_formats && typeof item.media_formats === "object") {
    return item.media_formats;
  }
  if (Array.isArray(item.media) && item.media[0] && typeof item.media[0] === "object") {
    return item.media[0];
  }
  return null;
}

function pickStickerMediaUrl(formats) {
  if (!formats || typeof formats !== "object") return null;
  const candidates = [
    formats.webp?.url,
    formats.tinywebp_transparent?.url,
    formats.webp_transparent?.url,
    formats.gif?.url,
    formats.mediumgif?.url,
    formats.nanogif?.url,
    formats.mp4?.url,
  ];
  for (const url of candidates) {
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) {
      return url.trim();
    }
  }
  return null;
}

async function fetchTenorCandidates(query, limit = 50) {
  const apiKey = String(process.env.TENOR_API_KEY || "").trim();
  const headers = { "User-Agent": "TH_MYBOT/3.0 (Node.js)" };

  if (apiKey && apiKey !== "API_KEY") {
    try {
      const v2Resp = await axios.get("https://tenor.googleapis.com/v2/search", {
        params: {
          q: query,
          key: apiKey,
          client_key: CLIENT_KEY,
          limit,
          contentfilter: "high",
        },
        timeout: 10000,
        headers,
      });
      const v2Items = Array.isArray(v2Resp.data?.results) ? v2Resp.data.results : [];
      const urls = v2Items.map((item) => pickStickerMediaUrl(normalizeTenorItem(item))).filter(Boolean);
      if (urls.length > 0) return urls;
    } catch {
      // Fallback sang Tenor v1 public endpoint bên dưới
    }
  }

  const v1Resp = await axios.get("https://g.tenor.com/v1/search", {
    params: {
      q: query,
      key: TENOR_V1_PUBLIC_KEY,
      limit: Math.min(50, Math.max(limit, 20)),
      contentfilter: "high",
    },
    timeout: 10000,
    headers,
  });
  const v1Items = Array.isArray(v1Resp.data?.results) ? v1Resp.data.results : [];
  return v1Items.map((item) => pickStickerMediaUrl(normalizeTenorItem(item))).filter(Boolean);
}

function shuffleArray(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function readWebpDimensions(webpPath) {
  try {
    const meta = await sharp(webpPath, { animated: true }).metadata();
    if (meta?.width && meta?.height) {
      return {
        width: meta.width,
        height: meta.pageHeight || meta.height,
      };
    }
  } catch {}

  try {
    const videoMeta = await getVideoMetadata(webpPath);
    if (videoMeta?.width && videoMeta?.height) {
      return { width: videoMeta.width, height: videoMeta.height };
    }
  } catch {}

  return { width: 512, height: 512 };
}

function resolveUploadedStickerUrl(uploadRes) {
  const first = Array.isArray(uploadRes) ? uploadRes[0] : uploadRes;
  if (!first || typeof first !== "object") return "";
  const url = first.fileUrl || first.hdUrl || first.normalUrl || first.url || first.mediaUrl || "";
  return typeof url === "string" ? url.trim() : "";
}

async function prepareSingleStickerFromUrl(api, message, mediaUrl) {
  const threadType = safeThreadType(message, MessageType.DirectMessage);
  const id = randomUUID();
  let pathSticker = null;
  let pathWebp = path.join(tempDir, `sticker_${id}.webp`);

  try {
    fs.mkdirSync(tempDir, { recursive: true });
    let ext = "";
    try {
      ext = path.extname(new URL(mediaUrl).pathname).replace(/^\./, "").toLowerCase();
    } catch {}
    if (!ext) {
      ext = String((await checkExstentionFileRemote(mediaUrl)) || "").toLowerCase();
    }
    if (!ext) {
      throw new Error(`Không xác định được định dạng media: ${mediaUrl}`);
    }

    pathSticker = path.join(tempDir, `sticker_src_${id}.${ext}`);
    await downloadFile(mediaUrl, pathSticker);

    const stats = fs.statSync(pathSticker);
    if (!stats || stats.size === 0) {
      throw new Error("File tải về rỗng.");
    }

    if (ext === "webp") {
      pathWebp = pathSticker;
    } else if (ext === "png" || ext === "jpg" || ext === "jpeg") {
      await convertImageToWebp(pathSticker, pathWebp);
    } else if (ext === "gif") {
      try {
        await sharp(pathSticker, { animated: true })
          .resize(512, 512, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 76, loop: 0 })
          .toFile(pathWebp);
      } catch {
        await convertToWebp(pathSticker, pathWebp);
      }
    } else {
      await convertToWebp(pathSticker, pathWebp);
    }

    if (!fs.existsSync(pathWebp) || fs.statSync(pathWebp).size === 0) {
      throw new Error("File WebP đầu ra rỗng hoặc không tồn tại.");
    }

    const linkUploadZalo = await api.uploadAttachment([pathWebp], message.threadId, threadType);
    const finalUrl = resolveUploadedStickerUrl(linkUploadZalo);
    if (!finalUrl) {
      throw new Error("Upload sticker lên Zalo không trả về URL hợp lệ.");
    }

    const { width, height } = await readWebpDimensions(pathWebp);
    return { url: finalUrl, width, height };
  } finally {
    if (pathSticker && pathSticker !== pathWebp) {
      await deleteFile(pathSticker).catch(() => {});
    }
    if (pathWebp) {
      await deleteFile(pathWebp).catch(() => {});
    }
  }
}

export async function handleStkmemeCommand(api, message, aliasCommand = "stkmeme") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message, MessageType.DirectMessage);
  const isGroup = threadType === MessageType.GroupMessage;
  const senderId = message.data?.uidFrom;
  const senderName = message.data?.dName || "Người dùng";
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "stkmeme";

  const commandContent = extractCommandBody(message, prefix, cmdName);
  const rawArgs = commandContent ? commandContent.split(/\s+/).filter(Boolean) : [];
  const filteredArgs = rawArgs.filter((a) => !/^(-d|--debug|-debug)$/i.test(a));
  const input = filteredArgs.join(" ").trim();

  const buildMentions = () =>
    isGroup && senderId ? [MessageMention(senderId, senderName.length, 0)] : undefined;

  if (!input) {
    await api.sendMessage(
      {
        msg: `${senderName}, vui lòng nhập từ khóa tìm kiếm sticker!\nVí dụ: ${prefix}${cmdName} mèo cute 2`,
        quote: message,
        mentions: buildMentions(),
        ttl: 30000,
      },
      threadId,
      threadType,
    );
    return 0;
  }

  // Chỉ tách số lượng ở cuối khi có >= 2 token (để !stkmeme 2026 tìm từ khóa "2026")
  let query = input;
  let count = 1;
  if (filteredArgs.length >= 2) {
    const lastArg = filteredArgs[filteredArgs.length - 1];
    if (/^\d+$/.test(lastArg)) {
      count = Number.parseInt(lastArg, 10);
      query = filteredArgs.slice(0, -1).join(" ").trim();
    }
  }

  const MAX_COUNT = 10;
  if (count > MAX_COUNT) {
    await api.sendMessage(
      {
        msg: `${senderName}, số lượng sticker tối đa là ${MAX_COUNT}! Hãy thử lại với số lượng nhỏ hơn.`,
        quote: message,
        mentions: buildMentions(),
        ttl: 30000,
      },
      threadId,
      threadType,
    );
    return 0;
  }

  if (count < 1) {
    await api.sendMessage(
      {
        msg: `${senderName}, số lượng sticker phải là số nguyên dương!\nVí dụ: ${prefix}${cmdName} funny 3`,
        quote: message,
        mentions: buildMentions(),
        ttl: 30000,
      },
      threadId,
      threadType,
    );
    return 0;
  }

  await api.sendMessage(
    {
      msg: `${senderName}, đang tìm ${count > 1 ? count : "một"} sticker cho từ khóa "${query}", chờ chút nhé!`,
      quote: message,
      mentions: buildMentions(),
      ttl: 10000,
    },
    threadId,
    threadType,
  );

  try {
    let validUrls = await fetchTenorCandidates(query, 50);
    if (validUrls.length === 0 && query.toLowerCase() === "ếch") {
      validUrls = await fetchTenorCandidates("frog", 50);
    }

    if (validUrls.length === 0) {
      await api.sendMessage(
        {
          msg: `${senderName}, không tìm thấy sticker nào cho từ khóa "${query}"! Hãy thử từ khóa khác như "cat" hoặc "funny".`,
          quote: message,
          mentions: buildMentions(),
          ttl: 30000,
        },
        threadId,
        threadType,
      );
      return 0;
    }

    // Luôn xáo trộn ngẫu nhiên kể cả khi count === 1 (dù gõ !stkmeme cat hay !stkmeme cat 1)
    const randomizedUrls = shuffleArray(validUrls);
    const processedStickers = [];

    for (const mediaUrl of randomizedUrls) {
      if (processedStickers.length >= count) break;
      try {
        const prepared = await prepareSingleStickerFromUrl(api, message, mediaUrl);
        if (prepared?.url) {
          processedStickers.push(prepared);
        }
      } catch (err) {
        console.warn(`[stkmeme] Bỏ qua candidate lỗi (${mediaUrl}):`, err?.message || err);
      }
    }

    if (processedStickers.length === 0) {
      await api.sendMessage(
        {
          msg: `${senderName}, không thể xử lý sticker nào cho từ khóa "${query}". Vui lòng thử lại sau!`,
          quote: message,
          mentions: buildMentions(),
          ttl: 30000,
        },
        threadId,
        threadType,
      );
      return 0;
    }

    await api.sendMessage(
      {
        msg:
          processedStickers.length === 1
            ? `${senderName} Sticker của bạn đây!`
            : `${senderName}, đây là ${processedStickers.length} sticker của bạn!`,
        quote: message,
        mentions: buildMentions(),
        ttl: 300000,
      },
      threadId,
      threadType,
    );

    for (const sticker of processedStickers) {
      await api.sendCustomSticker(
        message,
        sticker.url,
        sticker.url,
        sticker.width,
        sticker.height,
        3600000,
      );
    }
  } catch (error) {
    await api.sendMessage(
      {
        msg: `${senderName}, lỗi khi tìm kiếm hoặc gửi sticker: ${error?.message || "Không xác định"}`,
        quote: message,
        mentions: buildMentions(),
        ttl: 30000,
      },
      threadId,
      threadType,
    );
  }

  return 0;
}

export async function convertToWebp(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File đầu vào không tồn tại: ${inputPath}`);
  }
  const stats = fs.statSync(inputPath);
  if (stats.size === 0) {
    throw new Error(`File đầu vào rỗng: ${inputPath}`);
  }

  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".webp") {
    fs.copyFileSync(inputPath, outputPath);
    return true;
  }

  if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
    await convertImageToWebp(inputPath, outputPath);
    return true;
  }

  return new Promise((resolve, reject) => {
    let options = [
      "-c:v",
      "libwebp",
      "-lossless",
      "0",
      "-compression_level",
      "6",
      "-q:v",
      "60",
      "-loop",
      "0",
      "-preset",
      "default",
      "-an",
    ];

    if (ext === ".mp4" || ext === ".mov" || ext === ".webm") {
      options.push("-vf", "fps=10,scale=512:-2:flags=lanczos");
    } else if (ext === ".gif") {
      options.push("-vf", "scale=512:-2:flags=lanczos");
    } else {
      return reject(new Error(`Định dạng file không được hỗ trợ: ${ext}`));
    }

    configureFluentFfmpeg();
    const cmd = ffmpeg(inputPath);
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    cmd.setFfmpegPath(ffmpegBin);
    cmd
      .outputOptions(options)
      .toFormat("webp")
      .on("end", () => {
        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
          return reject(new Error(`File WebP đầu ra rỗng hoặc không tồn tại: ${outputPath}`));
        }
        resolve(true);
      })
      .on("error", (err) => {
        reject(new Error(`Lỗi khi chuyển đổi sang WebP: ${err.message}`));
      })
      .save(outputPath);
  });
}

export async function convertImageToWebp(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`File input does not exist: ${inputPath}`);
  }

  const stats = fs.statSync(inputPath);
  if (stats.size === 0) {
    throw new Error(`File input is empty: ${inputPath}`);
  }

  await sharp(inputPath)
    .resize(512, 512, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: 80,
      effort: 6,
    })
    .toFile(outputPath);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error(`File WebP output is empty or missing: ${outputPath}`);
  }

  return true;
}
