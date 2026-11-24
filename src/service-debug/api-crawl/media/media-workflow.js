import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { tempDir } from "../../../utils/io-json.js";

export function createMediaJobDir(platform, scope = "default") {
  const safePlatform = String(platform || "media").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const safeScope = String(scope || "default").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return path.join(tempDir, `${safePlatform}-${safeScope}-${randomUUID()}`);
}

export async function ensureMediaJobDir(jobDir) {
  await fs.promises.mkdir(jobDir, { recursive: true });
  return jobDir;
}

export async function cleanupMediaFiles(paths = []) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  for (const filePath of uniquePaths) {
    try {
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await fs.promises.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.promises.rm(filePath, { force: true });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export function withMediaMetadata(raw = {}, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    id: String(source.id || source.videoId || fallback.id || randomUUID()),
    title: String(source.title || fallback.title || "Unknown Title"),
    author: String(source.author || source.artist || fallback.author || "Unknown Artist"),
    thumbnail: String(source.thumbnail || fallback.thumbnail || ""),
    url: String(source.url || fallback.url || ""),
    duration: Number.isFinite(source.duration) ? source.duration : (Number.isFinite(fallback.duration) ? fallback.duration : 0),
    quality: String(source.quality || fallback.quality || "default"),
    type: String(source.type || fallback.type || "video"),
    description: String(source.description || source.desc || fallback.description || fallback.title || ""),
    extra: {
      ...fallback.extra,
      ...source.extra,
    },
  };
}
