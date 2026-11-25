import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import GIFEncoder from "gifencoder";
import { createCanvas, loadImage } from "canvas";
import { tempDir } from "../../../../utils/io-json.js";
import { ensureCanvasFontsRegistered } from "../../../../utils/canvas/register-fonts.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
} from "../../../../utils/runtime-dependencies.js";

configureFluentFfmpeg();

async function encodeCanvasFramesToGifFile({ width, height, totalFrames, delayMs, repeat = 0, quality = 10, drawFrame, outputGifPath }) {
  await fs.promises.mkdir(path.dirname(outputGifPath), { recursive: true });
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const encoder = new GIFEncoder(width, height);
  const writeStream = fs.createWriteStream(outputGifPath);

  const streamDone = new Promise((resolve, reject) => {
    writeStream.on("finish", resolve);
    writeStream.on("error", reject);
  });

  encoder.createReadStream().pipe(writeStream);
  encoder.start();
  encoder.setRepeat(repeat);
  encoder.setDelay(delayMs);
  encoder.setQuality(quality);

  for (let i = 0; i < totalFrames; i += 1) {
    if (i > 0 && i % 10 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    drawFrame(ctx, i, totalFrames, width, height);
    encoder.addFrame(ctx);
  }

  encoder.finish();
  await streamDone;
  return outputGifPath;
}

export async function createSpinningDiscGif(imageUrl, idImage = randomUUID()) {
  const size = 240;
  const fps = 24;
  const totalFrames = 48;
  const outputGif = path.join(tempDir, `spinning_${idImage}.gif`);

  const image = await loadImage(imageUrl);

  return encodeCanvasFramesToGifFile({
    width: size,
    height: size,
    totalFrames,
    delayMs: Math.round(1000 / fps),
    outputGifPath: outputGif,
    drawFrame: (ctx, i, total) => {
      const rotation = (i / total) * Math.PI * 2;
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, size, size);

      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(rotation);
      ctx.beginPath();
      ctx.arc(0, 0, size / 2 - 8, 0, Math.PI * 2);
      ctx.clip();

      const scale = Math.max(size / image.width, size / image.height);
      ctx.drawImage(
        image,
        (-image.width * scale) / 2,
        (-image.height * scale) / 2,
        image.width * scale,
        image.height * scale,
      );
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    },
  });
}

export async function createTextScrollingGif(text, idImage = randomUUID()) {
  ensureCanvasFontsRegistered();
  const cleanText = String(text || "").trim();
  const width = 500;
  const height = 100;
  const fps = 20;
  const outputGif = path.join(tempDir, `scrolling_text_${idImage}.gif`);

  const measureCanvas = createCanvas(width, height);
  const measureCtx = measureCanvas.getContext("2d");
  const fontSpec = 'bold 38px "BeVietnamPro", "Arial", sans-serif';
  measureCtx.font = fontSpec;
  const textWidth = measureCtx.measureText(cleanText).width;

  const totalDistance = width + textWidth;
  // Tối đa 120 frame trên RAM, không cần FFmpeg và không sinh hàng nghìn file PNG tạm
  const totalFrames = Math.min(120, Math.max(28, Math.ceil(totalDistance / 12)));

  return encodeCanvasFramesToGifFile({
    width,
    height,
    totalFrames,
    delayMs: Math.round(1000 / fps),
    outputGifPath: outputGif,
    drawFrame: (ctx, i, total) => {
      const bgGrad = ctx.createLinearGradient(0, 0, width, height);
      bgGrad.addColorStop(0, "#090d16");
      bgGrad.addColorStop(1, "#1e1b4b");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      const progress = i / total;
      const x = width - progress * totalDistance;
      const hue = Math.round((progress * 360) % 360);

      ctx.save();
      ctx.font = fontSpec;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.shadowColor = `hsl(${hue}, 95%, 60%)`;
      ctx.shadowBlur = 12;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(cleanText, x, height / 2);
      ctx.restore();
    },
  });
}

export async function createRandomVibrantGif(idImage = randomUUID()) {
  ensureCanvasFontsRegistered();
  const width = 360;
  const height = 220;
  const totalFrames = 36;
  const outputGif = path.join(tempDir, `vibrant_gif_${idImage}.gif`);

  const themes = [
    { title: "CHÚC MỘT NGÀY VUI VẺ!", hueBase: 195, style: "aurora" },
    { title: "NĂNG LƯỢNG TÍCH CỰC!", hueBase: 320, style: "pulse" },
    { title: "BÙNG NỔ CẢM HỨNG!", hueBase: 35, style: "fireworks" },
    { title: "THƯ GIÃN CÙNG MYBOT!", hueBase: 145, style: "waves" },
    { title: "LUÔN TỎA SÁNG NHÉ!", hueBase: 265, style: "stars" },
  ];
  const chosen = themes[Math.floor(Math.random() * themes.length)];
  const particles = Array.from({ length: 22 }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: 2 + Math.random() * 5,
    vx: (Math.random() - 0.5) * 3,
    vy: -1 - Math.random() * 2.5,
    hueOffset: Math.random() * 90,
  }));

  return encodeCanvasFramesToGifFile({
    width,
    height,
    totalFrames,
    delayMs: 55,
    outputGifPath: outputGif,
    drawFrame: (ctx, i, total) => {
      const t = i / total;
      const hue1 = (chosen.hueBase + t * 120) % 360;
      const hue2 = (hue1 + 75) % 360;

      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, `hsl(${hue1}, 75%, 16%)`);
      bg.addColorStop(1, `hsl(${hue2}, 80%, 24%)`);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // Animated wave rings
      for (let w = 0; w < 3; w += 1) {
        ctx.beginPath();
        ctx.strokeStyle = `hsla(${(hue1 + w * 40) % 360}, 95%, 65%, 0.35)`;
        ctx.lineWidth = 3;
        for (let x = 0; x <= width; x += 12) {
          const y =
            height / 2 +
            Math.sin((x / width) * Math.PI * 3 + t * Math.PI * 2 + w) * (24 + w * 10);
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Floating glowing particles
      for (const p of particles) {
        const py = ((p.y + i * p.vy * 2) % height + height) % height;
        const px = ((p.x + i * p.vx * 2) % width + width) % width;
        ctx.beginPath();
        ctx.arc(px, py, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${(hue1 + p.hueOffset) % 360}, 100%, 72%, 0.85)`;
        ctx.fill();
      }

      // Animated central caption
      const scale = 1 + Math.sin(t * Math.PI * 2) * 0.06;
      ctx.save();
      ctx.translate(width / 2, height / 2);
      ctx.scale(scale, scale);
      ctx.font = 'bold 24px "BeVietnamPro", "Arial", sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = "#0f172a";
      ctx.lineWidth = 5;
      ctx.strokeText(chosen.title, 0, 0, width - 32);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(chosen.title, 0, 0, width - 32);
      ctx.restore();
    },
  });
}

export function createGif360(imagePath, outputGifPath) {
  configureFluentFfmpeg();
  return new Promise((resolve, reject) => {
    const filter = "rotate=PI*2*t/5:c=black@0.0:ow=rotw(iw):oh=roth(ih)";
    const cmd = ffmpeg(imagePath);
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    cmd.setFfmpegPath(ffmpegBin);
    cmd
      .inputOptions("-loop", "1")
      .outputOptions("-vf", filter)
      .outputOptions("-t", "5")
      .outputOptions("-r", "30")
      .outputOptions("-y")
      .save(outputGifPath)
      .on("end", () => resolve(outputGifPath))
      .on("error", reject);
  });
}
