import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { getGlobalPrefix } from "../service.js";
import { getProjectRoot } from "../../utils/env.js";
import { removeMention } from "../../utils/format-util.js";
import { safeThreadType } from "../../commands/shared/command-input-utils.js";

const CONFIG = {
  maxAttempts: 3,
  requestTimeout: 5000,
  concurrentRequests: 10,
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  ],
};

// Khóa chống quét trùng đồng thời trên cùng một file dữ liệu
export const activeScanFiles = new Set();

function getRandomUserAgent() {
  const index = Math.floor(Math.random() * CONFIG.userAgents.length);
  return CONFIG.userAgents[index];
}

async function checkUrlStatus(url) {
  try {
    const headers = {
      "User-Agent": getRandomUserAgent(),
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br",
      DNT: "1",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "max-age=0",
    };

    if (url.includes("imgur.com")) {
      headers.Referer = "https://imgur.com/";
    }

    await axios({
      url,
      method: "HEAD",
      timeout: CONFIG.requestTimeout,
      headers,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return true;
  } catch {
    try {
      const response = await axios({
        url,
        method: "GET",
        timeout: CONFIG.requestTimeout,
        headers: {
          "User-Agent": getRandomUserAgent(),
        },
        validateStatus: (status) => status >= 200 && status < 400,
        responseType: "stream",
        maxContentLength: 1024,
      });

      response.data?.destroy?.();
      return true;
    } catch {
      return false;
    }
  }
}

export function readUrlsFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    console.error(`[scanapi] Lỗi khi đọc file ${filePath}: ${error.message}`);
    return [];
  }
}

function writeUrlsToFile(filePath, urls) {
  try {
    fs.writeFileSync(filePath, urls.join("\n"), "utf8");
  } catch (error) {
    console.error(`[scanapi] Lỗi khi ghi file ${filePath}: ${error.message}`);
  }
}

async function processUrlsInBatches(urls) {
  const validUrls = [];
  const invalidUrls = [];

  for (let i = 0; i < urls.length; i += CONFIG.concurrentRequests) {
    const batch = urls.slice(i, i + CONFIG.concurrentRequests);

    const batchResults = await Promise.all(
      batch.map(async (rawUrl) => {
        const url = rawUrl.trim();
        let isValid = false;
        let attempts = 0;

        while (attempts < CONFIG.maxAttempts && !isValid) {
          isValid = await checkUrlStatus(url);
          attempts += 1;

          if (!isValid && attempts < CONFIG.maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 800 + 400));
          }
        }

        return { url, isValid };
      }),
    );

    batchResults.forEach(({ url, isValid }) => {
      if (isValid) {
        validUrls.push(url);
      } else {
        invalidUrls.push(url);
      }
    });
  }

  return { validUrls, invalidUrls };
}

const BASE_DATA_PATH = path.resolve(
  getProjectRoot(),
  "src",
  "service-debug",
  "chat-zalo",
  "chat-special",
  "data-send",
);

export function resolveSafeScanFilePath(rawFileName, baseDir = BASE_DATA_PATH) {
  const raw = String(rawFileName ?? "").trim();
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const baseName = path.basename(raw).replace(/\.txt$/i, "");
  if (!baseName || baseName === "." || baseName === "..") {
    return null;
  }
  const resolvedBase = path.resolve(baseDir);
  const filePath = path.resolve(resolvedBase, `${baseName}.txt`);
  if (!filePath.startsWith(resolvedBase + path.sep)) {
    return null;
  }
  return { fileName: baseName, filePath };
}

export async function scanApi(api, message, aliasCommand = "scanapi") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "scanapi";
  const threadType = safeThreadType(message);
  const cleanedText = (removeMention(message) || message?.data?.content || "").trim();
  const tokens = cleanedText ? cleanedText.split(/\s+/).filter(Boolean) : [];

  if (tokens.length < 2) {
    await api.sendMessage(
      {
        msg: `Vui lòng cung cấp tên file để quét. Ví dụ: ${prefix}${cmdName} girl`,
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      threadType,
    );
    return;
  }

  const resolvedTarget = resolveSafeScanFilePath(tokens[1]);
  if (!resolvedTarget) {
    await api.sendMessage(
      {
        msg: "❌ Tên file không hợp lệ!",
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      threadType,
    );
    return;
  }

  const { fileName, filePath } = resolvedTarget;
  const lockKey = filePath.toLowerCase();

  if (activeScanFiles.has(lockKey)) {
    await api.sendMessage(
      {
        msg: `⏳ File ${fileName}.txt hiện đang được quét! Vui lòng chờ lượt quét hiện tại hoàn tất.`,
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      threadType,
    );
    return;
  }

  activeScanFiles.add(lockKey);

  (async () => {
    try {
      const urls = readUrlsFromFile(filePath);
      if (urls.length === 0) {
        await api.sendMessage(
          {
            msg: `Không tìm thấy URL hợp lệ trong file ${fileName}.txt hoặc file không tồn tại.`,
            quote: message,
            ttl: 30000,
          },
          message.threadId,
          threadType,
        );
        return;
      }

      await api.sendMessage(
        {
          msg: `🔍 Đang quét ${urls.length} URL từ file ${fileName}.txt. Quá trình này có thể mất vài phút...`,
          quote: message,
          ttl: 30000,
        },
        message.threadId,
        threadType,
      );

      const backupFilePath = filePath.replace(/\.txt$/i, "_backup.txt");
      fs.copyFileSync(filePath, backupFilePath);

      const { validUrls, invalidUrls } = await processUrlsInBatches(urls);

      writeUrlsToFile(filePath, validUrls);

      const invalidFilePath = filePath.replace(/\.txt$/i, "_deleted.txt");
      let existingInvalidUrls = [];
      if (fs.existsSync(invalidFilePath)) {
        existingInvalidUrls = readUrlsFromFile(invalidFilePath);
      }

      const allInvalidUrls = [...new Set([...existingInvalidUrls, ...invalidUrls])];
      writeUrlsToFile(invalidFilePath, allInvalidUrls);

      await api.sendMessage(
        {
          msg:
            `✅ Đã quét xong file ${fileName}.txt\n` +
            `- Tổng số URL ban đầu: ${urls.length}\n` +
            `- URL hợp lệ: ${validUrls.length}\n` +
            `- URL không hợp lệ: ${invalidUrls.length}\n\n` +
            `Các URL không hợp lệ đã được lưu vào ${fileName}_deleted.txt\n` +
            `Bản sao dự phòng đã được lưu vào ${fileName}_backup.txt`,
          quote: message,
          ttl: 600000,
        },
        message.threadId,
        threadType,
      );
    } catch (error) {
      console.error(`[scanapi] Lỗi khi quét API: ${error.message}`);
      await api.sendMessage(
        {
          msg: `❌ Đã xảy ra lỗi khi quét file ${fileName}.txt: ${error.message}`,
          quote: message,
          ttl: 30000,
        },
        message.threadId,
        threadType,
      );
    } finally {
      activeScanFiles.delete(lockKey);
    }
  })();
}
