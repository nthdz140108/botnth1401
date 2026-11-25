import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import axios from "axios";
import { MessageMention } from "../../../../api-zalo/models/index.js";
import { tempDir } from "../../../../utils/io-json.js";
import { removeMention } from "../../../../utils/format-util.js";
import { getProjectRoot } from "../../../../utils/env.js";

// Cấu hình
const CONFIG = {
  saveDir: tempDir,
  baseDataPath: path.join(getProjectRoot(), "src", "service-debug", "chat-zalo", "chat-special", "data-send"),
  maxAttempts: 5,
  minImageSize: 10,
  downloadTimeout: 5000,
  secureRetry: {
    maxRetries: 2,
    timeout: 5000,
    domains: ['imgur.com', 'i.imgur.com', 'staticflickr.com', 'live.staticflickr.com']
  }
};

const textFileCache = new Map();

function readCachedLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const cached = textFileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.lines;
    }
    const lines = fs
      .readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    textFileCache.set(filePath, { mtimeMs: stat.mtimeMs, lines });
    return lines;
  } catch {
    return [];
  }
}

// Cấu hình loại ảnh
const IMAGE_TYPES = {
  girl: {
    variants: {
      default: { source: "zGirl.txt", ttl: 300000, downloadTimeout: 5000 },
      sexy: { source: "girlsexy.txt", ttl: 180000, type: "Sexy" },
      nguc: { source: "girlnguc.txt", ttl: 180000, type: "Ngực" },
      lon: { source: "girllon.txt", ttl: 180000, show: false, type: "Butterfly" },
      nude: { source: "girlnude.txt", ttl: 180000, type: "Khỏa Thân" },
      cosplay: { source: "cosplay.txt", ttl: 300000, type: "Cosplay" },
      anime: { source: "anime.txt", ttl: 300000, type: "Anime" },
    },
    text: "z_thinh_girl.txt",
  },
  boy: {
    variants: {
      default: { source: "boy.txt", ttl: 300000 },
      "6mui": { source: "boy6mui.txt", ttl: 300000, type: "6 Múi" },
    },
    text: "z_thinh_boy.txt",
  },
  cosplay: {
    variants: {
      default: { source: "cosplay.txt", ttl: 300000 },
    },
    text: "z_thinh_cosplay.txt",
  },
  anime: {
    variants: {
      default: { source: "anime.txt", ttl: 300000 },
    },
    text: "z_thinh_anime.txt",
  },
};

const KEYWORD_MAPPING = {
  girl: {
    sexy: ["sexy", "hot", "gợi cảm"],
    nguc: ["nguc", "ngực", "vú", "vu", "dú", "du", "zu", "zú"],
    lon: ["lon"],
    nude: ["nude", "khỏa thân"],
    cosplay: ["cos", "cosplay", "phim ảnh"],
    anime: ["anime", "wibu", "anm"],
  },
  boy: {
    "6mui": ["6mui", "6 múi", "cơ bụng"],
  },
};

// Kiểm tra xem url có thuộc domain cần xử lý đặc biệt không
function isSecureDomain(url) {
  return CONFIG.secureRetry.domains.some(domain => url.includes(domain));
}

// Tạo headers phù hợp cho request
function createHeaders(url) {
  const headers = {
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
  };

  if (url.includes('imgur.com')) {
    headers['Referer'] = 'https://imgur.com/';
  } else if (url.includes('staticflickr.com')) {
    headers['Referer'] = 'https://www.flickr.com/';
  }

  return headers;
}

async function downloadImage(url, filePath, timeout) {
  const isSecure = isSecureDomain(url);
  const retryConfig = isSecure ? {
    retries: CONFIG.secureRetry.maxRetries,
    timeout: CONFIG.secureRetry.timeout
  } : {
    retries: 1,
    timeout
  };

  let attempt = 0;
  
  while (attempt < retryConfig.retries) {
    try {
      const response = await axios({
        url,
        method: "GET",
        responseType: "stream",
        timeout: retryConfig.timeout,
        headers: createHeaders(url),
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400
      });

      return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        writer.on("finish", () => {
          const fileSizeInKb = fs.statSync(filePath).size / 1024;
          if (fileSizeInKb < CONFIG.minImageSize) {
            fs.unlinkSync(filePath);
            reject(new Error("Kích thước ảnh quá nhỏ"));
          } else {
            resolve();
          }
        });

        writer.on("error", (err) => {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          reject(err);
        });
      });
    } catch (error) {
      attempt++;
      
      console.log(`Thử lại lần ${attempt}/${retryConfig.retries} cho URL: ${url}. Lỗi: ${error.message}`);
      
      if (attempt >= retryConfig.retries) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        throw error.code === "ECONNABORTED" 
          ? new Error("Hết thời gian chờ khi tải ảnh") 
          : error;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

// Thêm hàm mới để lấy links ảnh
async function getImageLinks(config) {
  const variantConfig = config.variantConfig;

  if (variantConfig.source) {
    // Đọc từ file txt, bỏ thư mục Image
    const imagePath = path.join(CONFIG.baseDataPath, variantConfig.source);
    let links = readCachedLines(imagePath);
    if (links.length === 0) {
      const deletedBackupPath = imagePath.replace(/\.txt$/i, "_deleted.txt");
      if (fs.existsSync(deletedBackupPath)) {
        links = readCachedLines(deletedBackupPath);
      }
    }
    return links;
  } else if (variantConfig.api) {
    try {
      const response = await axios.get(variantConfig.api, {
        timeout: 5000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'application/json'
        }
      });
      if (response.status === 200) {
        return response.data.url.trim();
      }
      throw new Error(`Lỗi khi tải ảnh từ nguồn: mã trạng thái ${response.status}`);
    } catch (error) {
      console.error("Lỗi khi lấy dữ liệu từ API:", error);
      throw error;
    }
  }
  throw new Error("Không tìm thấy nguồn ảnh");
}

function tokenizeArgumentWords(argsText) {
  return String(argsText || "")
    .toLowerCase()
    .split(/[\s,.;:!?()[\]{}"'`~|/\\+-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function hasWholeKeywordMatch(tokens, keyword) {
  const kwTokens = tokenizeArgumentWords(keyword);
  if (kwTokens.length === 0 || tokens.length < kwTokens.length) return false;
  if (kwTokens.length === 1) {
    return tokens.includes(kwTokens[0]);
  }
  for (let i = 0; i <= tokens.length - kwTokens.length; i++) {
    if (kwTokens.every((part, offset) => tokens[i + offset] === part)) {
      return true;
    }
  }
  return false;
}

function getImageConfig(type, content) {
  const typeConfig = IMAGE_TYPES[type];
  if (!typeConfig) return null;

  let variant = "default";

  const typeKeywords = KEYWORD_MAPPING[type];
  if (typeKeywords) {
    const rawParts = String(content || "").trim().split(/\s+/).filter(Boolean);
    const argsText = rawParts.length > 1 ? rawParts.slice(1).join(" ") : "";
    const tokens = tokenizeArgumentWords(argsText);
    for (const [variantName, keywords] of Object.entries(typeKeywords)) {
      if (keywords.some((keyword) => hasWholeKeywordMatch(tokens, keyword))) {
        variant = variantName;
        break;
      }
    }
  }

  const variantConfig = typeConfig.variants[variant];
  return {
    variantConfig,
    textFile: typeConfig.text,
    ttl: variantConfig.ttl,
    downloadTimeout: variantConfig.downloadTimeout || CONFIG.downloadTimeout,
    variant: variantConfig.type ? variantConfig.type : variant,
  };
}

async function tryDownloadImage(imageLinks, type, downloadTimeout, isApiSource) {
  let attempts = 0;
  fs.mkdirSync(CONFIG.saveDir, { recursive: true });

  if (isApiSource) {
    let currentLinks = [...imageLinks];
    while (attempts < CONFIG.maxAttempts && currentLinks.length > 0) {
      const randomIndex = Math.floor(Math.random() * currentLinks.length);
      const imageUrl = currentLinks[randomIndex];
      const imagePath = path.join(CONFIG.saveDir, `${type}_${crypto.randomUUID()}.jpg`);

      try {
        await downloadImage(imageUrl, imagePath, downloadTimeout);
        return {
          success: true,
          path: imagePath,
          remainingLinks: imageLinks.filter((_, i) => i !== randomIndex),
          hadDieLinks: attempts > 0,
        };
      } catch (error) {
        console.error(`Lỗi tải ảnh: ${error.message}`);
        currentLinks.splice(randomIndex, 1);
        attempts++;
      }
    }
    return {
      success: false,
      remainingLinks: currentLinks,
      hadDieLinks: attempts > 0,
    };
  } else {
    while (attempts < CONFIG.maxAttempts) {
      const imagePath = path.join(CONFIG.saveDir, `${type}_${crypto.randomUUID()}.jpg`);
      try {
        await downloadImage(imageLinks, imagePath, downloadTimeout);
        return {
          success: true,
          path: imagePath,
        };
      } catch (error) {
        console.error(`Lỗi tải ảnh: ${error.message}`);
        attempts++;
      }
    }
    return {
      success: false,
    };
  }
}

// Thêm hàm mới để lấy danh sách đối số
function getArgumentList(type) {
  const typeConfig = IMAGE_TYPES[type];
  const typeKeywords = KEYWORD_MAPPING[type];
  if (!typeConfig || !typeKeywords) return null;

  const descriptions = Object.entries(typeKeywords)
    .filter(([variant]) => {
      const variantConfig = typeConfig.variants[variant];
      const isShow = variantConfig?.show ?? true;
      return isShow;
    })
    .map(([variant, keywords]) => {
      return `${typeConfig.variants[variant].type ? `${typeConfig.variants[variant].type}` : "Default"}: ${keywords.join(", ")}`;
    })
    .join("\n");

  return descriptions || null;
}

export async function sendImage(api, message, type) {
  const { dName: senderName, uidFrom: senderId } = message.data;
  const content = removeMention(message);
  const commandParts = content.trim().split(/\s+/).filter(Boolean);

  if (commandParts.length > 1 && commandParts[1].toLowerCase() === "map") {
    const argList = getArgumentList(type);
    await api.sendMessage(
      {
        msg: argList
          ? `Các đối số có thể dùng cho lệnh ${type}:\n${argList}`
          : `Lệnh ${type} không có danh mục phân nhóm con. Bạn hãy gõ trực tiếp ${commandParts[0]} để nhận ảnh nhé!`,
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
    return;
  }

  const config = getImageConfig(type, content);
  if (!config) return;
  const isApiSource = !!config.variantConfig.source;
  let downloadedPath = null;

  try {
    const thinhPath = path.join(CONFIG.baseDataPath, "Text", config.textFile);
    const thinhList = readCachedLines(thinhPath);
    const randomThing = thinhList.length > 0 ? thinhList[Math.floor(Math.random() * thinhList.length)] : "";

    const imageLinks = await getImageLinks(config);
    const downloadTimeout = config.downloadTimeout;

    const downloadResult = await tryDownloadImage(imageLinks, type, downloadTimeout, isApiSource);
    if (downloadResult.success) {
      downloadedPath = downloadResult.path;
      await api.sendMessage(
        {
          msg: `[ ${senderName} ] ${config.variant != "default" ? `( ${config.variant} )` : ""}\n${randomThing.replaceAll("\\n", "\n")}`,
          mentions: [MessageMention(senderId, senderName.length, 2, false)],
          attachments: [downloadResult.path],
          ttl: config.ttl,
        },
        message.threadId,
        message.type
      );
    } else {
      await api.sendMessage(
        {
          msg: "Xin lỗi, Không thể tải ảnh. Vui lòng thử lại sau.",
          quote: message,
          ttl: 30000,
        },
        message.threadId,
        message.type
      );
    }
  } catch (error) {
    console.error(`Lỗi trong quá trình xử lý: ${error.message}`);
    await api.sendMessage(
      {
        msg: "Gãy API mẹ òi, bảo mấy Đại Ca lấp api khác cho bé!",
        quote: message,
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
  } finally {
    if (downloadedPath && fs.existsSync(downloadedPath)) {
      try {
        fs.unlinkSync(downloadedPath);
      } catch {}
    }
  }
}