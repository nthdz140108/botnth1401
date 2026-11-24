import ffmpeg from "fluent-ffmpeg";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

import { STICKER_SIZE, MAX_DURATION_SEC, TARGET_FPS } from "./render.js";
import { getFfmpegExecutableSync } from "../../../../../utils/runtime-dependencies.js";

export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export async function generatePreviewPng(input) {
  return await sharp(input)
    .ensureAlpha()
    .resize(STICKER_SIZE, STICKER_SIZE, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();
}

export async function encodeStaticWebp({ input, quality = 80 }) {
  let q = quality;
  let buffer = await sharp(input)
    .resize(STICKER_SIZE, STICKER_SIZE, {
      fit: "inside",
      withoutEnlargement: false,
    })
    .webp({ quality: q, effort: 4 })
    .toBuffer();

  if (buffer.length > MAX_OUTPUT_BYTES && q > 65) {
    q = 65;
    buffer = await sharp(input)
      .resize(STICKER_SIZE, STICKER_SIZE, { fit: "inside", withoutEnlargement: false })
      .webp({ quality: q, effort: 4 })
      .toBuffer();
  }
  if (buffer.length > MAX_OUTPUT_BYTES && q > 50) {
    q = 50;
    buffer = await sharp(input)
      .resize(STICKER_SIZE, STICKER_SIZE, { fit: "inside", withoutEnlargement: false })
      .webp({ quality: q, effort: 4 })
      .toBuffer();
  }
  if (buffer.length > MAX_OUTPUT_BYTES) {
    const err = new Error("Media quá phức tạp để gửi sticker");
    err.code = "MEDIA_TOO_COMPLEX";
    throw err;
  }
  return buffer;
}

export async function getWebpMetadata(buffer) {
  try {
    const meta = await sharp(buffer, { animated: true }).metadata();
    if (meta?.width && meta?.height) {
      const pageHeight = meta.pageHeight || (meta.pages ? Math.round(meta.height / meta.pages) : meta.height);
      return {
        width: meta.width,
        height: pageHeight,
        totalSize: buffer.length,
        format: meta.format,
        pages: meta.pages || 1,
        duration: meta.pages ? (meta.pages / TARGET_FPS) * 1000 : 0,
      };
    }
  } catch {}

  const tmpPath = `${(globalThis.process?.env?.TEMP ?? "/tmp")}/sticker-meta-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`;
  await fs.promises.writeFile(tmpPath, buffer);
  try {
    const { getVideoMetadata } = await import("../../../../../api-zalo/utils.js");
    return await getVideoMetadata(tmpPath);
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

function ffmpegCommand(input, outputPath, options, inputOptions = []) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(input);
    const ffmpegBin = getFfmpegExecutableSync();
    if (ffmpegBin) {
      cmd.setFfmpegPath(ffmpegBin);
    }
    if (Array.isArray(inputOptions) && inputOptions.length > 0) {
      cmd.inputOptions(inputOptions);
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        cmd.kill("SIGKILL");
      } catch {}
      reject(new Error("FFmpeg sticker encode timed out after 30s"));
    }, 30000);

    cmd
      .outputOptions(options)
      .toFormat("webp")
      .on("start", (command) => console.log("FFmpeg:", command))
      .on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      })
      .on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      })
      .save(outputPath);
  });
}

async function encodeFallbackWebpFromFrames(framesDir, outputPath, quality = 80) {
  const entries = (await fs.promises.readdir(framesDir))
    .filter((file) => file.endsWith(".png"))
    .sort();
  if (!entries.length) {
    throw new Error("Không tìm thấy khung hình để tạo sticker");
  }
  const firstFramePath = path.join(framesDir, entries[0]);
  const webpBuffer = await encodeStaticWebp({ input: firstFramePath, quality });
  await fs.promises.writeFile(outputPath, webpBuffer);
}

export function isFfmpegMissingError(error) {
  if (!error) return false;
  const msg = String(error?.message || "");
  const code = String(error?.code || error?.status || error?.exitCode || "");
  return (
    error?.code === "ENOENT" ||
    code === "3221225785" ||
    code === "VIDEO_TOOL_MISSING" ||
    code === "0xC0000139" ||
    code === "ENTRYPOINT_NOT_FOUND" ||
    code.includes("ENTRYPOINT_NOT_FOUND") ||
    msg.includes("3221225785") ||
    msg.includes("0xC0000139") ||
    msg.includes("ENTRYPOINT_NOT_FOUND") ||
    /Cannot find ffmpeg|spawn .* ENOENT|ffmpeg.*not found/i.test(msg)
  );
}

export async function encodeAnimatedWebp({
  framesDir,
  outputPath,
  fps = TARGET_FPS,
  duration = MAX_DURATION_SEC,
  quality = 80,
  speed = 1,
}) {
  const framePattern = `${framesDir}/frame_%04d.png`;
  const vfFilters = [];
  if (speed && Number(speed) !== 1) {
    vfFilters.push(`setpts=PTS/${speed}`);
  }
  vfFilters.push(`fps=${fps}`);
  vfFilters.push(`scale=${STICKER_SIZE}:-2:flags=lanczos`);

  const inputOptions = ["-framerate", String(fps)];
  const options = [
    "-c:v", "libwebp",
    "-lossless", "0",
    "-compression_level", "4",
    "-q:v", String(quality),
    "-loop", "0",
    "-preset", "default",
    "-an",
    "-y",
    "-vf", vfFilters.join(","),
    "-t", String(duration),
  ];
  try {
    await ffmpegCommand(framePattern, outputPath, options, inputOptions);
  } catch (error) {
    if (isFfmpegMissingError(error)) {
      await encodeFallbackWebpFromFrames(framesDir, outputPath, quality);
      return;
    }
    throw error;
  }
}

export async function encodeAdaptiveAnimatedWebp({
  framesDir,
  outputPath,
  baseFps = TARGET_FPS,
  baseQuality = 80,
  duration = MAX_DURATION_SEC,
  speed = 1,
}) {
  const qualityLadder = [baseQuality, 65, 50];
  const fpsLadder = [baseFps, 12, 10];
  let lastError;
  for (let qIndex = 0; qIndex < qualityLadder.length; qIndex += 1) {
    for (let fIndex = 0; fIndex < fpsLadder.length; fIndex += 1) {
      const quality = qualityLadder[qIndex];
      const fps = fpsLadder[fIndex];
      try {
        await encodeAnimatedWebp({
          framesDir,
          outputPath,
          fps,
          quality,
          duration,
          speed,
        });
        const stat = await fs.promises.stat(outputPath);
        if (stat.size <= MAX_OUTPUT_BYTES) {
          return { quality, fps, size: stat.size };
        }
      } catch (error) {
        lastError = error;
      }
    }
  }
  const stat = await fs.promises.stat(outputPath).catch(() => null);
  if (stat?.size > MAX_OUTPUT_BYTES) {
    const err = new Error("Media quá phức tạp để gửi sticker");
    err.code = "MEDIA_TOO_COMPLEX";
    throw err;
  }
  if (lastError) throw lastError;
  return { quality: baseQuality, fps: baseFps };
}

export const __test = { MAX_OUTPUT_BYTES, STICKER_SIZE, MAX_DURATION_SEC, TARGET_FPS };
