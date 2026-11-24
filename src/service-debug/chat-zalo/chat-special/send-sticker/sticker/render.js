import fs from "node:fs";
import sharp from "sharp";

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
  if (svgFontPath) return svgFontPath;
  for (const candidate of VIETNAMESE_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

function escapeXml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
  const lines = wrapText(text, 18);
  if (lines.length === 0) lines.push("");
  const fontSize = Math.max(18, Math.floor((width / Math.max(lines.length, 1)) * 0.6));
  const svgLines = lines
    .map((line, index) => {
      const yOffset = (index + 0.7) * fontSize * 1.1;
      return (
        `<text x="50%" y="${yOffset}" text-anchor="middle" ` +
        `font-family="sans-serif" font-size="${fontSize}" font-weight="700" ` +
        `fill="#ffffff" stroke="#101010" stroke-width="3" paint-order="stroke">` +
        escapeXml(line) +
        `</text>`
      );
    })
    .join("");

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
      <feOffset dx="0" dy="2" result="offset" />
      <feComponentTransfer><feFuncA type="linear" slope="0.55" /></feComponentTransfer>
      <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>
  <g filter="url(#shadow)">${svgLines}</g>
</svg>`;

  return sharp(Buffer.from(svg))
    .ensureAlpha()
    .png()
    .toBuffer();
}

export async function renderTextVideoFrames({ text, color, frames }) {
  const lines = wrapText(text, 18);
  if (lines.length === 0) lines.push("");
  const fontSize = Math.max(20, Math.floor((STICKER_SIZE / Math.max(lines.length, 1)) * 0.7));
  const width = STICKER_SIZE;
  const height = Math.max(STICKER_SIZE, lines.length * fontSize * 1.2);
  const out = [];
  for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
    const t = frameIndex / Math.max(frames - 1, 1);
    const offsetX = Math.floor((width * 0.6) - width * t);
    let fill = "#ffffff";
    if (color === "rainbow") {
      const hue = Math.floor((t + frameIndex / frames) * 360) % 360;
      fill = `hsl(${hue},85%,60%)`;
    } else {
      fill = color;
    }
    const svgLines = lines
      .map((line, index) => {
        const yOffset = (index + 0.7) * fontSize * 1.1;
        return (
          `<text x="${(offsetX + width) % width}" y="${yOffset}" text-anchor="start" ` +
          `font-family="sans-serif" font-size="${fontSize}" font-weight="700" ` +
          `fill="${fill}" stroke="#101010" stroke-width="3" paint-order="stroke">` +
          escapeXml(line) +
          `</text>`
        );
      })
      .join("");
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3" />
      <feOffset dx="0" dy="2" result="offset" />
      <feComponentTransfer><feFuncA type="linear" slope="0.55" /></feComponentTransfer>
      <feMerge><feMergeNode /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>
  <g filter="url(#shadow)">${svgLines}</g>
</svg>`;
    out.push(await sharp(Buffer.from(svg)).ensureAlpha().png().toBuffer());
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
