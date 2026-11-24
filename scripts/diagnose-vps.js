import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import axios from "axios";
import {
  getFfmpegExecutableSync,
  getFfprobeExecutableSync,
} from "../src/utils/runtime-dependencies.js";
import { resolveYtDlpCommand } from "../src/service-debug/api-crawl/youtube/youtube-runtime.js";
import {
  LOCAL_VIDEO_POOL_ROOT,
  LOCAL_VIDEO_POOL_DIRS,
} from "../src/service-debug/chat-zalo/chat-special/send-video/send-video.js";
import { createBotRuntimeContext } from "../src/utils/bot-runtime-context.js";
import { getBotInfoSync } from "../src/utils/env.js";
import { loadProviderEnvironment } from "../src/bootstrap.js";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err) => {
    if (err?.code === "EPIPE" || err?.code === "EIO" || err?.code === "ERR_STREAM_DESTROYED") {
      return;
    }
  });
}

loadProviderEnvironment({ root: projectRoot });

export function maskSecret(secret, visibleChars = 4) {
  if (!secret || typeof secret !== "string") return "(không có)";
  const trimmed = secret.trim();
  if (trimmed.length === 0) return "(không có)";
  if (trimmed.length <= 4) return "***";
  if (trimmed.length <= visibleChars * 2) {
    return `${trimmed[0]}***${trimmed[trimmed.length - 1]} (${trimmed.length} ký tự)`;
  }
  return `${trimmed.slice(0, visibleChars)}***${trimmed.slice(-visibleChars)} (${trimmed.length} ký tự)`;
}
export const redactSecret = maskSecret;

export function maskUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "(chưa cấu hình)";
  try {
    const parsed = new URL(rawUrl.trim());
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[URL không hợp lệ]";
  }
}

async function testBinaryExecution(binaryPath, args = ["-version"]) {
  if (!binaryPath) return { available: false, error: "Đường dẫn không tồn tại" };
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout: 10000,
      windowsHide: true,
    });
    const firstLine = (stdout || stderr || "").trim().split(/\r?\n/)[0];
    return { available: true, version: firstLine, exitCode: 0 };
  } catch (error) {
    const code = error?.code || error?.status || error?.errno || "UNKNOWN";
    const isEntrypointError =
      code === 3221225785 ||
      code === "3221225785" ||
      String(error?.message).includes("3221225785") ||
      String(error?.message).includes("0xC0000139");
    return {
      available: false,
      exitCode: code,
      isEntrypointError,
      error: isEntrypointError
        ? "0xC0000139 (Entry Point Not Found - binary không tương thích OS)"
        : error?.message || String(error),
    };
  }
}

export async function runDiagnostics({ log = console.log } = {}) {
  log("================================================================================");
  log("        HHH_MYBOT - BÁO CÁO CHẨN ĐOÁN HỆ THỐNG VPS (MEDIA, VIDEO, ANTIUNDO)     ");
  log("================================================================================");
  log(`Thời gian: ${new Date().toISOString()}`);
  log(`Thư mục dự án: ${projectRoot}`);

  // 1. Hệ điều hành & Môi trường Node
  log("\n--- [1/6] HỆ ĐIỀU HÀNH & RUNTIME ---");
  const platform = process.platform;
  const release = os.release();
  const arch = process.arch;
  const isWin = platform === "win32";
  const relParts = release.split(".").map(Number);
  const isWinServer2012 = isWin && relParts[0] === 6 && (relParts[1] === 2 || relParts[1] === 3);

  log(`Platform      : ${platform}-${arch}`);
  log(`OS Release    : Windows NT ${release} ${isWinServer2012 ? "=> [XÁC NHẬN: Windows Server 2012 / 2012 R2]" : ""}`);
  log(`Node.js       : ${process.version}`);
  log(`PID           : ${process.pid}`);
  log(`Total RAM     : ${(os.totalmem() / 1024 / 1024).toFixed(0)} MB`);
  log(`Free RAM      : ${(os.freemem() / 1024 / 1024).toFixed(0)} MB`);

  // 2. FFmpeg & Media Binaries
  log("\n--- [2/6] CÔNG CỤ XỬ LÝ MEDIA (FFMPEG, FFPROBE, YT-DLP) ---");
  const ffmpegBin = getFfmpegExecutableSync();
  const ffprobeBin = getFfprobeExecutableSync();
  const ytDlp = resolveYtDlpCommand();

  log(`FFmpeg binary : ${ffmpegBin || "(KHÔNG TÌM THẤY)"}`);
  const ffmpegRes = await testBinaryExecution(ffmpegBin, ["-version"]);
  if (ffmpegRes.available) {
    log(`  -> Trạng thái FFmpeg : OK (${ffmpegRes.version})`);
  } else {
    log(`  -> Trạng thái FFmpeg : LỖI! [${ffmpegRes.error}]`);
  }

  log(`FFprobe binary: ${ffprobeBin || "(KHÔNG TÌM THẤY)"}`);
  const ffprobeRes = await testBinaryExecution(ffprobeBin, ["-version"]);
  if (ffprobeRes.available) {
    log(`  -> Trạng thái FFprobe: OK (${ffprobeRes.version})`);
  } else {
    log(`  -> Trạng thái FFprobe: LỖI! [${ffprobeRes.error}]`);
  }

  log(`yt-dlp binary : ${ytDlp.binaryPath || "(KHÔNG TÌM THẤY)"}`);
  if (ytDlp.available && ytDlp.binaryPath) {
    const ytSource = ytDlp.custom ? "YOUTUBE_DL_PATH" : "portable/system";
    const ytRes = await testBinaryExecution(ytDlp.binaryPath, ["--version"]);
    if (ytRes.available) {
      log(`  -> Trạng thái yt-dlp : OK (version=${ytRes.version}, source=${ytSource})`);
    } else {
      log(`  -> Trạng thái yt-dlp : LỖI THỰC THI! [${ytRes.error}] (source=${ytSource})`);
    }
  } else {
    log(`  -> Trạng thái yt-dlp : CHƯA CÓ`);
  }

  // 3. Kho Video Local (video/vd*)
  log("\n--- [3/6] KHO NGUỒN VIDEO LOCAL (video/<tên_lệnh>) ---");
  const videoRoot = path.join(projectRoot, LOCAL_VIDEO_POOL_ROOT);
  const videoRootExists = fs.existsSync(videoRoot);
  log(`Thư mục gốc video : ${videoRoot} [${videoRootExists ? "TỒN TẠI" : "KHÔNG TỒN TẠI"}]`);

  const poolSummary = [];
  let totalMp4Count = 0;

  for (const dirName of LOCAL_VIDEO_POOL_DIRS) {
    const poolPath = path.join(videoRoot, dirName);
    const exists = fs.existsSync(poolPath);
    let count = 0;
    let sizeMb = 0;
    if (exists) {
      try {
        const files = fs.readdirSync(poolPath).filter((f) => f.toLowerCase().endsWith(".mp4"));
        count = files.length;
        totalMp4Count += count;
        for (const f of files.slice(0, 20)) {
          try {
            const stat = fs.statSync(path.join(poolPath, f));
            sizeMb += stat.size / (1024 * 1024);
          } catch {}
        }
      } catch {}
    }
    poolSummary.push({ dirName, exists, count, sizeMb: sizeMb.toFixed(1) });
    const statusText = exists
      ? count > 0
        ? `TỒN TẠI (${count} file .mp4)`
        : "TỒN TẠI NHƯNG TRỐNG (0 file .mp4)"
      : "KHÔNG TỒN TẠI";
    log(`  - ${dirName.padEnd(10)}: ${statusText}`);
  }
  log(`Tổng số video .mp4 trên máy: ${totalMp4Count} file`);

  // 4. TikTok Search & Downloader API Config
  log("\n--- [4/6] CẤU HÌNH API TIKTOK & DOWNLOADER ---");
  const tiktokUrl = process.env.TIKTOK_SEARCH_API_URL;
  const tiktokKey = process.env.TIKTOK_SEARCH_API_KEY;
  const hoangdevKey = process.env.HOANGDEV_API_KEY;
  const tiktokCookie = process.env.TIKTOK_COOKIE;

  log(`TIKTOK_SEARCH_API_URL : ${maskUrl(tiktokUrl)}`);
  log(`TIKTOK_SEARCH_API_KEY : ${maskSecret(tiktokKey)}`);
  log(`TIKTOK_COOKIE         : ${tiktokCookie ? `[CÓ: ${tiktokCookie.length} ký tự]` : "(không có)"}`);
  log(`HOANGDEV_API_KEY      : ${maskSecret(hoangdevKey)}`);

  // Thử kết nối API TikTok nếu có cấu hình (chế độ kiểm tra nhanh với timeout 5s)
  if (tiktokUrl && tiktokKey) {
    try {
      log("  -> Đang kiểm tra kết nối API TikTok...");
      const reqUrl = new URL(tiktokUrl.trim());
      const isRapid = reqUrl.hostname.endsWith(".p.rapidapi.com");
      const testConfig = {
        timeout: 8000,
        headers: isRapid
          ? {
              "Content-Type": "application/json",
              "x-rapidapi-host": reqUrl.hostname,
              "x-rapidapi-key": tiktokKey.trim(),
            }
          : {},
      };
      const testRes = isRapid
        ? await axios.post(reqUrl.toString(), { query: "test", cursor: 0, sort_type: "0" }, testConfig)
        : await axios.get(reqUrl.toString(), { ...testConfig, params: { keyword: "test", limit: 1, apikey: tiktokKey.trim() } });
      const hasData = Array.isArray(testRes.data?.data) || Array.isArray(testRes.data?.videos);
      log(`  -> Kết nối API TikTok: THÀNH CÔNG (HTTP ${testRes.status}, trả về định dạng=${hasData ? "HỢP LỆ" : "CẦN LƯU Ý"})`);
    } catch (err) {
      const status = err?.response?.status;
      const code = err?.code || (status ? `HTTP_${status}` : "NETWORK_ERROR");
      log(`  -> Kết nối API TikTok: THẤT BẠI [Mã: ${code}] - ${err.message}`);
    }
  } else {
    log("  -> Bỏ qua kiểm tra kết nối TikTok (chưa cấu hình đủ URL và Key trong .env.local)");
  }

  // 5. AntiUndo & Message Cache
  log("\n--- [5/6] HỆ THỐNG ANTIUNDO & MESSAGE CACHE ---");
  const botInfo = getBotInfoSync() || {};
  const ctx = createBotRuntimeContext(botInfo);
  const messageJsonPath = ctx.messageJsonPath;
  log(`File message.json     : ${messageJsonPath || "(chưa xác định)"}`);
  if (messageJsonPath) {
    const exists = fs.existsSync(messageJsonPath);
    let size = 0;
    let entryCount = 0;
    if (exists) {
      try {
        const stat = fs.statSync(messageJsonPath);
        size = stat.size;
        const parsed = JSON.parse(fs.readFileSync(messageJsonPath, "utf8"));
        entryCount = Object.keys(parsed || {}).length;
      } catch {}
    }
    log(`  -> Trạng thái file    : ${exists ? `TỒN TẠI (${(size / 1024).toFixed(1)} KB, ~${entryCount} tin lưu trên đĩa)` : "CHƯA TẠO"}`);
  }

  // 6. Canvas & Thư viện Native
  log("\n--- [6/6] KIỂM TRA THƯ VIỆN NATIVE (CANVAS) ---");
  try {
    const { createCanvas } = await import("canvas");
    const canvas = createCanvas(100, 100);
    const cctx = canvas.getContext("2d");
    cctx.fillStyle = "#FF0000";
    cctx.fillRect(0, 0, 100, 100);
    const buf = canvas.toBuffer("image/png");
    log(`  -> Canvas Native      : OK (Render thử thành công ${buf.length} bytes PNG)`);
  } catch (err) {
    log(`  -> Canvas Native      : LỖI! [${err.message}]`);
  }

  log("\n================================================================================");
  log("                           KẾT THÚC BÁO CÁO CHẨN ĐOÁN                           ");
  log("================================================================================");

  return {
    isWinServer2012,
    ffmpegOk: ffmpegRes.available,
    ffprobeOk: ffprobeRes.available,
    totalMp4Count,
    hasTiktokConfig: Boolean(tiktokUrl && tiktokKey),
  };
}

// Chạy trực tiếp qua CLI: node scripts/diagnose-vps.js
const isDirectCli = Boolean(
  process.argv[1] &&
    path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
);
if (isDirectCli) {
  runDiagnostics().catch((err) => {
    console.error("Lỗi khi chạy chẩn đoán:", err);
    process.exitCode = 1;
  });
}
