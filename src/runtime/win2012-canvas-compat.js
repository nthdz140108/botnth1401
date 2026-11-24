import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { isLegacyWindowsConsole } from "./windows-console-guard.js";

const WIN2012_CANVAS_PREBUILD_URL =
  "https://github.com/Automattic/node-canvas/releases/download/v2.11.2/canvas-v2.11.2-node-v115-win32-unknown-x64.tar.gz";

const REQUIRED_COMPAT_DLLS = ["librsvg-2-2.dll", "libxml2-2.dll"];

/**
 * Pure-JS POSIX/UStar tar reader (Windows Server 2012 R2 does not ship `tar.exe`).
 * Extracts matching basenames (case-insensitive) into a Map<lowercaseName, Buffer>.
 */
export function extractTarEntriesByBasename(tarBuffer, wantedNames) {
  const wanted = new Set(wantedNames.map((n) => n.toLowerCase()));
  const found = new Map();
  let offset = 0;

  while (offset + 512 <= tarBuffer.length && found.size < wanted.size) {
    const header = tarBuffer.subarray(offset, offset + 512);
    // End-of-archive is two 512-byte zero blocks
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const readNullTerm = (buf) => {
      const zeroIdx = buf.indexOf(0);
      return buf.subarray(0, zeroIdx === -1 ? buf.length : zeroIdx).toString("utf8").trim();
    };

    const name = readNullTerm(header.subarray(0, 100));
    const prefix = readNullTerm(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const sizeOctal = readNullTerm(header.subarray(124, 136));
    const size = sizeOctal ? parseInt(sizeOctal, 8) || 0 : 0;
    const typeFlag = header[156];

    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuffer.length) break;

    const isRegularFile = typeFlag === 0 || typeFlag === 48; // '\0' or '0'
    if (isRegularFile && fullName) {
      const base = path.posix.basename(fullName.replace(/\\/g, "/")).toLowerCase();
      if (wanted.has(base)) {
        found.set(base, Buffer.from(tarBuffer.subarray(dataStart, dataEnd)));
      }
    }

    const paddedSize = Math.ceil(size / 512) * 512;
    offset = dataStart + paddedSize;
  }

  return found;
}

export function needsWin2012CanvasPatch(releaseDir) {
  const librsvgPath = path.join(releaseDir, "librsvg-2-2.dll");
  if (!fs.existsSync(librsvgPath)) return false;

  const buf = fs.readFileSync(librsvgPath);
  if (buf.includes(Buffer.from("ProcessPrng", "ascii"))) {
    return true;
  }

  // If patched librsvg imports libxml2-2.dll, ensure libxml2-2.dll is also present
  if (
    buf.includes(Buffer.from("libxml2-2.dll", "ascii")) &&
    !fs.existsSync(path.join(releaseDir, "libxml2-2.dll"))
  ) {
    return true;
  }
  return false;
}

function replaceDllSafe(targetPath, contentBuffer) {
  const bakPath = `${targetPath}.win10-bak`;
  try {
    if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
  } catch {}
  try {
    if (fs.existsSync(targetPath)) fs.renameSync(targetPath, bakPath);
  } catch {}
  fs.writeFileSync(targetPath, contentBuffer);
  try {
    if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath);
  } catch {}
}

/**
 * Ensures `node_modules/canvas/build/Release` on Windows Server 2012 R2 (NT 6.x)
 * does not contain the Rust 1.78+ `librsvg-2-2.dll` that imports Windows 10-only
 * `bcryptprimitives.dll!ProcessPrng`.
 */
export async function ensureWin2012CanvasCompat({
  projectRoot = process.cwd(),
  force = process.env.MYBOT_FORCE_WIN2012_CANVAS_PATCH === "1",
  fetchImpl = globalThis.fetch,
  log = (msg) => console.log(msg),
} = {}) {
  if (!force && !isLegacyWindowsConsole()) {
    return { patched: false, reason: "modern-os" };
  }

  const releaseDir = path.join(projectRoot, "node_modules", "canvas", "build", "Release");
  if (!fs.existsSync(releaseDir)) {
    return { patched: false, reason: "canvas-not-installed" };
  }

  if (!needsWin2012CanvasPatch(releaseDir)) {
    return { patched: false, alreadyCompatible: true, reason: "already-compatible" };
  }

  log("[win2012-compat] Phat hien canvas librsvg-2-2.dll yeu cau Windows 10 (ProcessPrng).");
  log("[win2012-compat] Dang tai DLL tuong thich Windows Server 2012 R2...");

  const response = await fetchImpl(WIN2012_CANVAS_PREBUILD_URL, {
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Download canvas Win2012 compat archive failed: HTTP ${response.status}`);
  }

  const gzBytes = Buffer.from(await response.arrayBuffer());
  const tarBytes = zlib.gunzipSync(gzBytes);
  const extracted = extractTarEntriesByBasename(tarBytes, REQUIRED_COMPAT_DLLS);

  for (const dllName of REQUIRED_COMPAT_DLLS) {
    const dllBytes = extracted.get(dllName.toLowerCase());
    if (!dllBytes || dllBytes.length === 0) {
      throw new Error(`Missing ${dllName} inside Win2012 canvas compatibility archive`);
    }
    replaceDllSafe(path.join(releaseDir, dllName), dllBytes);
  }

  if (needsWin2012CanvasPatch(releaseDir)) {
    throw new Error("Verification failed: librsvg-2-2.dll still contains ProcessPrng after patch");
  }

  log("[win2012-compat] Da cap nhat librsvg-2-2.dll & libxml2-2.dll tuong thich Windows Server 2012 R2!");
  return { patched: true, reason: "patched" };
}

export default ensureWin2012CanvasCompat;
