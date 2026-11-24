import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";

import { tempDir } from "../../../utils/io-json.js";
import { buildYoutubeSendVideoPayload } from "./youtube-send-payload.js";
import { getYoutubeDlExecutor, getYoutubeDlpOptions, getYoutubeRuntimeOptions, resolveYoutubeDenoBinary } from "./youtube-runtime.js";
export { getYoutubeRuntimeOptions, resolveYoutubeDenoBinary } from "./youtube-runtime.js";

const defaultYoutubeExecutor = getYoutubeDlExecutor();

export const YOUTUBE_AUDIO_FORMAT = "bestaudio[ext=aac]/bestaudio[ext=m4a]/bestaudio/best";
export const YOUTUBE_FORMAT_360 = "bestvideo[height<=360][vcodec^=avc1]+bestaudio/best[height<=360][vcodec^=avc1]/bestvideo[height<=360]+bestaudio/best[height<=360]/best";
export const YOUTUBE_FORMAT_720 = "bestvideo[height<=720][fps<=60][vcodec^=avc1]+bestaudio/best[height<=720][fps<=60][vcodec^=avc1]/bestvideo[height<=720]+bestaudio/best[height<=720]/best";
export const YOUTUBE_FORMAT_1080 = "bestvideo[height<=1080][fps<=60][vcodec^=avc1]+bestaudio/best[height<=1080][fps<=60][vcodec^=avc1]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best";
export const YOUTUBE_FORMAT_MAX = "bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/bestvideo+bestaudio/best";

export function normalizeYoutubeWorkflowError(stage, error) {
  const reason = error?.message || String(error);
  const normalized = new Error(`[youtube:${stage}] ${reason}`);
  normalized.stage = stage;
  normalized.cause = error;
  return normalized;
}

export function classifyYoutubeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  if (message.includes("unavailable") || message.includes("private") || message.includes("region") || message.includes("copyright")) {
    return "unavailable";
  }
  if (message.includes("timeout") || message.includes("etimedout")) {
    return "timeout";
  }
  if (message.includes("cookie") || message.includes("signin") || message.includes("sign in") || message.includes("auth")) {
    return "auth";
  }
  if (message.includes("deno") || message.includes("spawn") || message.includes("not found")) {
    return "runtime";
  }
  return "generic";
}

export function ensureNonEmptyFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`download file missing: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (!size) {
    throw new Error(`download file empty: ${filePath}`);
  }
}

export function ensureUploadResult(uploadResult) {
  const attachment = Array.isArray(uploadResult) ? uploadResult[0] : uploadResult;
  const fileUrl = attachment?.fileUrl || attachment?.normalUrl || attachment?.hdUrl || attachment?.url;
  if (typeof fileUrl !== "string" || !fileUrl.trim()) {
    throw normalizeYoutubeWorkflowError("upload", new Error("upload result missing usable video URL"));
  }
  return fileUrl;
}

export function buildYoutubeProcessingCaption(qualityText) {
  if (qualityText) {
    return `**Chờ bé lấy video một chút, xong bé gọi cho hay!**\n📊 **Chất lượng:** ${qualityText}`;
  }
  return `**Chờ bé lấy video một chút, xong bé gọi cho hay!**`;
}

export function buildYoutubeVideoCaption({ senderName, title, channelName, viewCount, publishedTime, qualityText }) {
  return `[ ${senderName || ""} ]\n🎵 Tiêu Đề: ${title || "Không xác định"}\n📺 Kênh: ${channelName || "Không xác định"}\n👀 Lượt Xem: ${String(viewCount || "0").replace("views", "").trim()}\n📅 Ngày Đăng: ${publishedTime || "Không xác định"}\n[ Watch More On Youtube ]`;
}

export function createYoutubeJobDir(jobType, jobId) {
  return path.join(tempDir, `youtube-${jobType}_${jobId}`);
}

function buildYoutubeMetadataOptions(options = {}) {
  return {
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificate: true,
    preferFreeFormats: true,
    ...getYoutubeDlpOptions(options),
  };
}

function buildYoutubeSearchOptions(options = {}) {
  return {
    dumpSingleJson: true,
    flatPlaylist: true,
    skipDownload: true,
    noWarnings: true,
    noCheckCertificate: true,
    ...getYoutubeDlpOptions(options),
  };
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function normalizeYoutubeSearchResult(raw = {}) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  return entries
    .filter((entry) => YOUTUBE_VIDEO_ID.test(String(entry?.id || "")))
    .filter((entry) => entry?.title && entry?.duration != null && !entry?.is_live)
    .map((entry) => normalizeYoutubeVideoInfo({
      ...entry,
      videoId: entry.id,
      webpage_url: entry.webpage_url || `https://www.youtube.com/watch?v=${entry.id}`,
      channelName: entry.channel || entry.uploader || entry.channel_name,
      viewCount: entry.view_count,
      publishedTime: entry.upload_date || entry.release_timestamp,
    }));
}

export async function runYoutubeSearch(query, limit = 10, executor = defaultYoutubeExecutor) {
  const boundedLimit = Math.max(1, Math.min(10, Number.parseInt(limit, 10) || 10));
  const searchTarget = `ytsearch${boundedLimit}:${String(query || "").trim()}`;
  if (!String(query || "").trim()) return [];
  const raw = await runYoutubeDlp(searchTarget, buildYoutubeSearchOptions(), 30000, "search", executor);
  return normalizeYoutubeSearchResult(raw).slice(0, boundedLimit);
}

export async function runYoutubeMetadata(videoUrl, timeoutMs = 30000, executor = defaultYoutubeExecutor) {
  return await runYoutubeDlp(videoUrl, buildYoutubeMetadataOptions(), timeoutMs, "metadata", executor);
}

export async function runYoutubeDlp(videoUrl, flags, timeoutMs = 30000, stage = "metadata", executor = defaultYoutubeExecutor) {
  try {
    return await executor(videoUrl, flags, { timeout: timeoutMs });
  } catch (error) {
    throw normalizeYoutubeWorkflowError(stage, error);
  }
}

export function normalizeYoutubeVideoInfo(raw = {}) {
  return {
    videoId: raw.videoId || raw.id || "",
    title: raw.title || "",
    url: raw.webpage_url || raw.url || "",
    duration: raw.duration ?? null,
    thumbnail: raw.thumbnail || raw.thumbnails?.[0]?.url || "",
    channelName: raw.channelName || raw.channel || "",
    channelId: raw.channelId || raw.channel_id || "",
    description: raw.description || "",
    viewCount: raw.viewCount ?? raw.view_count ?? null,
    likeCount: raw.likeCount ?? raw.like_count ?? null,
    commentCount: raw.commentCount ?? raw.comment_count ?? null,
    publishedTime: raw.publishedTime || raw.upload_date || "",
    categories: raw.categories || [],
    tags: raw.tags || [],
    isLive: raw.isLive ?? raw.is_live ?? false,
  };
}

export async function runYoutubeVideoInfo(videoUrl, timeoutMs = 30000, executor = defaultYoutubeExecutor) {
  try {
    const raw = await runYoutubeDlp(videoUrl, buildYoutubeMetadataOptions(), timeoutMs, "metadata", executor);
    return normalizeYoutubeVideoInfo(raw);
  } catch (error) {
    if (String(error?.message || "").includes("Deno binary not found")) {
      const runtimeError = new Error(error.message);
      runtimeError.stage = "runtime";
      runtimeError.cause = error;
      throw runtimeError;
    }
    throw error;
  }
}

export async function runYoutubeDownload(videoUrl, videoPath, format, timeoutMs = 300000) {
  try {
    await runYoutubeWorkerDownload({ videoUrl, videoPath, format, timeoutMs });
    ensureNonEmptyFile(videoPath);
    return videoPath;
  } catch (error) {
    await cleanupYoutubeFiles([videoPath, `${videoPath}.part`, `${videoPath}.ytdl`]).catch(() => {});
    throw error;
  }
}

export async function runYoutubeWorkerDownload({ videoUrl, videoPath, format, timeoutMs = 300000 }) {
  let settled = false;
  let worker;
  const settleOnce = (resolve, reject, result) => {
    if (settled) return;
    settled = true;
    if (result.success) resolve(result.videoPath);
    else reject(new Error(result.error));
  };

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (worker) worker.terminate().catch(() => {});
      settleOnce(resolve, reject, { success: false, error: `worker timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    worker = new Worker(new URL("./youtube-download-worker.js", import.meta.url), {
      workerData: { videoUrl, videoPath, format, timeoutMs },
    });

    worker.on("message", (result) => {
      clearTimeout(timeout);
      settleOnce(resolve, reject, result);
      worker.terminate().catch(() => {});
    });
    worker.on("error", (error) => {
      clearTimeout(timeout);
      settleOnce(resolve, reject, { success: false, error: error.message });
      worker?.terminate().catch(() => {});
    });
    worker.on("exit", (code) => {
      clearTimeout(timeout);
      if (!settled && code !== 0) {
        settleOnce(resolve, reject, { success: false, error: `Worker stopped with exit code ${code}` });
      }
      worker?.terminate().catch(() => {});
    });
  });
}

export function buildYoutubePayloadBase({ videoUrl, threadId, threadType, thumbnail, duration, message, ttl, alreadyUploaded = false }) {
  return buildYoutubeSendVideoPayload({
    videoUrl,
    threadId,
    threadType,
    thumbnail,
    duration,
    message,
    ttl,
    sendOptions: alreadyUploaded ? { videoAlreadyUploaded: true } : {},
  });
}

export async function cleanupYoutubeFiles(paths = []) {
  for (const filePath of paths) {
    if (filePath) {
      try {
        const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
        if (!stat) continue;
        if (stat.isDirectory()) {
          fs.rmSync(filePath, { recursive: true, force: true });
        } else {
          await fs.promises.rm(filePath, { force: true });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}
