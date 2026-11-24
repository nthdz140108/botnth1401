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

// Backward-compatible export name used by youtube-core.js
export function resolveYoutubeDenoBinary(runtime = {}) {
  return resolveJsBinaryPath(runtime);
}

export function getYoutubeRuntimeOptions(runtime = {}) {
  return {
    jsRuntimes: `node:${resolveJsBinaryPath(runtime)}`,
    remoteComponents: "ejs:github",
    extractorArgs: "youtube:player_client=android,web",
  };
}

export function getYoutubeDlpOptions(options = {}) {
  return {
    ...getYoutubeRuntimeOptions(options.runtime),
    ...getYoutubeAuthOptions(options.env ?? process.env),
  };
}
