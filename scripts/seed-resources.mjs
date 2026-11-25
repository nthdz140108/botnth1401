#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, "..");

export const RESOURCE_SUBDIRS = Object.freeze([
  "file",
  "image",
  "video",
  "audio",
  "sticker",
  "gif",
]);

export const VIDEO_POOL_SUBDIRS = Object.freeze([
  "vdgirl",
  "vdsexy",
  "vdsex",
  "vdcos",
  "vdanime",
  "vdboy",
  "vdvuto",
  "vdchill",
  "vdsad",
  "vdtet",
]);

const STARTER_STICKER_EXTS = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".mp4"]);

export function parseSeedArgs(argv = process.argv.slice(2)) {
  let root = DEFAULT_ROOT;
  let noSample = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--no-sample") {
      noSample = true;
    } else if (arg === "--root" && argv[i + 1]) {
      root = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg.startsWith("--root=")) {
      root = path.resolve(arg.slice("--root=".length));
    }
  }

  return { root, noSample };
}

export function ensureResourceDirectories(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const createdDirs = [];
  const existingDirs = [];

  for (const subDir of RESOURCE_SUBDIRS) {
    const dirPath = path.join(resolvedRoot, "assets", "resources", subDir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      createdDirs.push(dirPath);
    } else {
      existingDirs.push(dirPath);
    }
  }

  for (const poolDir of VIDEO_POOL_SUBDIRS) {
    const dirPath = path.join(resolvedRoot, "video", poolDir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      createdDirs.push(dirPath);
    } else {
      existingDirs.push(dirPath);
    }
  }

  return {
    root: resolvedRoot,
    createdDirs,
    existingDirs,
  };
}

function hasUsableStickerFile(stickerDir) {
  if (!fs.existsSync(stickerDir)) return false;
  const entries = fs.readdirSync(stickerDir, { withFileTypes: true });
  return entries.some(
    (entry) =>
      entry &&
      !entry.name.startsWith(".") &&
      entry.isFile() &&
      STARTER_STICKER_EXTS.has(path.extname(entry.name).toLowerCase()),
  );
}

export async function ensureStarterSticker(root = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(root);
  const stickerDir = path.join(resolvedRoot, "assets", "resources", "sticker");
  fs.mkdirSync(stickerDir, { recursive: true });

  if (hasUsableStickerFile(stickerDir)) {
    return { created: false, path: null };
  }

  const samplePath = path.join(stickerDir, "sample-hello.webp");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="50%" stop-color="#6366f1" />
      <stop offset="100%" stop-color="#ec4899" />
    </linearGradient>
  </defs>
  <circle cx="256" cy="256" r="228" fill="url(#bg)" stroke="#ffffff" stroke-width="18" />
  <circle cx="186" cy="215" r="22" fill="#ffffff" />
  <circle cx="326" cy="215" r="22" fill="#ffffff" />
  <path d="M 170 295 Q 256 375 342 295" fill="none" stroke="#ffffff" stroke-width="22" stroke-linecap="round" />
  <circle cx="140" cy="262" r="18" fill="#fda4af" opacity="0.85" />
  <circle cx="372" cy="262" r="18" fill="#fda4af" opacity="0.85" />
</svg>`;

  await sharp(Buffer.from(svg))
    .resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .webp({ quality: 88 })
    .toFile(samplePath);

  return { created: true, path: samplePath };
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const { root, noSample } = parseSeedArgs(process.argv.slice(2));
  (async () => {
    const dirSummary = ensureResourceDirectories(root);
    const sampleSticker = noSample
      ? { created: false, path: null }
      : await ensureStarterSticker(root);

    console.log(
      JSON.stringify(
        {
          ok: true,
          root: dirSummary.root,
          createdCount: dirSummary.createdDirs.length,
          existingCount: dirSummary.existingDirs.length,
          sampleSticker,
        },
        null,
        2,
      ),
    );
  })().catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          root,
          error: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  });
}
