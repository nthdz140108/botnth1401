import FormData from "form-data";
import axios from "axios";
import fs from "fs";
import path from "path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tempDir } from "./io-json.js";
import { getBotName, getProjectRoot } from "./env.js";
import { acquireTempLease, releaseTempLease } from "./temp-lease-manager.js";
import {
  consumeRestartRequest,
  markRestartRequestNotified,
  readRestartRequest,
  RESTART_EXIT_CODE,
  writeRestartRequest,
} from "./restart-request.js";
import { exec, spawn } from "child_process";
import { promisify } from "util";

let _sharp = null;
async function getSharp() {
  if (!_sharp) {
    const mod = await import("sharp");
    _sharp = mod.default || mod;
    if (typeof _sharp?.cache === "function") _sharp.cache(false);
    if (typeof _sharp?.concurrency === "function") _sharp.concurrency(1);
  }
  return _sharp;
}
import { analyzeLinks } from "../api-zalo/utils.js";
import { readRoleRegistry } from "../dashboard/role-registry-service.js";

import { getRuntimeInstanceDescriptor } from "../core/runtime-instance.js";

export function resolveRestartBotId(api, env = process.env) {
  if (env && (env.BOT_KEY || env.BOT_NAME || env.BOT_UID)) {
    const candidate = String(env.BOT_KEY || env.BOT_NAME || env.BOT_UID).trim();
    if (candidate && candidate !== "admin") return candidate;
    if (candidate === "admin") return "admin";
  }
  const descriptor = getRuntimeInstanceDescriptor();
  if (descriptor.isMain && api?.is_main_bot !== false) return "admin";
  return String(descriptor.botKey || descriptor.configuredUid || "child");
}

export async function resolveAdminBotId({ root = getProjectRoot(), fallback = "admin" } = {}) {
  try {
    const roleRegistry = await readRoleRegistry(path.join(root, "mybot", "role-registry.json"));
    return roleRegistry.adminBotId || roleRegistry.primaryBotId || fallback;
  } catch {
    return fallback;
  }
}

export async function resolveAdminBotRecord(registry, { root = getProjectRoot(), fallback = "admin" } = {}) {
  const adminBotId = await resolveAdminBotId({ root, fallback });
  const adminBot = registry ? await registry.describe(adminBotId) : null;
  return { adminBotId, adminBot };
}

export function resolveAdminBotIdSync({ root = getProjectRoot(), fallback = "admin" } = {}) {
  try {
    const filePath = path.join(root, "mybot", "role-registry.json");
    if (!fs.existsSync(filePath)) return fallback;
    const roleRegistry = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return roleRegistry.adminBotId || roleRegistry.primaryBotId || fallback;
  } catch {
    return fallback;
  }
}

export function hasExternalSupervisor(env = process.env) {
  return Boolean(
    env?.pm_id !== undefined ||
    env?.pm_exec_path ||
    env?.PM2_USAGE ||
    env?.MYBOT_SUPERVISOR
  );
}

function spawnStandaloneReplacementProcess(delayMs = 1200) {
  if (
    process.env.NODE_TEST_CONTEXT ||
    process.env.NODE_ENV === "test" ||
    process.env.SKIP_ENV_VALIDATION
  ) {
    return false;
  }
  const entryScript = process.argv[1];
  if (!entryScript) return false;
  const args = process.argv.slice(2);
  const waitMs = Math.max(400, Number(delayMs) || 1200);
  const relaunchCode = `
    const { spawn } = require("node:child_process");
    const targetPid = Number(process.env.MYBOT_OLD_PID || 0);
    const startChild = () => {
      const nextEnv = { ...process.env };
      delete nextEnv.MYBOT_OLD_PID;
      delete nextEnv.MYBOT_ENTRY_SCRIPT;
      delete nextEnv.MYBOT_ENTRY_ARGS;
      const child = spawn(
        process.execPath,
        [process.env.MYBOT_ENTRY_SCRIPT, ...JSON.parse(process.env.MYBOT_ENTRY_ARGS || "[]")],
        {
          cwd: process.cwd(),
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          env: nextEnv,
        }
      );
      child.unref();
      process.exit(0);
    };
    let checks = 0;
    const poll = () => {
      checks += 1;
      if (targetPid > 0 && checks < 30) {
        try {
          process.kill(targetPid, 0);
          setTimeout(poll, 250);
          return;
        } catch {}
      }
      startChild();
    };
    setTimeout(poll, ${waitMs});
  `;
  try {
    const helper = spawn(process.execPath, ["-e", relaunchCode], {
      cwd: getProjectRoot(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        MYBOT_OLD_PID: String(process.pid),
        MYBOT_ENTRY_SCRIPT: path.resolve(entryScript),
        MYBOT_ENTRY_ARGS: JSON.stringify(args),
      },
    });
    helper.unref?.();
    return true;
  } catch (error) {
    console.error("[restartSelf] Không thể tạo tiến trình khởi động lại độc lập:", error?.message || error);
    return false;
  }
}

export function requestRestartForBot(botId, context = {}, { root = getProjectRoot() } = {}) {
  const descriptor = getRuntimeInstanceDescriptor();
  const uid = String(botId || (descriptor.isMain ? "admin" : descriptor.botKey));
  const hasValidType = context.type !== undefined && context.type !== null && context.type !== "";
  if (uid === "admin") {
    const resolvedRoot = path.resolve(root);
    fs.writeFileSync(path.join(resolvedRoot, ".bot-action"), "restart", "utf8");
    if (context.threadId && hasValidType) {
      const logsDir = path.join(resolvedRoot, "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "restart.txt"),
        `time: ${new Date().toISOString()}\nthreadId: ${context.threadId}\ntype: ${context.type}\n`,
        "utf8"
      );
    }
    return { uid: "admin", mode: "launcher" };
  }
  writeRestartRequest(uid, context, root);
  return { uid, mode: "managed-process" };
}

export async function restartSelf(api, message, aliasCommand, options = {}) {
  const threadId = message?.threadId;
  const type = message?.type !== undefined && message?.type !== null ? message.type : 1;
  try {
    if (!options.suppressNotifyBeforeExit && api && typeof api.sendMessage === "function" && threadId) {
      await api.sendMessage({ msg: " 🤖 Bot đang khởi động lại 🔂", quote: message, ttl: 60000 }, threadId, type);
    }
    const botId = options.botId || resolveRestartBotId(api);
    requestRestartForBot(botId, { threadId, type }, options);
    const exitCode = options.exitCode ?? RESTART_EXIT_CODE;
    const scheduleExit = options.scheduleExit || ((callback, delay) => setTimeout(callback, delay));
    if (options.exit !== false) {
      const delayMs = options.exitDelayMs ?? 1000;
      if (!options.scheduleExit && !hasExternalSupervisor(process.env)) {
        spawnStandaloneReplacementProcess(delayMs + 400);
      }
      scheduleExit(() => process.exit(exitCode), delayMs);
    }
  } catch (err) {
    console.error("Lỗi khi restart:", err);
  }
}

// Hàm kiểm tra file restart.txt và trạng thái restart của bot con
export async function checkRestartFile(api, { root = getProjectRoot() } = {}) {
  try {
    const resolvedRoot = path.resolve(root);
    const descriptor = getRuntimeInstanceDescriptor();
    const botId = resolveRestartBotId(api);
    const candidateIds = Array.from(
      new Set(
        [
          botId,
          descriptor?.botKey,
          getBotName(),
          api?.getBotId?.() ? String(api.getBotId()) : null,
        ]
          .filter(Boolean)
          .map((val) => String(val).trim())
          .filter((val) => val && val !== "-1")
      )
    );

    for (const candidateId of candidateIds) {
      if (candidateId === "admin") continue;
      let restartRequest = readRestartRequest(candidateId, resolvedRoot);
      if (restartRequest?.status === "requested") {
        restartRequest =
          consumeRestartRequest(candidateId, resolvedRoot, { maxAgeMs: 120_000 }) ||
          readRestartRequest(candidateId, resolvedRoot);
      }
      const hasValidReqType =
        restartRequest?.type !== undefined &&
        restartRequest?.type !== null &&
        restartRequest?.type !== "";
      if (
        restartRequest?.status === "consumed" &&
        restartRequest.threadId &&
        hasValidReqType &&
        !restartRequest.notifiedAt
      ) {
        const startedAt = new Date(restartRequest.requestedAt || Date.now());
        const diffSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        const parsedReqType = !Number.isNaN(Number(restartRequest.type))
          ? Number(restartRequest.type)
          : restartRequest.type;
        await api.sendMessage(
          {
            msg: `🤖Bot đã khởi động lại ✔️\n🕛Thời gian khởi động lại: ${diffSeconds} giây`,
            ttl: 60000,
          },
          restartRequest.threadId,
          parsedReqType
        );
        markRestartRequestNotified(candidateId, resolvedRoot);
        return true;
      }
    }

    if (!descriptor.isMain && botId !== "admin") {
      return false;
    }

    const restartFile = path.join(resolvedRoot, "logs", "restart.txt");

    if (!fs.existsSync(restartFile)) {
      return false;
    }

    const content = fs.readFileSync(restartFile, "utf8");
    const lines = content.split(/\r?\n/);
    const timeLine = lines.find((line) => line.startsWith("time:"));

    if (!timeLine) {
      console.log("File restart.txt không đúng định dạng.");
      return false;
    }

    const startTimeStr = timeLine.replace("time:", "").trim();
    const startTime = new Date(startTimeStr);
    const now = new Date();
    const diffSeconds = Math.max(0, Math.floor((now - startTime) / 1000));

    // Lấy threadId và type từ file
    const threadIdLine = lines.find((line) => line.startsWith("threadId:"));
    const typeLine = lines.find((line) => line.startsWith("type:"));
    const threadId = threadIdLine ? threadIdLine.replace("threadId:", "").trim() : null;
    const rawType = typeLine ? typeLine.replace("type:", "").trim() : null;

    if (!threadId || rawType === null || rawType === "") {
      console.log("Không tìm thấy threadId hoặc type trong file restart.txt.");
      try { fs.unlinkSync(restartFile); } catch {}
      return false;
    }

    const parsedType = !Number.isNaN(Number(rawType)) ? Number(rawType) : rawType;
    const msg = `🤖Bot đã khởi động lại ✔️\n🕛Thời gian khởi động lại: ${diffSeconds} giây`;

    // Xóa file restart.txt trước khi gửi để tránh gửi trùng nếu gọi lại
    fs.unlinkSync(restartFile);
    await api.sendMessage({ msg, ttl: 60000 }, threadId, parsedType);
    return true;
  } catch (error) {
    console.error("Lỗi khi kiểm tra file restart.txt:", error);
    return false;
  }
}


export async function checkUrlStatus(url) {
	try {
		const response = await axios.head(url, {
			timeout: 5000,
		});
		return response.status === 200;
	} catch (error) {
		console.log(`Link đã gãy hoặc timeout: ${url}`);
		return false;
	}
}

export function checkLinkIsValid(content) {
  try {
    if (!content || typeof content !== 'string') return false;
    content = content.trim();
    if (!content.match(/^https?:\/\//i)) {
      content = 'https://' + content;
    }
    new URL(content);
    return true;
  } catch {
    return false;
  }
}

export const execAsync = promisify(exec);

export async function uploadTempFile(pathLocal, serviceType = 1) {
  let result = null;

  try {
    if (serviceType === 2) {
      result = await uploadToTmpFile(pathLocal);
    } else {
      result = await uploadToUguu(pathLocal);
    }
    if (!result) {
      result = serviceType === 2
        ? await uploadToUguu(pathLocal)
        : await uploadToTmpFile(pathLocal);
    }
    return result;
  } catch (error) {
    try {
      result = serviceType === 2
        ? await uploadToUguu(pathLocal)
        : await uploadToTmpFile(pathLocal);
    } catch (fallbackError) {
      console.error("Lỗi khi upload file lên cả hai dịch vụ:", fallbackError);
    }
    return result;
  }
}

/**
 * Upload file lên tmpfiles.org
 */
export async function uploadToTmpFile(pathLocal) {
  try {
    const fileName = path.basename(pathLocal);
    const buffer = fs.createReadStream(pathLocal);
    const formData = new FormData();
    formData.append("file", buffer, {
      filename: fileName,
    });

    const response = await axios.post("https://tmpfiles.org/api/v1/upload", formData, {
      headers: formData.getHeaders(),
    });

    if (response.status === 200 && response.data.data.url) {
      const downloadUrl = response.data.data.url.replace("https://tmpfiles.org/", "https://tmpfiles.org/dl/");
      return downloadUrl;
    } else {
      console.error("Lỗi khi upload:", response.data);
      return null;
    }
  } catch (error) {
    console.error("Lỗi khi upload lên dịch vụ tempfile:", error);
    return null;
  }
}

/**
 * Upload file lên uguu.se
 */
export async function uploadToUguu(pathLocal) {
  try {
    const fileName = path.basename(pathLocal);
    const buffer = fs.createReadStream(pathLocal);

    const formData = new FormData();
    formData.append("files[]", buffer, fileName);
    formData.append("randomname", "true");

    const response = await axios.post("https://uguu.se/upload.php", formData, {
      headers: {
        ...formData.getHeaders(),
        accept: "application/json",
      },
    });

    if (response.status === 200 && response.data) {
      return response.data.files[0].url;
    } else {
      console.error("Lỗi upload:", response.data);
      return null;
    }
  } catch (error) {
    console.error("Lỗi khi upload lên Uguu:", error.message);
    return null;
  }
}

function inferExtensionFromResponseOrUrl(url, contentType = "") {
  const normalizedMime = String(contentType || "").toLowerCase().split(";")[0].trim();
  const mimeMap = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/aac": "aac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  if (mimeMap[normalizedMime]) return mimeMap[normalizedMime];
  try {
    const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
    if (ext && /^[a-z0-9]{2,5}$/.test(ext)) return ext;
  } catch {}
  return "tmp";
}

const DEFAULT_DOWNLOAD_MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Download file từ URL theo cơ chế stream-to-disk có giới hạn dung lượng cứng,
 * AbortController chống treo socket và TempFileLease chống xung đột dọn rác.
 */
export async function downloadFile(url, filepath, options = {}) {
  let tempFilePath = filepath;
  const timeout = Number(options?.timeout) > 0 ? Number(options.timeout) : DEFAULT_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = Number(options?.maxBytes || options?.maxContentLength) > 0
    ? Number(options.maxBytes || options.maxContentLength)
    : DEFAULT_DOWNLOAD_MAX_BYTES;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(new Error(`Download timeout after ${timeout}ms`)), timeout);
  abortTimer.unref?.();

  try {
    const customHeaders = (options?.headers && typeof options.headers === "object") ? options.headers : {};
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ...customHeaders,
      },
      timeout,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
    });

    const declaredLength = Number(response.headers?.["content-length"] || 0);
    if (declaredLength > maxBytes) {
      response.data?.destroy?.();
      throw new Error(`File vượt quá giới hạn cho phép (${declaredLength} > ${maxBytes} bytes)`);
    }

    if (!tempFilePath) {
      const ext = inferExtensionFromResponseOrUrl(url, response.headers?.["content-type"]);
      tempFilePath = path.join(tempDir, `fileDownload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    }
    await fs.promises.mkdir(path.dirname(tempFilePath), { recursive: true });
    acquireTempLease(tempFilePath, Math.max(timeout + 60_000, 10 * 60_000), {
      ownerTag: "downloadFile",
    });

    let receivedBytes = 0;
    const byteGuard = new Transform({
      transform(chunk, _encoding, callback) {
        receivedBytes += chunk.length;
        if (receivedBytes > maxBytes) {
          callback(new Error(`Stream vượt quá giới hạn dung lượng (${maxBytes} bytes)`));
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(response.data, byteGuard, fs.createWriteStream(tempFilePath));
    return tempFilePath;
  } catch (error) {
    if (tempFilePath) {
      releaseTempLease(tempFilePath);
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
    console.error("Lỗi downloadFile:", /^[A-Z0-9_]+$/.test(error?.code || "") ? error.code : "DOWNLOAD_FAILED");
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }
}

export async function downloadFileFake(url, filepath, options = {}) {
  return downloadFile(url, filepath, options);
}

/**
 * Download video từ URL theo stream-to-disk (không nạp toàn bộ video vào RAM)
 */
export async function downloadAndSaveVideo(videoUrl) {
  const tempFilePath = path.join(tempDir, `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);
  return downloadFile(videoUrl, tempFilePath, {
    maxBytes: DEFAULT_DOWNLOAD_MAX_BYTES,
    timeout: 90_000,
  });
}

/**
 * Kiểm tra và xác định định dạng file từ URL từ xa
 * 
 * @param {string} url - URL của file cần kiểm tra
 * @returns {Promise<string|null>} - Trả về phần mở rộng của file hoặc null nếu không xác định được
 */
export async function checkExstentionFileRemote(url) {
  let attempts = 0;
  const maxAttempts = 3;
  const retryDelayMs = 500;
  
  // Map mở rộng cho các định dạng MIME
  const mimeToExt = {
    // Hình ảnh
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/bmp': 'bmp',
    
    // Video
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'video/x-matroska': 'mkv',
    'video/x-flv': 'flv',
    'video/3gpp': '3gp',
    'video/3gpp2': '3g2',
    
    // Âm thanh
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/webm': 'weba',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/x-ms-wma': 'wma',
    
    // Tài liệu
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/html': 'html',
    'text/css': 'css',
    'text/javascript': 'js',
    
    // Nén
    'application/zip': 'zip',
    'application/x-rar-compressed': 'rar',
    'application/x-7z-compressed': '7z',
    'application/x-tar': 'tar',
    'application/x-gzip': 'gz',
    'application/x-bzip2': 'bz2',
    'application/x-xz': 'xz',
    'application/gzip': 'gz'
  };

  /**
   * Tạo headers tùy chỉnh cho từng trang web
   * @param {string} url - URL cần tạo headers
   * @returns {Object} - Headers tùy chỉnh
   */
  function createHeaders(url) {
    // Headers cơ bản cho tất cả các requests
    const headers = {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Chromium";v="121", "Google Chrome";v="121", "Not:A-Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    };

    // Headers tùy chỉnh theo domain
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();
      
      // Xác định domain và thiết lập headers tương ứng
      if (hostname.includes('tiktok.com') || hostname.includes('tiktokcdn')) {
        headers['Referer'] = 'https://www.tiktok.com/';
        headers['Origin'] = 'https://www.tiktok.com';
        headers['Sec-Fetch-Dest'] = 'video';
        headers['Sec-Fetch-Mode'] = 'no-cors';
      } 
      else if (hostname.includes('facebook.com') || hostname.includes('fbcdn.net')) {
        headers['Referer'] = 'https://www.facebook.com/';
        headers['Origin'] = 'https://www.facebook.com';
        headers['sec-ch-ua'] = '"Facebook";v="1", "Chrome";v="121"';
      } 
      else if (hostname.includes('instagram.com') || hostname.includes('cdninstagram.com')) {
        headers['Referer'] = 'https://www.instagram.com/';
        headers['Origin'] = 'https://www.instagram.com';
        if (process.env.INSTAGRAM_APP_ID) {
          headers['x-ig-app-id'] = process.env.INSTAGRAM_APP_ID; // Instagram app ID
        }
      } 
      else if (hostname.includes('imgur.com') || hostname.includes('i.imgur.com')) {
        headers['Referer'] = 'https://imgur.com/';
        headers['Origin'] = 'https://imgur.com';
        headers['DNT'] = '1';
        headers['TE'] = 'Trailers';
        if (process.env.IMGUR_CLIENT_ID) {
          headers['Authorization'] = `Client-ID ${process.env.IMGUR_CLIENT_ID}`; // Public Imgur API client ID
        }
      } 
      else if (hostname.includes('twitter.com') || hostname.includes('twimg.com')) {
        headers['Referer'] = 'https://twitter.com/';
        headers['Origin'] = 'https://twitter.com';
        headers['x-twitter-client-version'] = '10.0.0';
      }
      else if (hostname.includes('giphy.com') || hostname.includes('media.giphy.com')) {
        headers['Referer'] = 'https://giphy.com/';  
        headers['Origin'] = 'https://giphy.com';
      }
      else if (hostname.includes('tenor.com') || hostname.includes('media.tenor.com')) {
        headers['Referer'] = 'https://tenor.com/';
        headers['Origin'] = 'https://tenor.com';
      }
      else if (hostname.includes('cloudfront.net')) {
        headers['Referer'] = 'https://www.amazon.com/';
        headers['Origin'] = 'https://www.amazon.com';
      }
      else if (hostname.includes('pinimg.com')) {
        headers['Referer'] = 'https://www.pinterest.com/';
        headers['Origin'] = 'https://www.pinterest.com';
      }
    } catch (error) {
      // Nếu không parse được URL, vẫn dùng headers mặc định
      console.log("Không thể phân tích URL:", error.message);
    }

    return headers;
  }

  // Hàm trích xuất phần mở rộng từ URL
  const getExtensionFromUrl = (url) => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      
      // Kiểm tra xem có phải imgur URL không và xử lý đặc biệt
      if (urlObj.hostname.includes('imgur.com')) {
        // Imgur đôi khi không có phần mở rộng trong URL
        const pathSegments = pathname.split('/');
        const lastSegment = pathSegments.pop() || '';
        
        // Nếu không có phần mở rộng trong URL imgur, thường là jpg hoặc png
        if (!lastSegment.includes('.')) {
          // Imgur thường dùng jpg
          return 'jpg';
        }
      }
      
      const filename = pathname.split('/').pop();
      if (!filename) return null;
      
      // Xử lý trường hợp có query string trong phần cuối
      const filenameNoQuery = filename.split('?')[0];
      const extension = filenameNoQuery.split('.').pop().toLowerCase();
      
      // Kiểm tra xem phần mở rộng có hợp lệ không (không quá dài)
      return (extension && extension.length <= 5) ? extension : null;
    } catch (error) {
      console.error("Lỗi khi phân tích URL:", error.message);
      return null;
    }
  };

  // Hàm lấy phần mở rộng từ Content-Disposition
  const getExtensionFromDisposition = (disposition) => {
    if (!disposition) return null;
    
    // Kiểm tra các kiểu filename khác nhau
    const filenameRegexps = [
      /filename=["']?([^"';]+)["']?/i,
      /filename\*=UTF-8''([^"';]+)/i,
      /filename\*=([^"';]+)/i
    ];
    
    for (const regex of filenameRegexps) {
      const match = disposition.match(regex);
      if (match && match[1]) {
        try {
          const filename = decodeURIComponent(match[1].replace(/['"]/g, ''));
          const extension = filename.split('.').pop().toLowerCase();
          if (extension && extension.length <= 5) return extension;
        } catch (e) {
          // Nếu có lỗi khi decode URI, thử phương pháp khác
          const filename = match[1].replace(/['"]/g, '');
          const extension = filename.split('.').pop().toLowerCase();
          if (extension && extension.length <= 5) return extension;
        }
      }
    }
    
    return null;
  };

  // Hàm xử lý đặc biệt cho Imgur
  const handleImgur = async (url) => {
    // Kiểm tra xem có phải URL imgur không
    if (!url.includes('imgur.com')) return null;
    
    try {
      // Kiểm tra phần mở rộng trực tiếp từ URL trước
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = pathname.split('/').pop() || '';
      
      // Kiểm tra xem URL có định dạng rõ ràng không
      const filenameParts = filename.split('.');
      if (filenameParts.length > 1) {
        const extension = filenameParts.pop().toLowerCase();
        // Nếu đã có phần mở rộng hợp lệ trong URL, dùng nó luôn
        if (extension && extension.length <= 5 && Object.values(mimeToExt).includes(extension)) {
          return extension;
        }
      }
      
      // Phân tích ID của ảnh từ URL Imgur
      const imgurId = filename.split('.')[0];
      
      // Kiểm tra video Imgur (.mp4, .gif, .gifv)
      if (url.includes('.mp4')) return 'mp4';
      if (url.includes('.gifv')) return 'gif'; // Imgur gifv thực chất là mp4 hoặc webm
      if (url.includes('.gif')) return 'gif';
      
      // Xác định phương thức tiếp cận dựa trên cách Imgur phân phối nội dung
      let imgurHeaders;
      
      // Thử nhiều phương pháp với độ trễ giữa các lần thử
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Tạo headers đặc biệt cho Imgur với mỗi lần thử khác nhau
          imgurHeaders = createHeaders(url);
          
          // Thay đổi một số headers để tránh trùng lặp signature
          if (attempt === 1) {
            imgurHeaders['Accept'] = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';
            imgurHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
            imgurHeaders['Referer'] = 'https://imgur.com/gallery/';
          } else if (attempt === 2) {
            imgurHeaders['Accept'] = '*/*';
            imgurHeaders['User-Agent'] = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
            imgurHeaders['Referer'] = 'https://imgur.com/a/';
            // Xóa một số headers không cần thiết để tạo sự khác biệt
            delete imgurHeaders['sec-ch-ua'];
            delete imgurHeaders['sec-ch-ua-mobile'];
          }
          
          // Thêm delay ngẫu nhiên để tránh rate limit
          const delayMs = 1000 + Math.floor(Math.random() * 2000);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          
          // Thử sử dụng HEAD trước (ít dữ liệu)
          if (attempt === 0) {
            try {
              const headResponse = await axios.head(url, {
                headers: imgurHeaders,
                timeout: 6000,
                maxRedirects: 3,
                validateStatus: status => status < 400
              });
              
              // Kiểm tra Content-Type từ HEAD
              const contentType = headResponse.headers['content-type']?.toLowerCase();
              if (contentType) {
                const baseContentType = contentType.split(';')[0].trim();
                if (mimeToExt[baseContentType]) {
                  return mimeToExt[baseContentType];
                }
              }
              
              // Kiểm tra Content-Disposition từ HEAD
              const contentDisposition = headResponse.headers['content-disposition'];
              if (contentDisposition) {
                const dispositionExt = getExtensionFromDisposition(contentDisposition);
                if (dispositionExt) return dispositionExt;
              }
            } catch (headError) {
              // Nếu HEAD thất bại (thường do bị chặn), tiếp tục với GET
              console.log("HEAD request bị từ chối bởi Imgur, chuyển sang GET:", headError.message);
            }
          }
          
          // Thử với GET và chỉ lấy phần đầu của file
          const getResponse = await axios.get(url, {
            headers: { ...imgurHeaders, Range: 'bytes=0-512' }, // Chỉ lấy 512 bytes đầu tiên
            responseType: 'arraybuffer',
            timeout: 10000,
            maxRedirects: 5,
            // Chấp nhận cả status 429 để xử lý riêng
            validateStatus: status => status === 200 || status === 206 || status === 429
          });
          
          // Kiểm tra xem có bị rate limit không (status 429)
          if (getResponse.status === 429) {
            console.log("Bị rate limit (429) từ Imgur, thử lại sau:", attempt);
            // Tăng thời gian chờ lên đáng kể
            await new Promise(resolve => setTimeout(resolve, 5000 + (attempt * 2000)));
            continue; // Thử lại
          }
          
          // Kiểm tra Content-Type từ response
          const contentType = getResponse.headers['content-type']?.toLowerCase();
          if (contentType) {
            const baseContentType = contentType.split(';')[0].trim();
            if (mimeToExt[baseContentType]) {
              return mimeToExt[baseContentType];
            }
          }
          
          // Nếu không có Content-Type rõ ràng, kiểm tra signature của file
          if (getResponse.data && getResponse.data.length > 0) {
            const buffer = Buffer.from(getResponse.data);
            
            // Kiểm tra các signature
            if (buffer.length >= 8) {
              // JPEG/JPG signature
              if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
                return 'jpg';
              }
              // PNG signature
              if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
                return 'png';
              }
              // GIF signature
              if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
                return 'gif';
              }
              // WebP
              if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
                  buffer.length >= 12 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
                return 'webp';
              }
              // MP4 (MPEG-4)
              if (buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
                return 'mp4';
              }
            }
          }
          
          // Nếu thành công nhưng không xác định được, dùng Imgur API để thử
          break;
        } catch (attemptError) {
          console.log(`Lỗi trong lần thử ${attempt + 1} với Imgur:`, attemptError.message);
          // Tăng thời gian chờ giữa các lần thử
          await new Promise(resolve => setTimeout(resolve, 3000 + (attempt * 1500)));
        }
      }
      
      // Thử phương pháp cuối cùng: dựa vào ID của ảnh và kiểm tra định dạng thường gặp
      
      // Imgur ID thường có dạng 7 ký tự chữ và số
      if (imgurId && imgurId.length >= 5 && imgurId.length <= 10) {
        // Kiểm tra một số định dạng phổ biến cho Imgur
        
        // 1. Thử xác định từ pattern URL
        if (url.includes('/a/')) {
          // URL album thường chứa nhiều ảnh, jpg là phổ biến nhất
          return 'jpg';
        }
        
        // 2. Cách xác định cho Imgur: đa số là JPG
        // Imgur phần lớn là JPG, tiếp theo là PNG và GIF
        return 'jpg';
      }
      
      // Mặc định cho Imgur luôn là jpg
      return 'jpg';
    } catch (error) {
      console.error("Lỗi khi xử lý URL Imgur:", error.message);
      // Mặc định: Hầu hết Imgur là JPG
      return 'jpg';
    }
  };

  // Bắt đầu việc kiểm tra định dạng
  while (attempts < maxAttempts) {
    try {
      // Nếu là URL Imgur, xử lý đặc biệt
      if (url.includes('imgur.com')) {
        const imgurExt = await handleImgur(url);
        if (imgurExt) return imgurExt;
      }
      
      // Kiểm tra phần mở rộng từ URL
      const urlExtension = getExtensionFromUrl(url);
      if (urlExtension && Object.values(mimeToExt).includes(urlExtension)) {
        return urlExtension;
      }

      // Tạo headers tùy chỉnh theo domain
      const headers = createHeaders(url);
      
      // Thử phương thức HEAD trước
      try {
        const headResponse = await axios.head(url, { 
          headers: headers,
          timeout: 5000,
          maxRedirects: 5,
          validateStatus: status => status < 400
        });
        
        // Kiểm tra Content-Type
        const contentType = headResponse.headers['content-type']?.toLowerCase();
        if (contentType) {
          const baseContentType = contentType.split(';')[0].trim();
          if (mimeToExt[baseContentType]) {
            return mimeToExt[baseContentType];
          }
          
          // Kiểm tra một phần
          for (const [mime, ext] of Object.entries(mimeToExt)) {
            if (baseContentType.includes(mime.split('/')[1])) {
              return ext;
            }
          }
        }
        
        // Kiểm tra Content-Disposition
        const contentDisposition = headResponse.headers['content-disposition'];
        const dispositionExt = getExtensionFromDisposition(contentDisposition);
        if (dispositionExt) {
          return dispositionExt;
        }
      } catch (headError) {
        // Nếu HEAD không thành công, tiếp tục với phương thức GET
        console.log("Không thể dùng phương thức HEAD, thử dùng GET:", headError.message);
      }
      
      // Nếu HEAD không thành công hoặc không xác định được, thử GET
      const getHeaders = { ...headers, Range: 'bytes=0-1024' };
      const getResponse = await axios.get(url, {
        headers: getHeaders,
        responseType: 'arraybuffer',
        timeout: 8000,
        maxRedirects: 5,
        validateStatus: status => status < 400
      });
      
      // Kiểm tra Content-Type
      const contentType = getResponse.headers['content-type']?.toLowerCase();
      if (contentType) {
        const baseContentType = contentType.split(';')[0].trim();
        if (mimeToExt[baseContentType]) {
          return mimeToExt[baseContentType];
        }
        
        // Kiểm tra một phần
        for (const [mime, ext] of Object.entries(mimeToExt)) {
          if (baseContentType.includes(mime.split('/')[1])) {
            return ext;
          }
        }
      }
      
      // Kiểm tra Content-Disposition
      const contentDisposition = getResponse.headers['content-disposition'];
      const dispositionExt = getExtensionFromDisposition(contentDisposition);
      if (dispositionExt) {
        return dispositionExt;
      }
      
      // Kiểm tra signature bytes cho các loại file phổ biến
      const buffer = Buffer.from(getResponse.data);
      
      if (buffer.length >= 12) {
        // JPEG/JPG signature
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
          return 'jpg';
        }
        // PNG signature
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
          return 'png';
        }
        // GIF signature
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
          return 'gif';
        }
        // MP4, M4A, M4V (MPEG-4)
        if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
          return 'mp4';
        }
        // MP3 (ID3v2)
        if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
          return 'mp3';
        }
        // WAV
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
            buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45) {
          return 'wav';
        }
        // WebP
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
            buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
          return 'webp';
        }
        // Matroska (MKV/WebM)
        if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) {
          return 'mkv';
        }
      }
      
      // Nếu không xác định được, trả về phần mở rộng từ URL
      return urlExtension || null;

    } catch (error) {
      // Tăng số lần thử và chờ trước khi thử lại
      attempts++;
      
      // Kiểm tra nếu response có headers
      if (error.response?.headers) {
        const contentType = error.response.headers['content-type']?.toLowerCase();
        if (contentType) {
          const baseContentType = contentType.split(';')[0].trim();
          if (mimeToExt[baseContentType]) {
            return mimeToExt[baseContentType];
          }
        }
        
        const contentDisposition = error.response.headers['content-disposition'];
        const dispositionExt = getExtensionFromDisposition(contentDisposition);
        if (dispositionExt) {
          return dispositionExt;
        }
      }
      
      if (attempts === maxAttempts) {
        console.error(`Không thể xác định định dạng file sau ${maxAttempts} lần thử:`, error.message);
        
        // Trường hợp đặc biệt cho Imgur
        if (url.includes('imgur.com')) {
          return 'jpg'; // Định dạng mặc định cho Imgur
        }
        
        // Trường hợp cuối cùng, thử lấy từ URL
        return getExtensionFromUrl(url);
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempts)); // Tăng thời gian chờ theo số lần thử
    }
  }
  
  return null;
}

/**
 * Tải và chuyển đổi ảnh sang PNG buffer từ đường dẫn hoặc URL
 * @param {string} source - Đường dẫn file hoặc URL của ảnh
 * @returns {Promise<Buffer>} Buffer dạng PNG của ảnh
 */
export async function loadImageBuffer(source) {
  try {
    let buffer;

    if (source.startsWith("http://") || source.startsWith("https://")) {
      const response = await axios({
        url: source,
        method: 'GET',
        responseType: 'arraybuffer',
        timeout: 3000
      });
      buffer = Buffer.from(response.data);
    } else {
      buffer = await fs.promises.readFile(source);
    }

    const sharp = await getSharp();
    const pngBuffer = await sharp(buffer)
      .png()
      .toBuffer();

    return pngBuffer;
  } catch (error) {
    console.error("Lỗi khi xử lý ảnh:", error.message);
    return null;
  }
}

/**
 * Lấy thông tin kích thước và dung lượng của ảnh thông qua ffmpeg
 * @param {string} imageUrl - URL hoặc đường dẫn của ảnh
 * @returns {Promise<{width: number, height: number, totalSize: number}>} Thông tin kích thước và dung lượng của ảnh
 */
export async function getImageInfo(imageUrl) {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const response = await axios.head(imageUrl);
      const totalSize = parseInt(response.headers["content-length"] || 0);

      const imageResponse = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        validateStatus: function (status) {
          return status < 500; // Chấp nhận status code < 500
        },
      });

      // Kiểm tra status code 409
      if (imageResponse.status === 409) {
        console.log("Nhận được status code 409, thử lại sau 1 giây...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        attempt++;
        continue;
      }

      // Kiểm tra các status code lỗi khác
      if (imageResponse.status !== 200) {
        throw new Error(`Lỗi HTTP status ${imageResponse.status}`);
      }

      const sharp = await getSharp();
      const metadata = await sharp(Buffer.from(imageResponse.data)).metadata();

      return {
        width: metadata.width || 500,
        height: metadata.height || 500,
        totalSize: totalSize || 0,
      };
    } catch (error) {
      // console.error(`Lần thử ${attempt + 1}/${maxRetries} thất bại:`, error.message);

      if (attempt === maxRetries - 1) {
        console.error("Đã hết 3 lần thử lại, trả về kích thước mặc định của ảnh");
        return {
          width: 500,
          height: 500,
          totalSize: 0,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      attempt++;
    }
  }
}

/**
 * Lấy thông tin kích thước và dung lượng của ảnh từ đường dẫn cục bộ
 * @param {string} imagePath - Đường dẫn cục bộ của ảnh
 * @returns {Promise<{width: number, height: number, totalSize: number}>} Thông tin kích thước và dung lượng của ảnh
 */
export async function getLocalImageInfo(imagePath) {
  try {
    if (!fs.existsSync(imagePath)) {
      throw new Error("File không tồn tại");
    }

    const stats = await fs.promises.stat(imagePath);
    const totalSize = stats.size;

    const buffer = fs.readFileSync(imagePath);
    const sharp = await getSharp();
    const metadata = await sharp(buffer).metadata();

    return {
      width: metadata.width || 500,
      height: metadata.height || 500,
      totalSize: totalSize || 0,
    };
  } catch (error) {
    console.error("Lỗi khi đọc thông tin ảnh:", error.message);
    return {
      width: 500,
      height: 500,
      totalSize: 0,
    };
  }
}



export async function deleteFile(pathFile, options = {}) {
  if (!pathFile) return;
  const delayMs = Number(options?.delayMs) > 0 ? Number(options.delayMs) : 0;
  if (delayMs > 0) {
    acquireTempLease(pathFile, delayMs + 15_000, {
      ownerTag: "deleteFile-delayed",
    });
    const timer = setTimeout(() => {
      performDelete(pathFile).catch(() => {});
    }, delayMs);
    timer.unref?.();
    return;
  }
  await performDelete(pathFile);
}

// ✅ Hàm xóa file an toàn với retry bất đồng bộ, giải phóng lease và không chặn event loop
async function performDelete(pathFile) {
  let attempts = 0;
  const maxAttempts = 3;

  try {
    while (attempts < maxAttempts) {
      try {
        await fs.promises.unlink(pathFile);
        return;
      } catch (error) {
        if (error?.code === "ENOENT") {
          return;
        }
        attempts++;
        if (attempts < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        } else {
          console.error(`❌ Không thể xóa file sau ${maxAttempts} lần thử: ${pathFile}`, error.message);
        }
      }
    }
  } finally {
    releaseTempLease(pathFile);
  }
}
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
