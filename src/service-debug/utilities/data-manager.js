import * as fs from "node:fs";
import path from "node:path";
import axios from "axios";
import {
  sendMessageCompleteRequest,
  sendMessageProcessingRequest,
  sendMessageWarningRequest,
  sendMessageStateQuote,
} from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { getProjectRoot } from "../../utils/env.js";
import {
  extractCommandBody,
  getQuoteData,
} from "../../commands/shared/command-input-utils.js";

const BASE_DATA_PATH = path.resolve(
  getProjectRoot(),
  "src",
  "service-debug",
  "chat-zalo",
  "chat-special",
  "data-send",
);
const removedLinksDir = path.resolve(BASE_DATA_PATH, "removed-links");

const VALID_STATUS_CODES = [200, 201, 202, 204, 301, 302, 307, 308];

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; LinkChecker/1.0)",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

export function resolveSafeDataFilePath(rawFileName, baseDir = BASE_DATA_PATH) {
  const raw = String(rawFileName ?? "").trim();
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  let safeName = path.basename(raw);
  if (!safeName || safeName === "." || safeName === "..") {
    return null;
  }
  if (!safeName.toLowerCase().endsWith(".txt")) {
    safeName += ".txt";
  }
  const resolvedBase = path.resolve(baseDir);
  const fullPath = path.resolve(resolvedBase, safeName);
  if (!fullPath.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return { fileName: safeName, fullPath };
}

function isValidUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

async function checkLinkStatus(url, retryCount = 0, maxRetries = 3) {
  try {
    const response = await axios.head(url, {
      timeout: 6000,
      maxRedirects: 5,
      headers: DEFAULT_HEADERS,
      validateStatus: (status) => status < 500,
    });
    return VALID_STATUS_CODES.includes(response.status);
  } catch (error) {
    if (error.response?.status === 405 || error.response?.status === 403) {
      try {
        const response = await axios.get(url, {
          timeout: 6000,
          maxRedirects: 5,
          headers: DEFAULT_HEADERS,
          responseType: "stream",
          validateStatus: (status) => status < 500,
        });
        response.data?.destroy?.();
        return VALID_STATUS_CODES.includes(response.status);
      } catch {
        return false;
      }
    }

    if (error.response?.status === 429 && retryCount < maxRetries) {
      const backoffTime = 2000 * Math.pow(2, retryCount);
      await new Promise((r) => setTimeout(r, backoffTime));
      return checkLinkStatus(url, retryCount + 1, maxRetries);
    }

    return false;
  }
}

async function processInBatches(links, batchSize = 5) {
  const validLinks = [];
  const invalidLinks = [];

  for (let i = 0; i < links.length; i += batchSize) {
    const batch = links.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((link) => checkLinkStatus(link.trim())),
    );

    results.forEach((result, index) => {
      const link = batch[index].trim();
      if (result.status === "fulfilled" && result.value === true) {
        validLinks.push(link);
      } else {
        invalidLinks.push({
          url: link,
          error: result.reason?.message || "Link not accessible",
          status: result.reason?.response?.status || "N/A",
        });
      }
    });

    if (i + batchSize < links.length) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  return { validLinks, invalidLinks };
}

async function uploadUrlToCatboxWithRetry(fileUrl, { maxRetries = 3, timeoutMs = 25000 } = {}) {
  const apiEndpoint = "https://catbox.moe/user/api.php";
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const formData = new URLSearchParams();
      formData.append("reqtype", "urlupload");
      formData.append("url", fileUrl);

      const response = await axios.post(apiEndpoint, formData, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          ...DEFAULT_HEADERS,
        },
        timeout: timeoutMs,
      });

      const uploadedLink = String(response.data || "").trim();
      if (!uploadedLink || uploadedLink.startsWith("Error") || !isValidUrl(uploadedLink)) {
        throw new Error(uploadedLink.replace(/^Error:\s*/i, "") || "Catbox trả về phản hồi không hợp lệ");
      }
      return uploadedLink;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delayMs = 1500 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError || new Error("Upload lên Catbox thất bại");
}

function buildDataUsageGuide(prefix, cmdName, senderName) {
  let availableHint = "";
  if (fs.existsSync(BASE_DATA_PATH)) {
    try {
      const txtFiles = fs
        .readdirSync(BASE_DATA_PATH)
        .filter((f) => f.endsWith(".txt") && !f.endsWith("_backup.txt") && !f.endsWith("_deleted.txt"))
        .map((f) => path.basename(f, ".txt"))
        .slice(0, 12);
      if (txtFiles.length > 0) {
        availableHint = `\n📂 Kho hiện có: ${txtFiles.join(", ")}`;
      }
    } catch {}
  }

  return (
    `📚 HƯỚNG DẪN QUẢN LÝ DỮ LIỆU (${senderName}):\n` +
    `• ${prefix}${cmdName} <tên_file> (reply vào video/ảnh): Tải media lên Catbox và lưu link vào <tên_file>.txt\n` +
    `• ${prefix}${cmdName} add <tên_file> [link]: Thêm link trực tiếp hoặc từ tin nhắn reply vào <tên_file>.txt\n` +
    `• ${prefix}${cmdName} check <tên_file>: Kiểm tra và lọc bỏ các link chết trong <tên_file>.txt` +
    availableHint
  );
}

export async function handleDataCommand(api, message, aliasCommand = "data") {
  const senderName = message.data?.dName || "Người dùng";
  const quote = getQuoteData(message);
  const botId = api?.getBotId?.();
  const prefix = getGlobalPrefix(botId);
  const cmdName = aliasCommand || "data";

  const contentWithoutCommand = extractCommandBody(message, prefix, cmdName);
  if (!contentWithoutCommand) {
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: buildDataUsageGuide(prefix, cmdName, senderName),
      },
      60000,
    );
    return;
  }

  const args = contentWithoutCommand.split(/\s+/).filter(Boolean);
  const firstLower = args[0]?.toLowerCase();

  let action = "add";
  let rawFileName = "";
  let directUrlArg = "";

  if (firstLower === "check") {
    action = "check";
    rawFileName = args[1] || "";
  } else if (firstLower === "add") {
    action = "add";
    rawFileName = args[1] || "";
    directUrlArg = args[2] || "";
  } else {
    action = "add";
    rawFileName = args[0] || "";
    directUrlArg = args[1] || "";
  }

  if (!rawFileName) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `${senderName}, vui lòng chỉ định tên file dữ liệu!\n\n${buildDataUsageGuide(prefix, cmdName, senderName)}`,
      },
      45000,
    );
    return;
  }

  const resolvedFile = resolveSafeDataFilePath(rawFileName);
  if (!resolvedFile) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `${senderName}, tên file "${rawFileName}" không hợp lệ!`,
      },
      30000,
    );
    return;
  }
  const { fileName, fullPath } = resolvedFile;

  if (action === "check") {
    try {
      if (!fs.existsSync(fullPath)) {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption: `${senderName}, không tìm thấy file ${fileName}.`,
          },
          30000,
        );
        return;
      }

      const fileContent = fs.readFileSync(fullPath, "utf-8").trim();
      let links = fileContent
        .split(/\r?\n/)
        .map((link) => link.trim())
        .filter((link) => link && !link.startsWith("#") && isValidUrl(link));

      if (links.length === 0) {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption: `${senderName}, file ${fileName} không chứa link hợp lệ nào.`,
          },
          30000,
        );
        return;
      }

      links = [...new Set(links)];

      await sendMessageProcessingRequest(
        api,
        message,
        {
          caption: `${senderName}, đang kiểm tra ${links.length} link trong ${fileName} (đã loại bỏ trùng lặp)...`,
        },
        60000,
      );

      const { validLinks, invalidLinks } = await processInBatches(links, 5);
      const updatedContent =
        validLinks.length > 0 ? validLinks.join("\n") : "# No valid links left";
      fs.writeFileSync(fullPath, updatedContent, "utf8");

      if (invalidLinks.length > 0) {
        fs.mkdirSync(removedLinksDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const safeBase = path.basename(fileName, path.extname(fileName));
        const removedLinksFile = path.resolve(
          removedLinksDir,
          `removed_links_${safeBase}_${timestamp}.txt`,
        );

        const removedLinksContent =
          `# Links đã xóa từ file ${fileName}\n` +
          `# Thời gian: ${new Date().toLocaleString("vi-VN")}\n` +
          `# Số lượng: ${invalidLinks.length}\n` +
          `# Tổng links đã kiểm tra: ${links.length}\n\n` +
          invalidLinks
            .map((item) => `${item.url} # Error: ${item.error} (Status: ${item.status})`)
            .join("\n");

        if (removedLinksFile.startsWith(path.resolve(removedLinksDir) + path.sep)) {
          fs.writeFileSync(removedLinksFile, removedLinksContent, "utf8");
        }

        await sendMessageCompleteRequest(
          api,
          message,
          {
            caption:
              `${senderName}, kết quả kiểm tra file ${fileName}:\n\n` +
              `✅ Links còn hoạt động: ${validLinks.length}\n` +
              `❌ Links đã xóa: ${invalidLinks.length}`,
          },
          300000,
        );
      } else {
        await sendMessageCompleteRequest(
          api,
          message,
          {
            caption: `${senderName}, tất cả ${validLinks.length} links trong file ${fileName} đều hoạt động tốt.`,
          },
          60000,
        );
      }
    } catch (error) {
      console.error("[data] Lỗi xử lý lệnh kiểm tra:", error);
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `${senderName}, đã xảy ra lỗi khi kiểm tra: ${error.message}\nVui lòng thử lại sau.`,
        },
        30000,
      );
    }
    return;
  }

  // Nhánh add
  try {
    let targetLink = "";
    if (directUrlArg && isValidUrl(directUrlArg)) {
      targetLink = directUrlArg.trim();
    } else if (quote?.attach) {
      const attachData =
        typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
      const rawMediaUrl =
        attachData?.hdUrl ||
        attachData?.href ||
        attachData?.oriUrl ||
        attachData?.normalUrl ||
        attachData?.thumbUrl ||
        "";
      const cleanMediaUrl = String(rawMediaUrl).replace(/\\\//g, "/").trim();
      if (!cleanMediaUrl || !isValidUrl(cleanMediaUrl)) {
        await sendMessageStateQuote(api, message, "Không tìm thấy URL hợp lệ trong tin nhắn reply!", false, 15000);
        return;
      }

      await sendMessageProcessingRequest(
        api,
        message,
        { caption: `${senderName}, đang tải media lên Catbox (tự động thử lại nếu nghẽn)...` },
        45000,
      );

      targetLink = await uploadUrlToCatboxWithRetry(cleanMediaUrl, {
        maxRetries: 3,
        timeoutMs: 25000,
      });
    } else {
      await sendMessageStateQuote(
        api,
        message,
        `Vui lòng reply vào tin nhắn chứa video/ảnh hoặc truyền kèm URL hợp lệ!\nVí dụ: ${prefix}${cmdName} ${path.basename(fileName, ".txt")}`,
        false,
        20000,
      );
      return;
    }

    await fs.promises.mkdir(BASE_DATA_PATH, { recursive: true });

    if (fs.existsSync(fullPath)) {
      const existingLines = fs
        .readFileSync(fullPath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim());
      if (existingLines.includes(targetLink)) {
        await sendMessageStateQuote(
          api,
          message,
          `Link này đã tồn tại trong file ${fileName}!`,
          false,
          15000,
        );
        return;
      }
    }

    await fs.promises.appendFile(fullPath, `${targetLink}\n`, "utf8");
    await sendMessageStateQuote(
      api,
      message,
      `✅ Đã lưu thành công vào tệp ${fileName}!`,
      true,
      30000,
    );
  } catch (error) {
    console.error("[data] Lỗi khi xử lý thêm link:", error?.message || error);
    await sendMessageStateQuote(
      api,
      message,
      `❌ Không thể lưu link: ${error?.message || "Lỗi kết nối Catbox"}`,
      false,
      20000,
    );
  }
}
