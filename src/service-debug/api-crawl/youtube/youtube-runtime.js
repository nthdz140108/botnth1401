import fs from "node:fs";
import path from "node:path";
import youtubedl from "youtube-dl-exec";

import { getProjectRoot } from "../../../utils/env.js";
import { resolveExecutableSync } from "../../../platform/index.js";
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

export function getYoutubeDlExecutor(options = {}) {
  const resolved = resolveYtDlpCommand(options);
  if (resolved.available && resolved.custom && typeof youtubedl.create === "function") {
    return youtubedl.create(resolved.binaryPath);
  }
  return youtubedl;
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
    if (!fs.existsSync(binary)) throw new Error('Deno JS runtime binary not found');
    return binary;
  }
  const local = path.join(runtime.projectRoot || getProjectRoot(), '.runtime', 'bin', process.platform === 'win32' ? 'deno.exe' : 'deno');
  return fs.existsSync(local) ? local : 'deno';
}

export function getYoutubeRuntimeOptions(runtime = {}) {
  return {
    jsRuntimes: `deno:${resolveYoutubeDenoBinary(runtime)}`,
    remoteComponents: "ejs:github",
    noPlaylist: true,
  };
}

export function buildYoutubeDownloadOptions(output, format, options = {}) {
  const audioOnly = /^bestaudio(?:\[|\/|$)/.test(format || '') && !String(format).includes('bestvideo');
  return {
    output, format,
    ...(audioOnly ? { extractAudio: true, audioFormat: path.extname(output).slice(1) || 'm4a' } : { mergeOutputFormat: 'mp4', postprocessorArgs: 'Merger+ffmpeg_o:-c:a aac' }),
    noCheckCertificates: true,
    noWarnings: true,
    bufferSize: '16K',
    addHeader: ['referer:youtube.com'],
    ...getYoutubeDlpOptions(options),
  };
}

export function getYoutubeDlpOptions(options = {}) {
  return {
    ...getYoutubeRuntimeOptions(options.runtime),
    ...getYoutubeAuthOptions(options.env ?? process.env),
  };
}
