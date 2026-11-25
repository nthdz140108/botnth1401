import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas } from "canvas";
import GIFEncoder from "gifencoder";
import { MessageType } from "../../../api-zalo/models/Message.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { tempDir } from "../../../utils/io-json.js";
import { ensureCanvasFontsRegistered } from "../../../utils/canvas/register-fonts.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "giftxt",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
  alias: ["giftxt"],
};

const MAX_GIFTXT_CHARS = 120;

function drawLightning(ctx, width, height) {
  ctx.strokeStyle = "rgba(173, 216, 230, 0.9)";
  ctx.shadowColor = "rgba(248, 246, 124, 0.8)";
  ctx.shadowBlur = 15;
  ctx.lineWidth = 2.5;

  const startX = Math.random() * width;
  let x = startX;
  let y = 0;

  for (let i = 0; i < 2; i += 1) {
    ctx.globalAlpha = 0.6 + Math.random() * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, y);

    while (y < height) {
      x += (Math.random() - 0.5) * 50;
      y += Math.random() * 15 + 8;
      ctx.lineWidth = 2.5 - (y / height) * 1;
      ctx.lineTo(x, y);
      x = Math.max(0, Math.min(x, width));
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function drawHeart(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(0, -3, -3, -3, -3, 0);
  ctx.bezierCurveTo(-3, 3, 0, 5, 0, 7);
  ctx.bezierCurveTo(0, 5, 3, 3, 3, 0);
  ctx.bezierCurveTo(3, -3, 0, -3, 0, 0);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function drawRaindrop(ctx, x, y, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size, size);
  ctx.beginPath();
  ctx.moveTo(0, -5);
  ctx.bezierCurveTo(3, -2, 3, 2, 0, 5);
  ctx.bezierCurveTo(-3, 2, -3, -2, 0, -5);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export async function handleGiftext(api, message, aliasCommand = "giftxt") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message, MessageType.DirectMessage);
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "giftxt";

  const rawBody = extractCommandBody(message, prefix, cmdName);
  if (!rawBody) {
    return api.sendMessage(
      {
        msg: `❌ Sai định dạng!\nDùng: ${prefix}${cmdName} <chữ muốn tạo GIF (tối đa ${MAX_GIFTXT_CHARS} ký tự)>`,
        ttl: 60000,
        quote: message,
      },
      threadId,
      threadType,
    );
  }

  ensureCanvasFontsRegistered();
  const text = Array.from(rawBody).slice(0, MAX_GIFTXT_CHARS).join("");

  const width = 350;
  const height = 80;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  await fs.promises.mkdir(tempDir, { recursive: true });
  const gifPath = path.join(tempDir, `giftext_${randomUUID()}.gif`);
  const encoder = new GIFEncoder(width, height);
  const stream = fs.createWriteStream(gifPath);

  const streamFinished = new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  encoder.createReadStream().pipe(stream);
  encoder.start();
  encoder.setRepeat(0);
  encoder.setDelay(50);
  encoder.setQuality(10);

  const fontSize = 16;
  const columns = Math.floor(width / fontSize);
  const drops = Array(columns).fill(0);

  const hearts = Array.from({ length: 12 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: Math.random() * 0.4 + 0.2,
    speed: Math.random() * 2 + 1,
    color: `hsl(${Math.random() * 360}, 100%, 60%)`,
  }));

  const raindrops = Array.from({ length: 15 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: Math.random() * 0.3 + 0.2,
    speed: Math.random() * 3 + 2,
    color: "rgba(135,206,250,0.8)",
  }));

  const icons = ["🔥", "❤️", "⚡", "✨", "🌈", "💎", "🌟"];
  const bgIcons = Array.from({ length: 10 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: Math.random() * 18 + 13,
    speed: Math.random() * 2 + 1,
    icon: icons[Math.floor(Math.random() * icons.length)],
    color: `hsl(${Math.random() * 360}, 100%, 60%)`,
  }));

  const mainFontSize = 28;
  const mainFontSpec = `bold ${mainFontSize}px "BeVietnamPro", sans-serif`;
  ctx.font = mainFontSpec;
  const textWidth = ctx.measureText(text).width;
  const totalFrames = Math.min(120, Math.max(20, Math.ceil((textWidth + width) / 4)));
  const stepX = (textWidth + width) / totalFrames;

  try {
    for (let i = 0; i < totalFrames; i += 1) {
      if (i > 0 && i % 10 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);

      ctx.font = `${fontSize}px monospace`;
      for (let x = 0; x < drops.length; x += 1) {
        const char = String.fromCharCode(0x30a0 + Math.random() * 96);
        const hue = (x * 20 + drops[x] * 10 + i * 5) % 360;
        ctx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
        ctx.shadowBlur = 8;
        ctx.fillText(char, x * fontSize, drops[x] * fontSize);

        if (drops[x] * fontSize > height && Math.random() > 0.975) drops[x] = 0;
        drops[x] += 1;
      }

      if (Math.random() > 0.85) drawLightning(ctx, width, height);

      hearts.forEach((h) => {
        drawHeart(ctx, h.x, h.y, h.size * 3, h.color);
        h.y += h.speed;
        if (h.y > height + 10) {
          h.y = -10;
          h.x = Math.random() * width;
          h.size = Math.random() * 0.4 + 0.2;
          h.color = `hsl(${Math.random() * 360}, 100%, 60%)`;
        }
      });

      raindrops.forEach((r) => {
        drawRaindrop(ctx, r.x, r.y, r.size * 3, r.color);
        r.y += r.speed;
        if (r.y > height + 10) {
          r.y = -10;
          r.x = Math.random() * width;
          r.size = Math.random() * 0.3 + 0.2;
        }
      });

      bgIcons.forEach((ic) => {
        ctx.font = `${ic.size}px sans-serif`;
        ctx.fillStyle = ic.color;
        ctx.shadowColor = ic.color;
        ctx.shadowBlur = 12;
        ctx.fillText(ic.icon, ic.x, ic.y);

        ic.y += ic.speed;
        if (ic.y > height + 20) {
          ic.y = -10;
          ic.x = Math.random() * width;
          ic.size = Math.random() * 20 + 15;
          ic.icon = icons[Math.floor(Math.random() * icons.length)];
          ic.color = `hsl(${Math.random() * 360}, 100%, 60%)`;
        }
      });
      ctx.shadowBlur = 0;

      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "red");
      gradient.addColorStop(0.16, "orange");
      gradient.addColorStop(0.33, "yellow");
      gradient.addColorStop(0.5, "green");
      gradient.addColorStop(0.66, "blue");
      gradient.addColorStop(0.83, "indigo");
      gradient.addColorStop(1, "violet");

      ctx.fillStyle = gradient;
      ctx.shadowColor = "white";
      ctx.shadowBlur = 20;
      ctx.font = mainFontSpec;
      ctx.fillText(text, width - i * stepX, height / 2 + mainFontSize / 3);
      ctx.shadowBlur = 0;

      encoder.addFrame(ctx);
    }

    encoder.finish();
    await streamFinished;

    await api.sendMessage(
      {
        msg: "",
        attachments: [gifPath],
        ttl: 6000000,
        quote: message,
      },
      threadId,
      threadType,
    );
  } catch (err) {
    console.error("[giftxt] Lỗi gửi GIF:", err);
    await api
      .sendMessage(
        {
          msg: "❌ Lỗi khi tạo hoặc gửi ảnh GIF!",
          ttl: 60000,
          quote: message,
        },
        threadId,
        threadType,
      )
      .catch(() => {});
  } finally {
    await fs.promises.unlink(gifPath).catch(() => {});
  }
}
