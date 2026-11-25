import path from "node:path";
import fs from "node:fs";
import dns from "node:dns";
import net from "node:net";
import axios from "axios";
import { getGlobalPrefix } from "../service.js";
import { getProjectRoot } from "../../utils/env.js";
import { checkExstentionFileRemote } from "../../utils/util.js";
import {
  sendMessageWarningRequest,
  sendMessageCompleteRequest,
} from "../chat-zalo/chat-style/chat-style.js";
import {
  extractCommandBody,
  getQuoteData,
} from "../../commands/shared/command-input-utils.js";

const AUTO_CREATABLE_RESOURCE_DIRS = new Set([
  "file",
  "filegame",
  "image",
  "video",
  "audio",
  "sticker",
  "gif",
]);

const PROTECTED_SYSTEM_DIRS = new Set(["game"]);

const BLOCKED_EXECUTABLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".jsx",
  ".tsx",
  ".bat",
  ".cmd",
  ".ps1",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".exe",
  ".dll",
  ".msi",
  ".com",
  ".scr",
  ".pif",
  ".sh",
  ".bash",
  ".zsh",
  ".php",
  ".py",
  ".rb",
  ".pl",
  ".jar",
  ".hta",
  ".reg",
]);

function getResourceBasePath() {
  return path.resolve(getProjectRoot(), "assets", "resources");
}

function resolveSafeResourceDir(rawDirName, { allowCreate = false } = {}) {
  const basePath = getResourceBasePath();
  const safeDir = path.basename(String(rawDirName || "").trim());
  if (!safeDir || safeDir === "." || safeDir === "..") {
    return null;
  }
  const fullPath = path.resolve(basePath, safeDir);
  if (!fullPath.startsWith(basePath + path.sep)) {
    return null;
  }

  const lowerDir = safeDir.toLowerCase();
  if (allowCreate && AUTO_CREATABLE_RESOURCE_DIRS.has(lowerDir) && !fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }

  return fullPath;
}

function isValidResourceDirectory(fullPath) {
  return Boolean(fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory());
}

export function isPrivateOrReservedIp(rawIp) {
  const ip = String(rawIp || "").trim().replace(/^\[|\]$/g, "").split("%")[0].toLowerCase();
  if (!ip) return true;

  const version = net.isIP(ip);
  if (version === 4) {
    const octets = ip.split(".").map((n) => Number.parseInt(n, 10));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return true;
    }
    const [a, b] = octets;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 0) return true; // 192.0.0.0/24
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
    if (a >= 224) return true; // multicast & reserved 224.0.0.0/4+
    return false;
  }

  if (version === 6) {
    if (ip === "::" || ip === "::1" || ip === "0:0:0:0:0:0:0:0" || ip === "0:0:0:0:0:0:0:1") {
      return true;
    }
    if (ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    if (ip.startsWith("fc") || ip.startsWith("fd")) {
      return true; // fc00::/7 unique local
    }
    if (ip.startsWith("ff")) {
      return true; // ff00::/8 multicast
    }
    if (ip.startsWith("::ffff:")) {
      const tail = ip.slice("::ffff:".length);
      if (net.isIP(tail) === 4) {
        return isPrivateOrReservedIp(tail);
      }
      const hexParts = tail.split(":");
      if (hexParts.length === 2) {
        const hi = Number.parseInt(hexParts[0], 16);
        const lo = Number.parseInt(hexParts[1], 16);
        if (Number.isInteger(hi) && Number.isInteger(lo)) {
          const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
          return isPrivateOrReservedIp(v4);
        }
      }
      return true;
    }
    return false;
  }

  return true;
}

export async function validateSafeRemoteResourceUrl(rawUrl, { lookupImpl = dns.promises.lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL không hợp lệ.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Chỉ cho phép tải tài nguyên qua giao thức http:// hoặc https://.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URL không được chứa thông tin xác thực nội bộ.");
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host) {
    throw new Error("Tên miền URL trống.");
  }

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^(?:0x[0-9a-f]+|\d+)$/i.test(host)
  ) {
    throw new Error("URL trỏ tới địa chỉ nội bộ hoặc bị cấm (SSRF blocked).");
  }

  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new Error("Không được phép tải tài nguyên từ địa chỉ IP nội bộ/loopback (SSRF blocked).");
    }
    return parsed.toString();
  }

  const resolvedRecords = await lookupImpl(host, { all: true, verbatim: true });
  const list = Array.isArray(resolvedRecords) ? resolvedRecords : [resolvedRecords];
  if (list.length === 0) {
    throw new Error("Không thể phân giải tên miền của URL.");
  }

  for (const record of list) {
    if (!record?.address || isPrivateOrReservedIp(record.address)) {
      throw new Error("Tên miền phân giải về địa chỉ IP nội bộ/riêng tư bị chặn (SSRF blocked).");
    }
  }

  return parsed.toString();
}

export function hasBlockedExecutableExtension(fileNameOrExt) {
  const normalized = String(fileNameOrExt || "")
    .trim()
    .replace(/[. ]+$/, "")
    .toLowerCase();
  if (!normalized) return false;

  if (normalized.startsWith(".") && !normalized.slice(1).includes(".")) {
    return BLOCKED_EXECUTABLE_EXTENSIONS.has(normalized);
  }

  const ext = path.extname(normalized);
  if (ext && BLOCKED_EXECUTABLE_EXTENSIONS.has(ext)) {
    return true;
  }

  // Kiểm tra cả trường hợp tên file nhiều chấm nguy hiểm (vd payload.exe.bin hoặc script.js)
  const parts = normalized.split(".").slice(1);
  return parts.some((part) => BLOCKED_EXECUTABLE_EXTENSIONS.has(`.${part}`));
}

async function downloadSafeRemoteFile(initialUrl, savePath, maxRedirects = 5) {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safeUrl = await validateSafeRemoteResourceUrl(currentUrl);
    const response = await axios({
      method: "GET",
      url: safeUrl,
      responseType: "stream",
      timeout: 30000,
      maxRedirects: 0,
      maxContentLength: 100 * 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        "User-Agent": "MYBOT-ResourceDownloader/3.0",
      },
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      response.data?.destroy?.();
      const location = response.headers?.location;
      if (!location) {
        throw new Error("Redirect thiếu header Location.");
      }
      currentUrl = new URL(location, safeUrl).toString();
      continue;
    }

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(savePath);
      response.data.on("error", reject);
      writer.on("error", reject);
      writer.on("finish", resolve);
      response.data.pipe(writer);
    });
    return;
  }

  throw new Error("URL chuyển hướng quá nhiều lần.");
}

function extractQuoteResourceUrl(quote) {
  if (!quote || typeof quote !== "object") return null;
  let parsed = null;
  if (quote.attach) {
    if (typeof quote.attach === "object") {
      parsed = quote.attach;
    } else if (typeof quote.attach === "string") {
      try {
        parsed = JSON.parse(quote.attach);
      } catch {
        parsed = null;
      }
    }
  }
  const raw =
    parsed?.hdUrl ||
    parsed?.oriUrl ||
    parsed?.href ||
    parsed?.normalUrl ||
    parsed?.fileUrl ||
    quote.hdUrl ||
    quote.href ||
    null;

  return typeof raw === "string" && raw.trim() ? raw.replace(/\\\//g, "/").trim() : null;
}

export async function handleDownloadResource(api, message, aliasCommand = "downloadresource") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "downloadresource";
  const body = extractCommandBody(message, prefix, cmdName);
  const args = body ? body.split("|").map((item) => item.trim()) : [];

  if (args.length < 2) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption:
          `Vui lòng nhập đúng cú pháp: ${prefix}${cmdName} [thư mục]|[tên file]|[link (nếu không reply)]\n` +
          `📂 Thư mục hỗ trợ: file, image, video, audio, sticker, gif`,
      },
      30000,
    );
    return;
  }

  const [rawDirName, rawFileName, link] = args;
  const dirName = path.basename(String(rawDirName || "").trim());
  if (PROTECTED_SYSTEM_DIRS.has(dirName.toLowerCase())) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `⛔ Thư mục hệ thống "${dirName}" được bảo vệ, không cho phép ghi thêm tài nguyên!`,
      },
      30000,
    );
    return;
  }

  const dirPath = resolveSafeResourceDir(rawDirName, { allowCreate: true });
  const cleanFileBase = path.basename(String(rawFileName || "").trim()).replace(/[. ]+$/, "");

  if (
    !dirPath ||
    !isValidResourceDirectory(dirPath) ||
    !cleanFileBase ||
    cleanFileBase === "." ||
    cleanFileBase === ".." ||
    cleanFileBase.startsWith(".")
  ) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Thư mục "${rawDirName}" hoặc tên file không hợp lệ trong kho resource!`,
      },
      30000,
    );
    return;
  }

  if (hasBlockedExecutableExtension(cleanFileBase)) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `⛔ Định dạng tệp thực thi/kịch bản trong "${cleanFileBase}" bị từ chối vì lý do bảo mật!`,
      },
      30000,
    );
    return;
  }

  const quote = getQuoteData(message);
  const fileUrl = extractQuoteResourceUrl(quote) || (link ? link.trim() : null);

  if (!fileUrl) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: "Vui lòng cung cấp link hợp lệ hoặc reply tin nhắn chứa media/file cần tải!",
      },
      30000,
    );
    return;
  }

  let savePath = null;
  try {
    const safeUrl = await validateSafeRemoteResourceUrl(fileUrl);

    let urlPathExt = "";
    try {
      urlPathExt = path.extname(new URL(safeUrl).pathname).toLowerCase();
    } catch {}
    if (urlPathExt && hasBlockedExecutableExtension(urlPathExt)) {
      throw new Error(`Định dạng tệp từ URL (${urlPathExt}) bị chặn vì lý do bảo mật.`);
    }

    let resolvedExt = "";
    if (!cleanFileBase.includes(".")) {
      resolvedExt = String((await checkExstentionFileRemote(safeUrl)) || "")
        .replace(/^\./, "")
        .toLowerCase();
      if (resolvedExt && hasBlockedExecutableExtension(`.${resolvedExt}`)) {
        throw new Error(`Định dạng tệp từ xa (.${resolvedExt}) bị chặn vì lý do bảo mật.`);
      }
    }

    const fullFileName = path.basename(
      cleanFileBase.includes(".")
        ? cleanFileBase
        : `${cleanFileBase}.${resolvedExt || urlPathExt.replace(/^\./, "") || "dat"}`,
    );

    if (hasBlockedExecutableExtension(fullFileName)) {
      throw new Error(`Tên tệp đích "${fullFileName}" chứa phần mở rộng bị cấm.`);
    }

    savePath = path.resolve(dirPath, fullFileName);
    if (!savePath.startsWith(dirPath + path.sep)) {
      throw new Error("Path traversal blocked");
    }

    if (fs.existsSync(savePath)) {
      const existingPath = savePath;
      savePath = null; // Không xóa file sẵn có trong finally
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `❌ File "${path.basename(existingPath)}" đã tồn tại trong thư mục "${dirName}"!\nVui lòng chọn tên file khác.`,
        },
        30000,
      );
      return;
    }

    fs.mkdirSync(dirPath, { recursive: true });
    await downloadSafeRemoteFile(safeUrl, savePath);

    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: `✅ Đã tải và lưu file thành công!\n📂 Thư mục: ${dirName}\n📄 Tên file: ${fullFileName}`,
      },
      30000,
    );
  } catch (error) {
    if (savePath && fs.existsSync(savePath)) {
      try {
        fs.unlinkSync(savePath);
      } catch {}
    }
    console.error("[downloadresource] Lỗi khi tải file resource:", error?.message || error);
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `❌ Không thể tải file: ${error?.message || "Vui lòng thử lại sau!"}`,
      },
      30000,
    );
  }
}

export async function handleDeleteResource(api, message, aliasCommand = "deleteresource") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "deleteresource";
  const body = extractCommandBody(message, prefix, cmdName);
  const args = body ? body.split("|").map((item) => item.trim()) : [];

  if (args.length < 2) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Vui lòng nhập đúng cú pháp: ${prefix}${cmdName} [thư mục]|[tên file chính xác]`,
      },
      30000,
    );
    return;
  }

  const [rawDirName, rawFileName] = args;
  const dirName = path.basename(String(rawDirName || "").trim());

  if (PROTECTED_SYSTEM_DIRS.has(dirName.toLowerCase())) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `⛔ Không được phép xóa tài nguyên hệ thống trong thư mục "${dirName}"!`,
      },
      30000,
    );
    return;
  }

  const dirPath = resolveSafeResourceDir(rawDirName, { allowCreate: false });
  const targetName = path.basename(String(rawFileName || "").trim());

  if (
    !dirPath ||
    !isValidResourceDirectory(dirPath) ||
    !targetName ||
    targetName === "." ||
    targetName === ".." ||
    targetName.startsWith(".")
  ) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Thư mục "${rawDirName}" hoặc tên file không hợp lệ trong resource!`,
      },
      30000,
    );
    return;
  }

  const regularFiles = fs.readdirSync(dirPath).filter((file) => {
    if (!file || file.startsWith(".")) return false;
    const candidatePath = path.resolve(dirPath, path.basename(file));
    if (!candidatePath.startsWith(dirPath + path.sep)) return false;
    try {
      return fs.statSync(candidatePath).isFile();
    } catch {
      return false;
    }
  });

  const targetLower = targetName.toLowerCase();
  let matchingFiles = regularFiles.filter((file) => file.toLowerCase() === targetLower);
  if (matchingFiles.length === 0 && !targetName.includes(".")) {
    matchingFiles = regularFiles.filter(
      (file) => path.parse(file).name.toLowerCase() === targetLower,
    );
  }

  if (matchingFiles.length === 0) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Không tìm thấy file khớp chính xác với "${targetName}" trong thư mục "${dirName}"!`,
      },
      30000,
    );
    return;
  }

  if (matchingFiles.length > 1) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption:
          `⚠️ Có nhiều file cùng tên "${targetName}" khác phần mở rộng (${matchingFiles.join(", ")}).\n` +
          `Vui lòng nhập đầy đủ cả phần mở rộng: ${prefix}${cmdName} ${dirName}|<tên_file.đuôi>`,
      },
      30000,
    );
    return;
  }

  try {
    const fileToDelete = matchingFiles[0];
    const filePath = path.resolve(dirPath, path.basename(fileToDelete));
    if (!filePath.startsWith(dirPath + path.sep) || !fs.existsSync(filePath)) {
      throw new Error("Đường dẫn file cần xóa không hợp lệ.");
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      throw new Error("Chỉ cho phép xóa tệp thông thường, không xóa thư mục.");
    }

    fs.unlinkSync(filePath);

    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: `✅ Đã xóa file thành công!\n📂 Thư mục: ${dirName}\n📄 File đã xóa: ${fileToDelete}`,
      },
      30000,
    );
  } catch (error) {
    console.error("[deleteresource] Lỗi khi xóa file resource:", error?.message || error);
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: "❌ Đã xảy ra lỗi khi xóa file. Vui lòng thử lại sau!",
      },
      30000,
    );
  }
}
