#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, "..");

const DOWNLOAD_SOURCES = Object.freeze({
  win32: Object.freeze({
    x64: Object.freeze({
      ffmpegArchives: Object.freeze([
        {
          url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
          format: "zip",
        },
        {
          url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
          format: "zip",
        },
      ]),
      ytDlpUrl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe",
    }),
  }),
  linux: Object.freeze({
    x64: Object.freeze({
      ffmpegArchives: Object.freeze([
        {
          url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
          format: "tar.xz",
        },
        {
          url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
          format: "tar.xz",
        },
      ]),
      ytDlpUrl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux",
    }),
    arm64: Object.freeze({
      ffmpegArchives: Object.freeze([
        {
          url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz",
          format: "tar.xz",
        },
        {
          url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz",
          format: "tar.xz",
        },
      ]),
      ytDlpUrl: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64",
    }),
  }),
});

export function parseMediaSetupArgs(argv = process.argv.slice(2)) {
  let verifyOnly = false;
  let root = DEFAULT_ROOT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (arg === "--verify-only") {
      verifyOnly = true;
    } else if (arg === "--root" && argv[i + 1]) {
      root = path.resolve(String(argv[i + 1]));
      i += 1;
    } else if (arg.startsWith("--root=")) {
      root = path.resolve(arg.slice("--root=".length));
    }
  }

  return { verifyOnly, root };
}

function getBinaryFileName(toolName, platform = process.platform) {
  return platform === "win32" ? `${toolName}.exe` : toolName;
}

function probeBinary(candidate, probeArgs, cwd) {
  if (!candidate) return null;
  try {
    const stdout = execFileSync(candidate, probeArgs, {
      cwd,
      env: process.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
      windowsHide: true,
    });
    const firstLine = String(stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return {
      available: true,
      path: candidate,
      version: firstLine || "verified",
    };
  } catch {
    return null;
  }
}

function inspectTool(toolName, { root, platform = process.platform }) {
  const binDir = path.join(path.resolve(root), ".runtime", "bin");
  const localBin = path.join(binDir, getBinaryFileName(toolName, platform));
  const probeArgs = toolName === "yt-dlp" ? ["--version"] : ["-version"];

  const envMap = {
    ffmpeg: process.env.FFMPEG_BIN,
    ffprobe: process.env.FFPROBE_BIN,
    "yt-dlp": process.env.YTDLP_BIN || process.env.YT_DLP_BIN,
  };

  const candidates = [
    fs.existsSync(localBin) ? localBin : null,
    envMap[toolName] || null,
    toolName,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const probed = probeBinary(candidate, probeArgs, root);
    if (probed) {
      return {
        ...probed,
        source: candidate === localBin ? "runtime-bin" : "system",
      };
    }
  }

  return {
    available: false,
    path: null,
    version: null,
    source: null,
  };
}

export function verifyMediaTools({ root = DEFAULT_ROOT, platform = process.platform } = {}) {
  const resolvedRoot = path.resolve(root);
  const binDir = path.join(resolvedRoot, ".runtime", "bin");
  const tools = {
    ffmpeg: inspectTool("ffmpeg", { root: resolvedRoot, platform }),
    ffprobe: inspectTool("ffprobe", { root: resolvedRoot, platform }),
    "yt-dlp": inspectTool("yt-dlp", { root: resolvedRoot, platform }),
  };

  const ok = Object.values(tools).every((tool) => tool.available);
  return {
    ok,
    root: resolvedRoot,
    binDir,
    platform,
    arch: process.arch,
    tools,
  };
}

async function downloadToFile(url, destinationPath, timeoutMs = 240000) {
  const partPath = `${destinationPath}.part`;
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "User-Agent": "MYBOT-MediaSetup/3.0",
      },
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} when downloading ${url}`);
    }
    const writeStream = fs.createWriteStream(partPath);
    await pipeline(Readable.fromWeb(response.body), writeStream);
    const stat = await fs.promises.stat(partPath);
    if (!stat || stat.size <= 0) {
      throw new Error(`Downloaded empty file from ${url}`);
    }
    await fs.promises.rename(partPath, destinationPath);
  } catch (error) {
    await fs.promises.unlink(partPath).catch(() => {});
    throw error;
  }
}

function findFileRecursive(dirPath, targetFileName) {
  const targetLower = targetFileName.toLowerCase();
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileRecursive(fullPath, targetFileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.toLowerCase() === targetLower) {
      return fullPath;
    }
  }
  return null;
}

function extractArchive(archivePath, extractDir, format, platform = process.platform) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (format === "zip") {
    try {
      execFileSync("tar", ["-xf", archivePath, "-C", extractDir], {
        stdio: "ignore",
        timeout: 180000,
        windowsHide: true,
      });
      return;
    } catch {
      if (platform !== "win32") {
        execFileSync("unzip", ["-q", "-o", archivePath, "-d", extractDir], {
          stdio: "ignore",
          timeout: 180000,
        });
        return;
      }
      const escapedZip = archivePath.replace(/'/g, "''");
      const escapedDest = extractDir.replace(/'/g, "''");
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${escapedZip}', '${escapedDest}')`,
        ],
        {
          stdio: "ignore",
          timeout: 180000,
          windowsHide: true,
        },
      );
      return;
    }
  }

  if (format === "tar.xz") {
    execFileSync("tar", ["-xJf", archivePath, "-C", extractDir], {
      stdio: "ignore",
      timeout: 180000,
      windowsHide: true,
    });
    return;
  }

  throw new Error(`Unsupported archive format: ${format}`);
}

function ensureExecutablePermissions(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Ignore chmod limitations on Windows filesystems
  }
}

async function installFfmpegSuite({ binDir, platformConfig, platform }) {
  const tempWorkDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mybot-ffmpeg-setup-"));
  let lastError = null;
  try {
    for (const source of platformConfig.ffmpegArchives) {
      const archiveExt = source.format === "zip" ? ".zip" : ".tar.xz";
      const archivePath = path.join(tempWorkDir, `ffmpeg${archiveExt}`);
      const extractDir = path.join(tempWorkDir, `extract_${Date.now()}`);
      try {
        await downloadToFile(source.url, archivePath);
        extractArchive(archivePath, extractDir, source.format, platform);

        const ffmpegName = getBinaryFileName("ffmpeg", platform);
        const ffprobeName = getBinaryFileName("ffprobe", platform);
        const foundFfmpeg = findFileRecursive(extractDir, ffmpegName);
        const foundFfprobe = findFileRecursive(extractDir, ffprobeName);

        if (!foundFfmpeg || !foundFfprobe) {
          throw new Error(`Archive from ${source.url} did not contain both ${ffmpegName} and ${ffprobeName}`);
        }

        const destFfmpeg = path.join(binDir, ffmpegName);
        const destFfprobe = path.join(binDir, ffprobeName);
        await fs.promises.mkdir(binDir, { recursive: true });
        await fs.promises.copyFile(foundFfmpeg, destFfmpeg);
        await fs.promises.copyFile(foundFfprobe, destFfprobe);
        ensureExecutablePermissions(destFfmpeg);
        ensureExecutablePermissions(destFfprobe);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Failed to download and extract ffmpeg/ffprobe");
  } finally {
    await fs.promises.rm(tempWorkDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function installYtDlp({ binDir, platformConfig, platform }) {
  const ytDlpName = getBinaryFileName("yt-dlp", platform);
  const destPath = path.join(binDir, ytDlpName);
  await fs.promises.mkdir(binDir, { recursive: true });
  await downloadToFile(platformConfig.ytDlpUrl, destPath, 120000);
  ensureExecutablePermissions(destPath);
}

export async function setupMediaTools({
  verifyOnly = false,
  root = DEFAULT_ROOT,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const initial = verifyMediaTools({ root: resolvedRoot, platform });
  if (verifyOnly || initial.ok) {
    return {
      ...initial,
      verifyOnly,
      installed: [],
      errors: [],
    };
  }

  const platformConfig = DOWNLOAD_SOURCES[platform]?.[arch];
  if (!platformConfig) {
    return {
      ...initial,
      verifyOnly,
      installed: [],
      errors: [`Unsupported platform/arch for automatic static media download: ${platform}/${arch}`],
    };
  }

  const binDir = path.join(resolvedRoot, ".runtime", "bin");
  const installed = [];
  const errors = [];

  if (!initial.tools.ffmpeg.available || !initial.tools.ffprobe.available) {
    try {
      await installFfmpegSuite({ binDir, platformConfig, platform });
      installed.push("ffmpeg", "ffprobe");
    } catch (error) {
      errors.push(`ffmpeg/ffprobe: ${error?.message || String(error)}`);
    }
  }

  if (!initial.tools["yt-dlp"].available) {
    try {
      await installYtDlp({ binDir, platformConfig, platform });
      installed.push("yt-dlp");
    } catch (error) {
      errors.push(`yt-dlp: ${error?.message || String(error)}`);
    }
  }

  const finalState = verifyMediaTools({ root: resolvedRoot, platform });
  return {
    ...finalState,
    verifyOnly,
    installed,
    errors,
  };
}

const isDirectExecution =
  Boolean(process.argv[1]) &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
  const { verifyOnly, root } = parseMediaSetupArgs(process.argv.slice(2));
  setupMediaTools({ verifyOnly, root })
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      if (!verifyOnly && !summary.ok) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(
        JSON.stringify(
          {
            ok: false,
            verifyOnly,
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
