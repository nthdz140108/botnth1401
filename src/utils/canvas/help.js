import crypto from "node:crypto";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { LRUCache } from "lru-cache";
import { getProjectRoot } from "../env.js";
import { createCanvasTempPath } from "./temp-path.js";
import { ensureCanvasFontsRegistered } from "./register-fonts.js";
import { getRandomGradient } from "./color.js";

const cv = {
  getRandomGradient,
};

const decodedBgCache = new LRUCache({ max: 40, ttl: 30 * 60 * 1000 });

export const linkBackgroundDefault = path.join(
  getProjectRoot(),
  "src",
  "service-debug",
  "chat-zalo",
  "chat-special",
  "data-send",
  "help.txt"
);

export function parseBackgroundLinksFromText(fileContent) {
  return String(fileContent || "")
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?=https?:\/\/)/g))
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

async function fetchAndDecodeBackgroundImage(url) {
  let pngBuffer = decodedBgCache.get(url);
  if (!pngBuffer) {
    const res = await fetch(url, {
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      throw new Error(`Background HTTP ${res.status}`);
    }
    const rawBuffer = Buffer.from(await res.arrayBuffer());
    const isExotic = /\.(jxl|webp|avif|heif)(\?|$)/i.test(url);
    try {
      pngBuffer = await sharp(rawBuffer, { animated: false }).png().toBuffer();
    } catch (sharpErr) {
      if (isExotic) {
        throw sharpErr;
      }
      pngBuffer = rawBuffer;
    }
    decodedBgCache.set(url, pngBuffer);
  }
  return loadImage(pngBuffer);
}

function fillFallbackGradient(ctx, width, height) {
  const backgroundGradient = ctx.createLinearGradient(0, 0, 0, height);
  backgroundGradient.addColorStop(0, "#3B82F6");
  backgroundGradient.addColorStop(1, "#111827");
  ctx.fillStyle = backgroundGradient;
  ctx.fillRect(0, 0, width, height);
}

// Tạo Hình Lệnh !Help
export async function createInstructionsImage(helpContent, isAdminBox, width = 800) {
  ensureCanvasFontsRegistered();
  const ctxTemp = createCanvas(999, 999).getContext("2d");

  const space = 36;
  let yTemp = 60;

  ctxTemp.font = "bold 28px Tahoma";
  for (const key in helpContent.allMembers) {
    if (helpContent.allMembers.hasOwnProperty(key)) {
      const keyHelpContent = `${helpContent.allMembers[key].icon} ${helpContent.allMembers[key].command}`;
      const labelWidth = ctxTemp.measureText(keyHelpContent).width;
      const valueHelpContent = " -> " + helpContent.allMembers[key].description;
      const lineWidth = labelWidth + space + ctxTemp.measureText(valueHelpContent).width;
      if (lineWidth > width) {
        yTemp += 52;
      }
      yTemp += 52;
    }
  }

  yTemp += 60; // Khoảng cách dưới

  if (isAdminBox) {
    for (const key in helpContent.admin) {
      if (helpContent.admin.hasOwnProperty(key)) {
        const keyHelpContent = `${helpContent.admin[key].icon} ${helpContent.admin[key].command}`;
        const labelWidth = ctxTemp.measureText(keyHelpContent).width;
        const valueHelpContent = " -> " + helpContent.admin[key].description;
        const lineWidth = labelWidth + space + ctxTemp.measureText(valueHelpContent).width;
        if (lineWidth > width) {
          yTemp += 52;
        }
        yTemp += 52;
      }
    }
    yTemp += 60; // Khoảng cách dưới
  }

  const height = yTemp > 430 ? yTemp : 430;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Đọc danh sách link ảnh từ file (tự tách các URL bị dính liền trên cùng 1 dòng)
  let candidateUrls = [];
  try {
    const fileContent = fs.readFileSync(linkBackgroundDefault, "utf-8");
    const imageLinks = parseBackgroundLinksFromText(fileContent);
    if (imageLinks.length > 0) {
      // Shuffle up to 4 candidates (prioritizing first random pick, with fallback if a remote link fails)
      const shuffled = [...imageLinks].sort(() => Math.random() - 0.5);
      const nonJxlFallback = imageLinks.find((u) => /\.(jpe?g|png)(\?|$)/i.test(u));
      candidateUrls = shuffled.slice(0, 3);
      if (nonJxlFallback && !candidateUrls.includes(nonJxlFallback)) {
        candidateUrls.push(nonJxlFallback);
      }
    }
  } catch (error) {
    console.error("Lỗi khi đọc file chứa link ảnh:", error);
  }

  // Tải, giải mã (.jxl/.webp qua sharp -> PNG) và vẽ ảnh nền
  let drewBackground = false;
  for (const bgUrl of candidateUrls) {
    try {
      const backgroundImage = await fetchAndDecodeBackgroundImage(bgUrl);
      const imgAspectRatio = backgroundImage.width / backgroundImage.height;
      const canvasAspectRatio = width / height;

      let drawWidth, drawHeight, offsetX, offsetY;
      if (imgAspectRatio > canvasAspectRatio) {
        drawHeight = height;
        drawWidth = height * imgAspectRatio;
        offsetX = (width - drawWidth) / 2;
        offsetY = 0;
      } else {
        drawWidth = width;
        drawHeight = width / imgAspectRatio;
        offsetX = 0;
        offsetY = (height - drawHeight) / 2;
      }

      ctx.drawImage(backgroundImage, offsetX, offsetY, drawWidth, drawHeight);
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.fillRect(0, 0, width, height);
      drewBackground = true;
      break;
    } catch (error) {
      console.warn(`Không tải/giải mã được ảnh nền (${bgUrl}): ${error.message}`);
    }
  }

  if (!drewBackground) {
    fillFallbackGradient(ctx, width, height);
  }

  // Vẽ icon nổi như background
const icons = [
  "⭐", "⚡", "🔥", "💎", "✨", "🌙", "🎵", 
  "🌟", "🎶", "❤️", "💖", "💫", "🌈", "☀️", 
  "🌸", "🍀", "🌹", "🎇", "🎉", "🎁", "🪐", "💋"
];
  for (let i = 0; i < 30; i++) {
    const icon = icons[Math.floor(Math.random() * icons.length)];
    const fontSize = Math.floor(Math.random() * 50) + 30;
    ctx.font = `${fontSize}px Tahoma`;
    ctx.fillStyle = cv.getRandomGradient(ctx, width);
    ctx.globalAlpha = 0.4; // Làm icon mờ nhẹ để không lấn chữ
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur = 12;
    ctx.fillText(icon, Math.random() * width, Math.random() * height);
  }
  ctx.globalAlpha = 1; // Reset lại để văn bản không bị mờ
  ctx.shadowBlur = 0;

  let y = 60;

  // Vẽ tiêu đề
  ctx.textAlign = "left";
  ctx.font = "bold 28px Tahoma";
  ctx.fillStyle = cv.getRandomGradient(ctx, width);
  ctx.fillText(helpContent.title, space, y);

  y += 50;

  // Vẽ nội dung cho allMembers
  ctx.textAlign = "left";
  ctx.font = "bold 28px Tahoma";
  ctx.fillStyle = "#FFFFFF";

  for (const key in helpContent.allMembers) {
    if (helpContent.allMembers.hasOwnProperty(key)) {
      ctx.fillStyle = cv.getRandomGradient(ctx, width);
      const keyHelpContent = `${helpContent.allMembers[key].icon} ${helpContent.allMembers[key].command}`;
      const labelWidth = ctx.measureText(keyHelpContent).width;
      ctx.fillText(keyHelpContent, space, y);
      ctx.fillStyle = "#FFFFFF";
      const valueHelpContent = " -> " + helpContent.allMembers[key].description;
      const lineWidth = labelWidth + space + ctx.measureText(valueHelpContent).width;
      if (lineWidth > width) {
        y += 52;
        ctx.fillText(valueHelpContent, space + 20, y);
      } else {
        ctx.fillText(valueHelpContent, space + labelWidth, y);
      }
      y += 52;
    }
  }

  // Vẽ nội dung cho admin nếu isAdminBox = true
  if (isAdminBox) {
    if (Object.keys(helpContent.admin).length > 0) {
      y += 30;
      ctx.textAlign = "left";
      ctx.font = "bold 28px Tahoma";
      ctx.fillStyle = cv.getRandomGradient(ctx, width);
      ctx.fillText(helpContent.titleAdmin, space, y);
      y += 50;
      for (const key in helpContent.admin) {
        if (helpContent.admin.hasOwnProperty(key)) {
          ctx.fillStyle = cv.getRandomGradient(ctx, width);
          const keyHelpContent = `${helpContent.admin[key].icon} ${helpContent.admin[key].command}`;
          const labelWidth = ctx.measureText(keyHelpContent).width;
          ctx.fillText(keyHelpContent, space, y);
          ctx.fillStyle = "#FFFFFF";
          const valueHelpContent = " -> " + helpContent.admin[key].description;
          const lineWidth = labelWidth + space + ctx.measureText(valueHelpContent).width;
          if (lineWidth > width) {
            y += 52;
            ctx.fillText(valueHelpContent, space + 20, y);
          } else {
            ctx.fillText(valueHelpContent, space + labelWidth, y);
          }
          y += 52;
        }
      }
    }
  }

  const filePath = createCanvasTempPath(`help_${crypto.randomUUID()}.png`);
  const out = fs.createWriteStream(filePath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  return new Promise((resolve, reject) => {
    out.on("finish", () => resolve(filePath));
    out.on("error", reject);
  });
}
