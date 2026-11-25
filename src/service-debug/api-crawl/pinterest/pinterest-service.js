import crypto from "node:crypto";
import axios from "axios";
import * as cheerio from "cheerio";
import fs from "fs";
import path from "path";
import { MessageMention } from "../../../api-zalo/models/index.js";
import { getGlobalPrefix } from "../../service.js";
import { tempDir } from "../../../utils/io-json.js";
import { deleteFile, downloadFile } from "../../../utils/util.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../../commands/shared/command-input-utils.js";

const CONFIG = {
  paths: {
    saveDir: tempDir,
  },
  download: {
    maxAttempts: 3,
    timeout: 10000,
    minSize: 1024,
    defaultImageCount: 5,
    maxImageCount: 24,
  },
  api: {
    pinterestLimit: 50,
    userAgents: [
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    ],
  },
  messages: {
    noQuery: (name, prefix, command) =>
      `${name} Vui lòng nhập từ khóa tìm kiếm (thêm -<số> hoặc &&<số> để chọn số ảnh).\nVí dụ: ${prefix}${command} con mèo -3 hoặc ${prefix}${command} iphone 16`,
    searchResult: (name, query, count) => `${name} Kết quả ảnh "${query}" (${count} ảnh)`,
    downloadFailed: (name, attempts) =>
      `${name} Không thể tải ảnh sau ${attempts} lần thử. Vui lòng thử lại sau.`,
    noResults: (name) => `${name} Không tìm thấy ảnh phù hợp. Vui lòng thử lại sau.`,
    apiError: (name) => `${name} Tạm thời không thể tìm kiếm ảnh Pinterest, vui lòng thử lại sau.`,
  },
};

function getRandomUserAgent() {
  const userAgents = CONFIG.api.userAgents;
  const randomIndex = Math.floor(Math.random() * userAgents.length);
  return userAgents[randomIndex];
}

export function parsePinterestQueryAndCount(rawBody) {
  const trimmed = String(rawBody || "").trim();
  if (!trimmed) {
    return {
      query: "",
      count: CONFIG.download.defaultImageCount,
    };
  }

  const suffixMatch = trimmed.match(/^(.*?)(?:\s*&&\s*(\d+)|\s+-(\d+))\s*$/);
  if (suffixMatch) {
    const cleanQuery = suffixMatch[1].trim();
    const rawCount = Number.parseInt(suffixMatch[2] || suffixMatch[3], 10);
    if (cleanQuery && Number.isFinite(rawCount) && rawCount >= 1) {
      return {
        query: cleanQuery,
        count: Math.min(rawCount, CONFIG.download.maxImageCount),
      };
    }
  }

  return {
    query: trimmed,
    count: CONFIG.download.defaultImageCount,
  };
}

async function handleAlternativePinterest(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = "https://www.pinterest.com/resource/BaseSearchResource/get/";
    const appVersion = `1.${Math.floor(Math.random() * 10)}.${Math.floor(Math.random() * 100)}`;

    const data = {
      options: {
        query,
        scope: "pins",
        auto_correction_disabled: false,
        redux_normalize_feed: true,
        rs: "typed",
        isPrefetch: false,
        no_fetch_context_on_resource: false,
        applied_unified_filters: null,
        appliedProductFilters: "---",
        filters: null,
        bookmarks: [],
        field_set_key: "unauth_react",
        page_size: CONFIG.api.pinterestLimit,
        source_url: `/search/pins/?q=${encodedQuery}&rs=typed`,
      },
      context: {},
    };

    const headers = {
      "User-Agent": getRandomUserAgent(),
      Accept: "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `https://www.pinterest.com/search/pins/?q=${encodedQuery}`,
      "X-Requested-With": "XMLHttpRequest",
      "X-APP-VERSION": appVersion,
      Origin: "https://www.pinterest.com",
    };

    const response = await axios({
      method: "get",
      url: searchUrl,
      headers,
      params: {
        source_url: `/search/pins/?q=${encodedQuery}`,
        data: JSON.stringify(data),
        _: Date.now() + Math.floor(Math.random() * 1000),
      },
      timeout: CONFIG.download.timeout,
    });

    const results = response.data?.resource_response?.data?.results;
    if (Array.isArray(results)) {
      return results
        .filter((pin) => pin?.images && (pin.images.orig || pin.images["736x"] || pin.images["474x"]))
        .map((pin) => pin.images.orig?.url || pin.images["736x"]?.url || pin.images["474x"]?.url)
        .filter(Boolean);
    }
    return [];
  } catch (error) {
    console.error("Lỗi Pinterest dự phòng:", error?.message || error);
    return [];
  }
}

async function handleOriginalPinterest(query) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = "https://www.pinterest.com/resource/SearchResource/get/";

    const data = {
      options: {
        article: null,
        appliedProductFilters: "---",
        auto_correction_disabled: false,
        query,
        scope: "pins",
        page_size: CONFIG.api.pinterestLimit,
        source: "typed",
        top_level_source: null,
        filters: null,
        rs: null,
      },
      context: {},
    };

    const headers = {
      "User-Agent": getRandomUserAgent(),
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-AppState": "active",
      "X-Pinterest-PWS-Handler": "www/search/SearchResource.get",
      Referer: `https://www.pinterest.com/search/pins/?q=${encodedQuery}`,
      Origin: "https://www.pinterest.com",
    };

    const response = await axios({
      method: "get",
      url: searchUrl,
      headers,
      params: {
        source_url: `/search/pins/?q=${encodedQuery}`,
        data: JSON.stringify(data),
        _: Date.now(),
      },
      timeout: CONFIG.download.timeout,
    });

    const rawData = response.data?.resource_response?.data;
    const results = Array.isArray(rawData) ? rawData : Array.isArray(rawData?.results) ? rawData.results : [];
    const imageUrls = [];
    for (const item of results) {
      if (item?.images && (item.images.orig || item.images["736x"] || item.images["474x"])) {
        const url = item.images.orig?.url || item.images["736x"]?.url || item.images["474x"]?.url;
        if (url) imageUrls.push(url);
      }
    }
    return imageUrls;
  } catch (error) {
    console.error("Lỗi Pinterest chính:", error?.message || error);
    return [];
  }
}

async function handleBingImageSearch(query) {
  try {
    const params = new URLSearchParams({
      q: `${query} aesthetic pinterest`,
      form: "HDRSC2",
      first: "1",
    });
    const response = await axios.get(`https://www.bing.com/images/search?${params.toString()}`, {
      timeout: CONFIG.download.timeout,
      headers: {
        "User-Agent": getRandomUserAgent(),
        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      },
    });
    const $ = cheerio.load(String(response.data || ""));
    const urls = [];
    const seen = new Set();
    $("a.iusc").each((_, el) => {
      const mRaw = $(el).attr("m");
      if (!mRaw) return;
      try {
        const parsed = JSON.parse(mRaw);
        const murl = parsed?.murl;
        if (typeof murl === "string" && /^https?:\/\//i.test(murl) && !seen.has(murl)) {
          seen.add(murl);
          urls.push(murl);
        }
      } catch {
        // ignore invalid json
      }
    });
    return urls.slice(0, CONFIG.api.pinterestLimit);
  } catch (error) {
    console.error("Lỗi Bing Image Search fallback:", error?.message || error);
    return [];
  }
}

async function handleGoogleImageSearch(query) {
  try {
    const encodedQuery = encodeURIComponent(`${query} pinterest`);
    const searchUrl = `https://www.google.com/search?q=${encodedQuery}&tbm=isch&sclient=img`;

    const response = await axios({
      method: "get",
      url: searchUrl,
      headers: {
        "User-Agent": getRandomUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
        Referer: "https://www.google.com/",
      },
      timeout: CONFIG.download.timeout,
      responseType: "text",
    });

    const imgRegex = /\["(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))",\d+,\d+\]/g;
    let match;
    const imageUrls = [];

    while ((match = imgRegex.exec(response.data)) !== null) {
      const url = match[1];
      if (
        url &&
        url.startsWith("https://") &&
        !url.startsWith("https://encrypted-tbn0.gstatic.com") &&
        !imageUrls.includes(url)
      ) {
        imageUrls.push(url);
      }
      if (imageUrls.length >= CONFIG.api.pinterestLimit) {
        break;
      }
    }

    return imageUrls;
  } catch (error) {
    console.error("Lỗi Google Image Search:", error?.message || error);
    return [];
  }
}

async function downloadMultipleImages(imageUrls, count) {
  const downloadedImages = new Array(count).fill(null);
  const pool = Array.isArray(imageUrls) ? [...imageUrls] : [];
  for (let idx = pool.length - 1; idx > 0; idx--) {
    const swapIdx = Math.floor(Math.random() * (idx + 1));
    [pool[idx], pool[swapIdx]] = [pool[swapIdx], pool[idx]];
  }

  const IMAGE_BASE_DIR = path.join(CONFIG.paths.saveDir, "temp_images");
  await fs.promises.mkdir(IMAGE_BASE_DIR, { recursive: true });

  let poolCursor = 0;
  const nextCandidateUrl = () => {
    if (poolCursor >= pool.length) return null;
    return pool[poolCursor++];
  };

  const downloadSlot = async (slotIndex) => {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const imageUrl = nextCandidateUrl();
      if (!imageUrl) break;
      const tempFileName = `pin_${Date.now()}_${crypto.randomUUID()}_${slotIndex}_${attempt}.jpg`;
      const imagePath = path.join(IMAGE_BASE_DIR, tempFileName);

      try {
        await downloadFile(imageUrl, imagePath, { timeout: CONFIG.download.timeout });
        if (!fs.existsSync(imagePath)) {
          throw new Error("File không tồn tại sau khi tải");
        }
        const stats = fs.statSync(imagePath);
        if (stats.size < CONFIG.download.minSize) {
          throw new Error("Ảnh tải về quá nhỏ");
        }
        downloadedImages[slotIndex] = imagePath;
        return;
      } catch (error) {
        console.error(`Ảnh ${slotIndex + 1}, lần thử ${attempt + 1} thất bại:`, error?.message || error);
        try {
          if (fs.existsSync(imagePath)) {
            await deleteFile(imagePath);
          }
        } catch {
          // ignore cleanup failure
        }
      }
    }
  };

  const concurrency = Math.min(4, count);
  let nextSlot = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextSlot < count) {
        const slot = nextSlot++;
        await downloadSlot(slot);
      }
    })
  );

  return downloadedImages.filter(Boolean);
}

async function sendMultipleImages(api, message, imagePaths, query) {
  const threadId = message.threadId;
  const type = safeThreadType(message);
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName || "Bạn";

  try {
    if (imagePaths.length === 0) {
      await api.sendMessage(
        {
          msg: CONFIG.messages.downloadFailed(senderName, CONFIG.download.maxAttempts),
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 300000,
        },
        threadId,
        type
      );
      return false;
    }

    const captionText = CONFIG.messages.searchResult(senderName, query, imagePaths.length);
    const mentionList = [MessageMention(senderId, senderName.length, 0)];

    if (typeof api.zSendLocalImages === "function") {
      await api.zSendLocalImages(
        imagePaths,
        threadId,
        type,
        800,
        600,
        {
          text: captionText,
          mention: mentionList,
        },
        60000 * 60
      );
    } else {
      await api.sendMessage(
        {
          msg: captionText,
          attachments: imagePaths,
          quote: message,
          mentions: mentionList,
          ttl: 60000 * 60,
        },
        threadId,
        type
      );
    }
    return true;
  } catch (error) {
    console.error("Lỗi khi gửi nhiều ảnh Pinterest:", error?.message || error);
    await api.sendMessage(
      {
        msg: `${senderName} Có lỗi xảy ra khi gửi ảnh.`,
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      threadId,
      type
    );
    return false;
  } finally {
    for (const imagePath of imagePaths) {
      try {
        if (fs.existsSync(imagePath)) {
          await deleteFile(imagePath);
        }
      } catch {
        // ignore cleanup error
      }
    }
  }
}

export async function searchImagePinterest(api, message, command = "pinterest") {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName || "Bạn";
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const prefix = getGlobalPrefix();

  const rawBody = extractCommandBody(message, prefix, command);
  const { query, count: imageCount } = parsePinterestQueryAndCount(rawBody);

  if (!query) {
    await api.sendMessage(
      {
        msg: CONFIG.messages.noQuery(senderName, prefix, command),
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      threadId,
      threadType
    );
    return;
  }

  try {
    let finalImageUrls = await handleOriginalPinterest(query);

    if (finalImageUrls.length === 0) {
      finalImageUrls = await handleAlternativePinterest(query);
    }
    if (finalImageUrls.length === 0) {
      finalImageUrls = await handleBingImageSearch(query);
    }
    if (finalImageUrls.length === 0) {
      finalImageUrls = await handleGoogleImageSearch(query);
    }

    if (finalImageUrls.length === 0) {
      await api.sendMessage(
        {
          msg: CONFIG.messages.noResults(senderName),
          quote: message,
          mentions: [MessageMention(senderId, senderName.length, 0)],
          ttl: 30000,
        },
        threadId,
        threadType
      );
      return;
    }

    const downloadedImages = await downloadMultipleImages(finalImageUrls, imageCount);
    await sendMultipleImages(api, message, downloadedImages, query);
  } catch (error) {
    console.error("Lỗi khi tìm kiếm ảnh Pinterest:", error?.message || error);
    await api.sendMessage(
      {
        msg: CONFIG.messages.apiError(senderName),
        quote: message,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      threadId,
      threadType
    );
  }
}
