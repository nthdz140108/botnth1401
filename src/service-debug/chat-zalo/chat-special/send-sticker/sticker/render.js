import fs from "node:fs";
import sharp from "sharp";
import { createCanvas, registerFont } from "canvas";
import {
  ensureCanvasFontsRegistered,
  resolveCanvasFontPath,
} from "../../../../../utils/canvas/register-fonts.js";

export const STICKER_SIZE = 512;
export const MAX_DURATION_SEC = 8;
export const TARGET_FPS = 15;

const VIETNAMESE_FONT_CANDIDATES = [
  "assets/fonts/BeVietnamPro-Bold.ttf",
  "assets/fonts/UTMAvoBold.ttf",
  "assets/fonts/SVN-Bear.ttf",
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/seguiemj.ttf",
];

function pickFontPath(svgFontPath) {
  const resolved = resolveCanvasFontPath([
    svgFontPath,
    ...VIETNAMESE_FONT_CANDIDATES,
  ]);
  if (resolved) return resolved;
  if (svgFontPath) {
    try {
      if (fs.existsSync(svgFontPath)) return svgFontPath;
    } catch {}
  }
  return null;
}

function resolveStickerFontFamily(fontPath) {
  ensureCanvasFontsRegistered();
  const chosenPath = pickFontPath(fontPath);
  if (fontPath && chosenPath === fontPath) {
    try {
      registerFont(chosenPath, { family: "StickerCustomFont", weight: "bold" });
      return '"StickerCustomFont", "BeVietnamPro", "NotoSans", "Arial", sans-serif';
    } catch {}
  }
  return '"BeVietnamPro", "UTMAvoBold", "NotoSans", "Arial", sans-serif';
}

function wrapText(text, maxChars) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (!current.length) {
      current = word;
      continue;
    }
    if ((current + " " + word).length <= maxChars) {
      current += " " + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length) lines.push(current);
  return lines.slice(0, 8);
}

export async function renderTextSticker({ text, fontPath, width = STICKER_SIZE, height = STICKER_SIZE }) {
  const fontFamily = resolveStickerFontFamily(fontPath);
  const lines = wrapText(text, 18);
  if (lines.length === 0) lines.push("");

  const fontSize = Math.max(18, Math.min(96, Math.floor((width / Math.max(lines.length, 1)) * 0.55)));
  const lineHeight = fontSize * 1.18;
  const totalBlockHeight = lines.length * lineHeight;
  const startY = Math.max(fontSize * 0.75, (height - totalBlockHeight) / 2 + fontSize * 0.55);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const y = startY + index * lineHeight;

    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
    ctx.shadowBlur = 6;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;
    ctx.strokeStyle = "#101010";
    ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.12));
    ctx.strokeText(line, width / 2, y, width - 24);
    ctx.restore();

    ctx.fillStyle = "#ffffff";
    ctx.fillText(line, width / 2, y, width - 24);
  }

  return sharp(canvas.toBuffer("image/png"))
    .ensureAlpha()
    .png()
    .toBuffer();
}

export async function renderTextVideoFrames({ text, color, frames, fontPath }) {
  const fontFamily = resolveStickerFontFamily(fontPath);
  const lines = wrapText(text, 18);
  if (lines.length === 0) lines.push("");

  const fontSize = Math.max(20, Math.min(96, Math.floor((STICKER_SIZE / Math.max(lines.length, 1)) * 0.6)));
  const width = STICKER_SIZE;
  const height = Math.max(STICKER_SIZE, Math.ceil(lines.length * fontSize * 1.25));
  const lineHeight = fontSize * 1.18;
  const startY = Math.max(fontSize * 0.75, (height - lines.length * lineHeight) / 2 + fontSize * 0.55);

  const out = [];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    if (frameIndex > 0 && frameIndex % 10 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const t = frameIndex / Math.max(frames - 1, 1);
    const offsetX = Math.floor(width * 0.6 - width * t);
    let fill = "#ffffff";
    if (color === "rainbow") {
      const hue = Math.floor((t + frameIndex / Math.max(frames, 1)) * 360) % 360;
      fill = `hsl(${hue}, 85%, 60%)`;
    } else if (color) {
      fill = color;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.miterLimit = 2;

    const x = ((offsetX % width) + width) % width;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const y = startY + index * lineHeight;

      ctx.save();
      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = 5;
      ctx.shadowOffsetY = 2;
      ctx.strokeStyle = "#101010";
      ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.12));
      ctx.strokeText(line, x, y);
      ctx.restore();

      ctx.fillStyle = fill;
      ctx.fillText(line, x, y);
    }

    out.push(await sharp(canvas.toBuffer("image/png")).ensureAlpha().png().toBuffer());
  }
  return out;
}

export function hasAnyEffects(plan) {
  if (!plan) return false;
  const meta = plan.meta || {};
  const anim = plan.animation || {};
  return Boolean(
    meta.crop ||
    (meta.zoom !== null && meta.zoom !== 1) ||
    meta.rotate !== 0 ||
    meta.flipHorizontal ||
    meta.flipVertical ||
    meta.pixelSize ||
    meta.roundPercent > 0 ||
    meta.removeBackground ||
    anim.spin ||
    (anim.speed !== null && anim.speed !== 1)
  );
}

export async function applyStaticEffects(input, plan) {
  if (!hasAnyEffects(plan)) {
    return sharp(input)
      .ensureAlpha()
      .resize(STICKER_SIZE, STICKER_SIZE, { fit: "inside", withoutEnlargement: false })
      .png()
      .toBuffer();
  }

  const zoom = plan?.meta?.zoom ?? null;
  const crop = Boolean(plan?.meta?.crop);

  let currentBuffer;

  if (crop) {
    if (zoom !== null && zoom < 1) {
      const scaled = Math.max(1, Math.round(STICKER_SIZE * zoom));
      const resized = await sharp(input)
        .ensureAlpha()
        .resize(scaled, scaled, { fit: "cover", position: "center" })
        .png()
        .toBuffer();
      currentBuffer = await sharp({
        create: {
          width: STICKER_SIZE,
          height: STICKER_SIZE,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([{ input: resized, gravity: "center" }])
        .png()
        .toBuffer();
    } else if (zoom !== null && zoom > 1) {
      const scaled = Math.round(STICKER_SIZE * zoom);
      currentBuffer = await sharp(input)
        .ensureAlpha()
        .resize(scaled, scaled, { fit: "cover", position: "center" })
        .resize(STICKER_SIZE, STICKER_SIZE, { fit: "cover", position: "center" })
        .png()
        .toBuffer();
    } else {
      currentBuffer = await sharp(input)
        .ensureAlpha()
        .resize(STICKER_SIZE, STICKER_SIZE, { fit: "cover", position: "center" })
        .png()
        .toBuffer();
    }
  } else if (zoom !== null) {
    if (zoom < 1) {
      const scaled = Math.max(1, Math.round(STICKER_SIZE * zoom));
      const resized = await sharp(input)
        .ensureAlpha()
        .resize(scaled, scaled, { fit: "inside" })
        .png()
        .toBuffer();
      currentBuffer = await sharp({
        create: {
          width: STICKER_SIZE,
          height: STICKER_SIZE,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([{ input: resized, gravity: "center" }])
        .png()
        .toBuffer();
    } else if (zoom > 1) {
      const scaled = Math.round(STICKER_SIZE * zoom);
      currentBuffer = await sharp(input)
        .ensureAlpha()
        .resize(scaled, scaled, { fit: "inside" })
        .resize(STICKER_SIZE, STICKER_SIZE, { fit: "cover", position: "center" })
        .png()
        .toBuffer();
    } else {
      currentBuffer = await sharp(input)
        .ensureAlpha()
        .resize(STICKER_SIZE, STICKER_SIZE, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
    }
  } else {
    currentBuffer = await sharp(input)
      .ensureAlpha()
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
  }

  let pipeline = sharp(currentBuffer).ensureAlpha();

  const rotate = plan?.meta?.rotate || 0;
  const flipH = Boolean(plan?.meta?.flipHorizontal);
  const flipV = Boolean(plan?.meta?.flipVertical);

  if (flipH) pipeline = pipeline.flop(true);
  if (flipV) pipeline = pipeline.flip(true);

  if (rotate !== 0) {
    const rotated = await pipeline.rotate(rotate, {
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    }).png().toBuffer();
    pipeline = sharp(rotated).resize(STICKER_SIZE, STICKER_SIZE, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  }

  if (plan?.meta?.pixelSize && plan.meta.pixelSize >= 2) {
    const pixel = plan.meta.pixelSize;
    pipeline = pipeline
      .resize(
        Math.max(1, Math.round(STICKER_SIZE / pixel)),
        Math.max(1, Math.round(STICKER_SIZE / pixel)),
        { fit: "fill" }
      )
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: "fill",
        kernel: "nearest",
      });
  }

  if (plan?.meta?.roundPercent && plan.meta.roundPercent > 0) {
    const roundPercent = Math.min(50, Math.max(0, plan.meta.roundPercent));
    const size = STICKER_SIZE;
    const radius = Math.round((roundPercent / 50) * (size / 2));
    const svg = `<svg width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="white"/></svg>`;
    pipeline = pipeline.composite([{ input: Buffer.from(svg), blend: "dest-in" }]);
  }

  return pipeline.png().toBuffer();
}

export async function compositeSpinFrames(framesBuffer, spin = { frameCount: 24 }) {
  const frameCount = spin?.frameCount || 24;
  const frames = [];
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const angle = (frameIndex / frameCount) * 360;
    const rotated = await sharp(framesBuffer)
      .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .resize(STICKER_SIZE, STICKER_SIZE, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    frames.push(rotated);
  }
  return frames;
}

export async function applyEffectsToFrames(frameBuffers, plan) {
  const total = frameBuffers.length;
  const hasGeometric = Boolean(
    plan.meta.crop ||
    plan.meta.zoom !== null ||
    plan.meta.rotate !== 0 ||
    plan.meta.flipHorizontal ||
    plan.meta.flipVertical ||
    plan.meta.pixelSize ||
    plan.meta.roundPercent > 0
  );

  return Promise.all(
    frameBuffers.map(async (buf, index) => {
      let frame = buf;
      if (hasGeometric) {
        frame = await applyStaticEffects(frame, plan);
      }
      if (plan.animation.spin) {
        const angle = (index / Math.max(total, 1)) * 360;
        frame = await sharp(frame)
          .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .resize(STICKER_SIZE, STICKER_SIZE, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();
      }
      return frame;
    })
  );
}

export const __test = {
  wrapText,
  pickFontPath,
  STICKER_SIZE,
  MAX_DURATION_SEC,
  TARGET_FPS,
  hasAnyEffects,
};
