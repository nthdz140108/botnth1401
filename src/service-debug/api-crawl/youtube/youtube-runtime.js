import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import youtubedl from "youtube-dl-exec";

import { getProjectRoot } from "../../../utils/env.js";
import { resolveExecutableSync } from "../../../platform/index.js";
import { getFfmpegExecutableSync } from "../../../utils/runtime-dependencies.js";
import { tempDir } from "../../../utils/io-json.js";
import { getYoutubeAuthOptions } from "./youtube-auth.js";

export function resolveYtDlpCommand({ projectRoot = getProjectRoot(), env = process.env } = {}) {
  const candidates = [
    env.YTDLP_BIN,
    path.join(projectRoot, ".runtime", "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"),
    path.join(projectRoot, ".runtime", "bin", "yt-dlp"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) {
      return { available: true, binaryPath: resolved, custom: true };
    }
  }

  const fromPath = resolveExecutableSync(["yt-dlp"]);
  if (fromPath) {
    return { available: true, binaryPath: fromPath, custom: true };
  }

  const bundled = path.join(
    projectRoot,
    "node_modules",
    "youtube-dl-exec",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
  if (fs.existsSync(bundled)) {
    return { available: true, binaryPath: bundled, custom: false };
  }

  return { available: false, binaryPath: null, custom: false };
}

export function hasYoutubeDenoRuntime(runtime = {}) {
  const env = runtime?.env || process.env;
  const explicit = runtime?.binaryPath || env?.DENO_BIN;
  if (explicit) {
    return fs.existsSync(path.resolve(explicit));
  }
  const local = path.join(
    runtime?.projectRoot || getProjectRoot(),
    ".runtime",
    "bin",
    process.platform === "win32" ? "deno.exe" : "deno"
  );
  if (fs.existsSync(local)) return true;
  const fromPath = resolveExecutableSync(["deno"]);
  return Boolean(fromPath && fs.existsSync(fromPath));
}

function prepareExecutionFlags(flags, runtimeOptions = {}) {
  if (!flags || typeof flags !== "object") return flags;
  const cloned = { ...flags };
  if (cloned.jsRuntimes === "deno:deno" && !hasYoutubeDenoRuntime(runtimeOptions)) {
    delete cloned.jsRuntimes;
  }
  if (!cloned.ffmpegLocation) {
    const ffmpegBin = getFfmpegExecutableSync();
    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
      cloned.ffmpegLocation = ffmpegBin;
    }
  }
  return cloned;
}

function wrapYtDlpExecutor(rawExecutor, runtimeOptions = {}) {
  const wrapped = (target, flags, spawnOptions) =>
    rawExecutor(target, prepareExecutionFlags(flags, runtimeOptions), spawnOptions);

  if (typeof rawExecutor?.exec === "function") {
    wrapped.exec = (target, flags, spawnOptions) =>
      rawExecutor.exec(target, prepareExecutionFlags(flags, runtimeOptions), spawnOptions);
  }
  if (typeof rawExecutor?.create === "function") {
    wrapped.create = rawExecutor.create.bind(rawExecutor);
  }
  return wrapped;
}

export function getYoutubeDlExecutor(options = {}) {
  const resolved = resolveYtDlpCommand(options);
  if (resolved.available && resolved.custom && typeof youtubedl.create === "function") {
    return wrapYtDlpExecutor(youtubedl.create(resolved.binaryPath), options);
  }
  return wrapYtDlpExecutor(youtubedl, options);
}

function resolveJsBinaryPath(runtime = {}) {
  const binaryPath = path.resolve(runtime.binaryPath || process.execPath);

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`JS runtime binary not found at ${binaryPath}`);
  }

  return binaryPath;
}

export function resolveYoutubeNodeBinary(runtime = {}) {
  return resolveJsBinaryPath(runtime);
}

export function resolveYoutubeDenoBinary(runtime = {}) {
  const env = runtime.env || process.env;
  const explicit = runtime.binaryPath || env.DENO_BIN;
  if (explicit) {
    const binary = path.resolve(explicit);
    if (!fs.existsSync(binary)) throw new Error("Deno JS runtime binary not found");
    return binary;
  }
  const local = path.join(
    runtime.projectRoot || getProjectRoot(),
    ".runtime",
    "bin",
    process.platform === "win32" ? "deno.exe" : "deno"
  );
  if (fs.existsSync(local)) return local;
  const fromPath = resolveExecutableSync(["deno"]);
  if (fromPath && fs.existsSync(fromPath)) return fromPath;
  return "deno";
}

export function getYoutubeRuntimeOptions(runtime = {}) {
  return {
    jsRuntimes: `deno:${resolveYoutubeDenoBinary(runtime)}`,
    remoteComponents: "ejs:github",
    noPlaylist: true,
  };
}

export function buildYoutubeDownloadOptions(output, format, options = {}) {
  const audioOnly = /^bestaudio(?:\[|\/|$)/.test(format || "") && !String(format).includes("bestvideo");
  const dlpOptions = { ...getYoutubeDlpOptions(options) };
  if (dlpOptions.jsRuntimes === "deno:deno" && !hasYoutubeDenoRuntime(options.runtime)) {
    delete dlpOptions.jsRuntimes;
  }
  const ffmpegBin = getFfmpegExecutableSync();
  return {
    output,
    format,
    ...(audioOnly
      ? { extractAudio: true, audioFormat: path.extname(output).slice(1) || "m4a" }
      : { mergeOutputFormat: "mp4", postprocessorArgs: "Merger+ffmpeg_o:-c:a aac" }),
    ...(ffmpegBin && fs.existsSync(ffmpegBin) ? { ffmpegLocation: ffmpegBin } : {}),
    noCheckCertificates: true,
    noWarnings: true,
    bufferSize: "16K",
    addHeader: ["referer:youtube.com"],
    ...dlpOptions,
  };
}

export function getYoutubeDlpOptions(options = {}) {
  return {
    ...getYoutubeRuntimeOptions(options.runtime),
    ...getYoutubeAuthOptions(options.env ?? process.env),
  };
}

export async function runYtDlpJson(target, extraFlags = {}, timeoutMs = 25000) {
  const resolved = resolveYtDlpCommand();
  if (!resolved.available) {
    const err = new Error("Chưa cài đặt công cụ yt-dlp trong .runtime/bin hoặc PATH");
    err.code = "MISSING_YTDLP";
    throw err;
  }
  const executor = getYoutubeDlExecutor();
  const flags = {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    noPlaylist: true,
    ...getYoutubeAuthOptions(process.env),
    ...extraFlags,
  };
  return executor(target, flags, { timeout: timeoutMs, windowsHide: true });
}

export async function downloadAudioWithYtDlp(target, options = {}) {
  const resolved = resolveYtDlpCommand();
  if (!resolved.available) {
    const err = new Error("Chưa cài đặt công cụ yt-dlp trong .runtime/bin hoặc PATH");
    err.code = "MISSING_YTDLP";
    throw err;
  }
  const timeoutMs = options.timeoutMs || 60000;
  const executor = getYoutubeDlExecutor();
  const ffmpegBin = getFfmpegExecutableSync();
  await fs.promises.mkdir(tempDir, { recursive: true });
  const jobId = `ytdlp_audio_${randomUUID()}`;
  const outputTemplate = path.join(tempDir, `${jobId}.%(ext)s`);

  const flags = {
    output: outputTemplate,
    format: "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio[ext=aac]/bestaudio/best",
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    ...(ffmpegBin && fs.existsSync(ffmpegBin)
      ? { extractAudio: true, audioFormat: "m4a", ffmpegLocation: ffmpegBin }
      : {}),
    ...getYoutubeAuthOptions(process.env),
  };

  await executor(target, flags, { timeout: timeoutMs, windowsHide: true });
  const entries = await fs.promises.readdir(tempDir);
  const found = entries.find((name) => name.startsWith(jobId) && !name.endsWith(".part") && !name.endsWith(".ytdl"));
  if (!found) {
    throw new Error("Không tìm thấy file âm thanh sau khi tải bằng yt-dlp");
  }
  const finalPath = path.join(tempDir, found);
  const stat = await fs.promises.stat(finalPath);
  if (!stat.size) {
    await fs.promises.unlink(finalPath).catch(() => {});
    throw new Error("File âm thanh tải về bị rỗng");
  }
  return finalPath;
}

export async function downloadVideoWithYtDlp(target, outputPath = null, options = {}) {
  const resolved = resolveYtDlpCommand();
  if (!resolved.available) {
    const err = new Error("Chưa cài đặt công cụ yt-dlp trong .runtime/bin hoặc PATH");
    err.code = "MISSING_YTDLP";
    throw err;
  }
  const timeoutMs = options.timeoutMs || 90000;
  const format =
    options.format ||
    "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best";
  const executor = getYoutubeDlExecutor();
  const ffmpegBin = getFfmpegExecutableSync();
  await fs.promises.mkdir(tempDir, { recursive: true });

  const jobId = `ytdlp_vid_${randomUUID()}`;
  const targetOut = outputPath || path.join(tempDir, `${jobId}.mp4`);
  const outputDir = path.dirname(targetOut);
  await fs.promises.mkdir(outputDir, { recursive: true });

  const flags = {
    output: targetOut,
    format,
    noPlaylist: true,
    noWarnings: true,
    noCheckCertificates: true,
    ...(ffmpegBin && fs.existsSync(ffmpegBin)
      ? { mergeOutputFormat: "mp4", ffmpegLocation: ffmpegBin }
      : {}),
    ...(options.extraFlags || {}),
    ...getYoutubeAuthOptions(process.env),
  };

  await executor(target, flags, { timeout: timeoutMs, windowsHide: true });
  if (fs.existsSync(targetOut) && fs.statSync(targetOut).size > 0) {
    return targetOut;
  }

  const basePrefix = path.basename(targetOut, path.extname(targetOut));
  const dirEntries = await fs.promises.readdir(outputDir);
  const matched = dirEntries.find(
    (name) => name.startsWith(basePrefix) && !name.endsWith(".part") && !name.endsWith(".ytdl")
  );
  if (matched) {
    const matchedPath = path.join(outputDir, matched);
    if (fs.statSync(matchedPath).size > 0) {
      return matchedPath;
    }
  }
  throw new Error("Không tìm thấy file video hợp lệ sau khi tải bằng yt-dlp");
}
