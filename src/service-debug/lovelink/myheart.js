import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import GIFEncoder from "gifencoder";
import { createCanvas } from "canvas";
import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../chat-zalo/chat-style/chat-style.js";
import { tempDir } from "../../utils/io-json.js";
import { removeMention } from "../../utils/format-util.js";
import { ensureCanvasFontsRegistered } from "../../utils/canvas/register-fonts.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";
import { shortenUrlMultiProvider } from "./rutgonlink.js";

const musicTitleMap = {
  a: { title: "Nơi Này Có Anh (Mặc định)", nemgCode: "nnca" },
  s: { title: "Phép Màu", nemgCode: "pm" },
  d: { title: "Tín Hiệu Từ Trái Tim", nemgCode: "thttt" },
  t: { title: "Có Chắc Yêu Là Đây", nemgCode: "ccyld" },
  c: { title: "Mượn Rượu Tỏ Tình", nemgCode: "mrtt" },
};
const validMusic = Object.keys(musicTitleMap);
const defaultMusic = "a";

const colorMap = {
  đỏ: "#ff2d55",
  do: "#ff2d55",
  xanh: "#2ecc71",
  xanhlá: "#2ecc71",
  xanhla: "#2ecc71",
  xanhduong: "#38bdf8",
  vàng: "#facc15",
  vang: "#facc15",
  hồng: "#ff69b4",
  hong: "#ff69b4",
  trắng: "#ffffff",
  trang: "#ffffff",
  tím: "#c084fc",
  tim: "#c084fc",
  cam: "#fb923c",
};

const defaultHeartColor = "#ff69b4";

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withSafeMessageType(message) {
  const fallbackType =
    message?.threadId &&
    message?.data?.uidFrom &&
    String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage;
  const resolvedType = safeThreadType(message, fallbackType);
  return message?.type === resolvedType ? message : { ...message, type: resolvedType };
}

function matchesMyHeartCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "myheart").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

function drawClassicHeart(ctx, cx, cy, scale, fillColor) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.beginPath();
  for (let t = 0; t <= Math.PI * 2 + 0.05; t += 0.06) {
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = -(
      13 * Math.cos(t) -
      5 * Math.cos(2 * t) -
      2 * Math.cos(3 * t) -
      Math.cos(4 * t)
    );
    if (t === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.shadowColor = fillColor;
  ctx.shadowBlur = 18;
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.restore();
}

function wrapLines(ctx, text, maxWidth) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width <= maxWidth) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export async function renderBeatingHeartGif(messages, heartColor = defaultHeartColor, outPath = null) {
  ensureCanvasFontsRegistered();
  await fs.promises.mkdir(tempDir, { recursive: true });
  const gifPath = outPath || path.join(tempDir, `myheart_${crypto.randomUUID()}.gif`);

  const width = 420;
  const height = 320;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const encoder = new GIFEncoder(width, height);
  const writeStream = fs.createWriteStream(gifPath);
  encoder.createReadStream().pipe(writeStream);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(75);
  encoder.setQuality(10);

  const displayStr = Array.isArray(messages) ? messages.join(" • ") : String(messages || "");
  ctx.font = "bold 20px BeVietnamPro, sans-serif";
  const textLines = wrapLines(ctx, displayStr, width - 48);

  const sparkles = Array.from({ length: 16 }, (_, idx) => ({
    angle: (idx / 16) * Math.PI * 2,
    radius: 85 + (idx % 3) * 24,
    size: 2 + (idx % 3),
  }));

  const totalFrames = 16;
  for (let frame = 0; frame < totalFrames; frame++) {
    const phase = (frame / totalFrames) * Math.PI * 2;
    const pulse =
      1 +
      0.13 * Math.pow(Math.max(0, Math.sin(phase)), 2) +
      0.07 * Math.pow(Math.max(0, Math.sin(phase + 0.85)), 4);

    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, "#16071c");
    bg.addColorStop(1, "#2b0b28");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    for (const sp of sparkles) {
      const a = sp.angle + phase * 0.25;
      const sx = width / 2 + Math.cos(a) * sp.radius;
      const sy = 128 + Math.sin(a) * (sp.radius * 0.62);
      ctx.fillStyle = heartColor;
      ctx.globalAlpha = 0.35 + 0.45 * Math.abs(Math.sin(phase + sp.angle));
      ctx.beginPath();
      ctx.arc(sx, sy, sp.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    drawClassicHeart(ctx, width / 2, 122, 4.3 * pulse, heartColor);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px BeVietnamPro, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const startY = height - 28 - (textLines.length - 1) * 24;
    textLines.forEach((ln, idx) => {
      ctx.fillText(ln, width / 2, startY + idx * 26);
    });

    encoder.addFrame(ctx);
  }

  encoder.finish();
  await new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  return gifPath;
}

async function createLiveLovePageUrl(text, nemgAudioCode) {
  try {
    const apiUrl = `https://api.nemg.me/love?text=${encodeURIComponent(text)}&audio=${encodeURIComponent(nemgAudioCode)}`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return "";
    const json = await res.json();
    const liveUrl = String(json?.url || "").trim();
    if (!liveUrl) return "";
    const shortened = await shortenUrlMultiProvider(liveUrl).catch(() => liveUrl);
    return shortened || liveUrl;
  } catch {
    return "";
  }
}

export async function handleMyHeartCommand(api, message, aliasCommand = "myheart") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "myheart";

  if (!matchesMyHeartCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const body = extractCommandBody(msgCtx, currentPrefix, effectiveAlias);
  const args = body.split(/\s+/).filter(Boolean);

  if (args.length === 0) {
    const musicListGuide = Object.entries(musicTitleMap)
      .map(([key, item]) => ` • ${key}: ${item.title}`)
      .join("\n");

    const guide =
      `💓 MYHEART - TẠO TRÁI TIM NHẢY THEO NHẠC\n\n` +
      `Cú pháp:\n` +
      `${currentPrefix}${effectiveAlias} <lời nhắn> [màu] [mã_nhạc]\n\n` +
      `Mặc định: Màu Hồng & ${musicTitleMap[defaultMusic].title}\n\n` +
      `Mã nhạc hỗ trợ:\n${musicListGuide}`;

    return sendMessageStateQuote(api, msgCtx, guide, true, 60000, true);
  }

  let music = defaultMusic;
  const lastArg = args[args.length - 1].toLowerCase().replace(/\.mp3$/i, "");
  if (validMusic.includes(lastArg)) {
    music = lastArg;
    args.pop();
  }

  let heartColor = defaultHeartColor;
  if (args.length > 0) {
    const colorInput = args[args.length - 1].toLowerCase();
    if (/^#?[0-9a-f]{6}$/i.test(colorInput)) {
      heartColor = colorInput.startsWith("#") ? colorInput : `#${colorInput}`;
      args.pop();
    } else if (colorMap[colorInput]) {
      heartColor = colorMap[colorInput];
      args.pop();
    }
  }

  const rawText = args
    .join(" ")
    .replace(/,\s*,/g, ",")
    .replace(/,+$/g, "")
    .replace(/^\s*,/g, "")
    .trim();

  if (!rawText) {
    return sendMessageFailed(api, msgCtx, "Vui lòng nhập ít nhất 1 lời nhắn!", true);
  }

  const textArray = rawText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const musicConfig = musicTitleMap[music] || musicTitleMap[defaultMusic];
  let gifPath = null;

  try {
    const [shortUrl, renderedGifPath] = await Promise.all([
      createLiveLovePageUrl(textArray.join(" - "), musicConfig.nemgCode),
      renderBeatingHeartGif(textArray, heartColor),
    ]);
    gifPath = renderedGifPath;

    const colorName =
      Object.entries(colorMap).find(([, v]) => v.toLowerCase() === heartColor.toLowerCase())?.[0] ||
      heartColor;

    const lines = [
      `💓 MYHEART ĐÃ TẠO THÀNH CÔNG`,
      ``,
      `➤ Lời nhắn: ${rawText}`,
      `➤ Màu sắc: ${colorName}`,
      `➤ Nhạc nền: ${musicConfig.title}`,
      shortUrl ? `➤ Link hiệu ứng: ${shortUrl}` : null,
    ].filter(Boolean);

    await api.sendMessage(
      {
        msg: lines.join("\n"),
        attachments: [gifPath],
        quote: msgCtx,
        ttl: 3600000,
      },
      msgCtx.threadId,
      msgCtx.type
    );
    return true;
  } catch (e) {
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Lỗi khi tạo MyHeart: ${e?.message || "Không xác định"}`,
      true
    );
  } finally {
    if (gifPath) {
      await fs.promises.unlink(gifPath).catch(() => {});
    }
  }
}
