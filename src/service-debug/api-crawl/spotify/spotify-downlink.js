import axios from "axios";
import path from "path";
import CryptoJS from "crypto-js";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageProcessingRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { downloadFile, deleteFile } from "../../../utils/util.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import { capitalizeEachWord, removeMention } from "../../../utils/format-util.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { createSearchResultImage } from "./search-canvas.js";
import { tempDir } from "../../../utils/io-json.js";
import { MessageMention } from "../../../api-zalo/index.js";
import { downloadAndConvertAudio } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { canContinueReply } from "../../reply-access.js";
import { cleanupMediaFiles, createMediaJobDir, ensureMediaJobDir } from "../media/media-workflow.js";

const PLATFORM = "spotify";
const URL_SPOTIFY_SEARCH = "https://api.spotify.com/v1/search";
const TIME_WAIT_SELECTION = 120000;

const me = {
  J2DOWN_SECRET: process.env.SPOTIFY_DOWNLOADER_SECRET || "",
  API_URL: "https://api.zeidteam.xyz/media-downloader/atd2?url=",
};
const SPOTIFY_DOWNLOADER_PASSPHRASE = process.env.SPOTIFY_DOWNLOADER_PASSPHRASE || "";

function secretKey() {
  if (!me.J2DOWN_SECRET || !SPOTIFY_DOWNLOADER_PASSPHRASE) {
    throw new Error("Spotify downloader credentials are not configured.");
  }
  const decrypted = CryptoJS.AES.decrypt(me.J2DOWN_SECRET, SPOTIFY_DOWNLOADER_PASSPHRASE);
  return decrypted.toString(CryptoJS.enc.Utf8);
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function encryptData(data) {
  const keyHex = CryptoJS.enc.Hex.parse(secretKey());
  const iv = CryptoJS.lib.WordArray.random(16);
  const encrypted = CryptoJS.AES.encrypt(data, keyHex, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });
  return {
    iv: iv.toString(CryptoJS.enc.Hex),
    k: randomString(11) + "8QXBNv5pHbzFt5QC",
    r: "BRTsfMmf3CuN",
    encryptedData: encrypted.toString(),
  };
}

function sanitizeFilename(name) {
  if (!name) return `media_${Date.now()}_${randomString(8)}`;
  return name
    .replace(/[<>:"/\\|?*&%=#@!$'`~\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 100) || `media_${Date.now()}_${randomString(8)}`;
}

async function validateFile(filePath) {
  try {
    const stats = await fs.promises.stat(filePath);
    return stats.size > 0;
  } catch {
    return false;
  }
}

export async function getDataDownload(url) {
  let attempts = 0;
  const maxAttempts = 2;
  while (attempts < maxAttempts) {
    try {
      const response = await axios.get(`${me.API_URL}${encodeURIComponent(url)}`, {
        timeout: 20000, // Tăng timeout lên 20s
      });
      if (!response.data || !response.data.medias || response.data.medias.length === 0 || !response.data.medias[0].url) {
        throw new Error("API trả về dữ liệu không hợp lệ hoặc không có media.");
      }
      return response.data;
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        return { error: error.message || "Không thể kết nối đến API atd2." };
      }
    }
  }
}

let cachedSpotifyToken = null;
let cachedSpotifyTokenExpiry = 0;

async function getSpotifyAccessToken(clientId, clientSecret) {
  if (cachedSpotifyToken && Date.now() < cachedSpotifyTokenExpiry) {
    return cachedSpotifyToken;
  }
  const tokenRes = await axios.post(
    "https://accounts.spotify.com/api/token",
    "grant_type=client_credentials",
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      timeout: 10000,
    }
  );
  cachedSpotifyToken = tokenRes.data.access_token;
  const expiresInSec = Number(tokenRes.data.expires_in) || 3600;
  cachedSpotifyTokenExpiry = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
  return cachedSpotifyToken;
}

export async function searchSpotify(query) {
  try {
    const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
    const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

    if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_ID === "YOUR_SPOTIFY_CLIENT_ID_HERE") {
      throw new Error("Client ID hoặc Client Secret chưa được thiết lập.");
    }

    const accessToken = await getSpotifyAccessToken(CLIENT_ID, CLIENT_SECRET);

    // Tối ưu hóa query: ví dụ, tách tên bài hát và nghệ sĩ nếu có
    let optimizedQuery = query;
    const queryParts = query.split(" by ");
    if (queryParts.length > 1) {
      optimizedQuery = `track:${queryParts[0]} artist:${queryParts[1]}`;
    }

    const res = await axios.get("https://api.spotify.com/v1/search", {
      params: {
        q: optimizedQuery,
        type: "track",
        limit: 10, // Tăng limit để có thêm kết quả
      },
      headers: {
        "Authorization": `Bearer ${accessToken}`,
      },
      timeout: 10000,
    });

    const tracks = res.data.tracks.items;
    if (tracks && tracks.length > 0) {
      // Sắp xếp kết quả theo độ phổ biến hoặc mức độ khớp
      const sortedTracks = tracks.sort((a, b) => b.popularity - a.popularity);
      return sortedTracks.map(track => ({
        id: track.id,
        title: track.name || "Unknown Title",
        artist: track.artists.map(a => a.name).join(", ") || "Unknown Artist",
        thumbnail: track.album.images[0]?.url,
        url: track.external_urls.spotify,
        quality: "default",
        extension: "mp3",
        type: "audio",
        duration: track.duration_ms || 0,
        album: track.album.name || "Unknown Album", // Thêm thông tin album
      }));
    }

    return null;
  } catch (error) {
    console.error("Lỗi tìm kiếm Spotify:", error.message); // Thêm logging
    return null;
  }
}

export async function processAndSendSpotifyMedia(api, message, mediaData) {
  const {
    selectedMedia,
    mediaType,
    uniqueId,
    duration,
    title,
    author,
    senderId,
    senderName
  } = mediaData;

  const quality = selectedMedia.quality || "default";
  const typeFile = (selectedMedia.type || "audio").toLowerCase();

  if (typeFile !== "audio") {
    const processingMessage = {
      caption: "Spotify chỉ hỗ trợ tải nội dung âm thanh. Vui lòng thử lại với link âm thanh.",
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
    return;
  }

  if (!selectedMedia.url) {
    const processingMessage = {
      caption: `Lỗi: Không tìm thấy URL bài hát. Vui lòng thử lại.`,
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
    return;
  }

  if (duration > 3000000) {
    const processingMessage = {
      caption: `Bài hát "${title}" có thời lượng quá dài (>${duration/1000}s). Vui lòng chọn bài khác.`,
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
    return;
  }

  let voiceUrl;
  const validatedDuration = Math.floor(duration / 1000) || 1;

  const processingMessage = {
    caption: `Đang tải nhạc từ Spotify, chờ xíu nha!\n\n⏳ ${title}\n📊 Chất lượng: ${quality}`,
  };
  await sendMessageProcessingRequest(api, message, processingMessage, 8000);

  try {
    let attempts = 0;
    const maxAttempts = 2;
    while (attempts < maxAttempts) {
      try {
        voiceUrl = await downloadAndConvertAudio(selectedMedia.url, api, message, uniqueId);
        if (!voiceUrl) {
          throw new Error("Không thể tải hoặc chuyển đổi file âm thanh.");
        }
        break;
      } catch (error) {
        attempts++;
        if (attempts >= maxAttempts) {
          throw new Error(`Không thể tải hoặc chuyển đổi file âm thanh: ${error.message}`);
        }
      }
    }
  } catch (error) {
    const processingMessage = {
      caption: `Không tải được bài hát "${title}" từ Spotify: ${error.message}. Vui lòng thử lại sau hoặc kiểm tra link.`,
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
    return false;
  }

  const object = {
    trackId: uniqueId || "unknown",
    title: title || "Không rõ",
    artists: author || "Unknown Artist",
    source: capitalizeEachWord(mediaType) || "Spotify",
    caption: `> From Spotify <\nNhạc đây nè! 🎉\n\n🎵 Music: ${title}`,
    imageUrl: selectedMedia.thumbnail,
    voiceUrl: voiceUrl,
    duration: validatedDuration,
  };
  try {
    // Chỉ MỘT lần gửi cuối cùng: lỗi hậu-upload không tự gửi lại cùng file,
    // dispatcher sẽ mở lại bảng chọn thay thế.
    await sendVoiceMusic(api, message, object, 86400000);
    return true;
  } catch (error) {
    console.error("Lỗi khi gửi nhạc Spotify:", error?.message || error);
    return false;
  }
}

export async function handleSpotifyDownloadCommand(api, message, aliasCommand) {
  const content = removeMention(message);
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  try {
    const query = content.replace(`${prefix}${aliasCommand}`, "").trim();
    if (!query) {
      const processingMessage = {
        caption: `Vui lòng nhập link Spotify cần tải\nVí dụ:\n${prefix}${aliasCommand} <link>`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
      return;
    }

    if (!query.toLowerCase().includes("spotify.com")) {
      const processingMessage = {
        caption: `Link không phải từ Spotify. Vui lòng cung cấp link Spotify hợp lệ.`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
      return;
    }

    const downloadData = await getDataDownload(query);
    if (!downloadData || downloadData.error || !downloadData.medias || downloadData.medias.length === 0) {
      const processingMessage = {
        caption: `Link không hợp lệ hoặc không thể tải dữ liệu từ Spotify: ${downloadData?.error || "Lỗi không xác định"}. Vui lòng thử lại với link khác.`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
      return;
    }

    const uniqueId = sanitizeFilename(downloadData.title || downloadData.url || `spotify_${Date.now()}_${randomString(8)}`);
    const dataLink = downloadData.medias?.map((item) => ({
      url: item.url,
      quality: item.quality || "default",
      type: "audio",
      title: downloadData.title || "Unknown Title",
      thumbnail: item.thumbnail || downloadData.thumbnail,
      extension: item.extension || "mp3",
      duration: downloadData.duration || 0,
    })) || [];

    if (dataLink.length === 0) {
      const processingMessage = {
        caption: `Không tìm thấy dữ liệu tải về phù hợp cho link Spotify này! Vui lòng thử lại với link khác.`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
      return;
    }

    if (dataLink.length === 1) {
      await processAndSendSpotifyMedia(api, message, {
        selectedMedia: dataLink[0],
        mediaType: "spotify",
        uniqueId,
        duration: downloadData.duration || 0,
        title: downloadData.title || "Unknown Title",
        author: downloadData.author || "Unknown Artist",
        senderId,
        senderName,
      });
      return;
    }

    const processingMessage = {
      caption: `Vui lòng trả lời tin nhắn này với số thứ tự bài hát bạn muốn tải!`,
    };
    const listMessage = await sendMessageCompleteRequest(api, message, processingMessage, TIME_WAIT_SELECTION);
    const quotedMsgId = listMessage?.message?.msgId || listMessage?.attachment?.[0]?.msgId;
    if (!quotedMsgId) {
      const processingMessage = {
        caption: `Lỗi hệ thống: Không thể tạo danh sách bài hát. Vui lòng thử lại.`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
      return;
    }
    await setSelectionsMapData(senderId, {
      quotedMsgId: quotedMsgId.toString(),
      collection: dataLink,
      uniqueId,
      mediaType: "spotify",
      title: downloadData.title || "Unknown Title",
      duration: downloadData.duration || 0,
      author: downloadData.author || "Unknown Artist",
      timestamp: Date.now(),
      platform: "spotify",
      replyAccess: "public",
      threadId: message.threadId,
      api,
      sentMessage: listMessage,
      messageContext: message,
      type: message.type,
      seconds: 60,
      ownedTempPaths: [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: `Vui lòng trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn tải!`,
      }, TIME_WAIT_SELECTION),
      onSelect: async (media, index, modifier, replyMessage, claim) =>
        consumeSpotifyDownloadSelection(api, replyMessage, {
          recordOwner: senderId,
          media,
          uniqueId,
          fallbackTitle: downloadData.title || "Unknown Title",
          fallbackAuthor: downloadData.author || "Unknown Artist",
          fallbackDuration: downloadData.duration || 0,
          claim,
        }),
    });
  } catch (error) {
    const processingMessage = {
      caption: `Đã xảy ra lỗi khi xử lý lệnh tải Spotify: ${error.message}. Vui lòng thử lại sau hoặc kiểm tra link.`,
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
  }
}

async function consumeSpotifyDownloadSelection(api, message, options = {}) {
  const {
    media,
    claim,
    uniqueId,
    fallbackTitle,
    fallbackAuthor,
    fallbackDuration = 0,
  } = options;

  if (!media || !media.url || !media.title) {
    await sendMessageWarningRequest(api, message, {
      caption: `Lỗi hệ thống: Dữ liệu bài hát không hợp lệ. Vui long chon bai khac.`,
    }, 30000);
    return { ok: false, claimed: false };
  }

  const isSpotifyPageUrl = String(media.url).toLowerCase().includes("spotify.com");
  let resolvedMedia = media;
  let resolvedDuration = media.duration || fallbackDuration || 0;
  let resolvedTitle = fallbackTitle || media.title;
  let resolvedAuthor = fallbackAuthor || media.artist || "Unknown Artist";

  if (isSpotifyPageUrl) {
    const atd2Data = await getDataDownload(media.url);
    if (!atd2Data || atd2Data.error || !atd2Data.medias || atd2Data.medias.length === 0 || !atd2Data.medias[0].url) {
      await sendMessageWarningRequest(api, message, {
        caption: `Không thể tải bài hát từ link này: ${atd2Data?.error || "Lỗi không xác định"}. Vui lòng thử lại với bài khác.`,
      }, 30000);
      return { ok: false, claimed: false };
    }
    const atd2Media = atd2Data.medias[0];
    resolvedMedia = {
      ...media,
      url: atd2Media.url,
      quality: atd2Media.quality || media.quality,
      extension: atd2Media.extension || media.extension,
      thumbnail: atd2Media.thumbnail || media.thumbnail,
    };
    resolvedDuration = atd2Data.duration || resolvedDuration;
    resolvedTitle = atd2Data.title || resolvedTitle;
    resolvedAuthor = atd2Data.author || resolvedAuthor;
  }

  const claimed = typeof claim === "function" ? await claim() : true;
  if (!claimed) return { ok: false, claimed: false, handled: false };

  const sent = await processAndSendSpotifyMedia(api, message, {
    selectedMedia: resolvedMedia,
    mediaType: "spotify",
    uniqueId,
    duration: resolvedDuration,
    title: resolvedTitle,
    author: resolvedAuthor,
    senderId: message.data.uidFrom,
    senderName: message.data.dName,
  });
  return { ok: sent !== false, claimed: true };
}

export async function handleSpotifyDownloadReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== "spotify") return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    const processingMessage = {
      caption: `Đã xảy ra lỗi khi xử lý lựa chọn bài hát: ${error.message}. Vui lòng thử lại sau hoặc kiểm tra link.`,
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
    return true;
  }
}

export async function handleSpotifyCommand(api, message, command) {
  const content = removeMention(message);
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();
  let imagePath = null;

  try {
    const keyword = content.replace(`${prefix}${command}`, "").trim();

    if (!keyword) {
      const processingMessage = {
        caption: `Vui lòng nhập từ khóa tìm kiếm hoặc link Spotify\nVí dụ:\n${prefix}${command} tên bài hát hoặc ${prefix}${command} <link Spotify>`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
      return;
    }

    const extractSpotifyUrl = (text) => {
      const spotifyRegex = /https?:\/\/(?:open|play)\.spotify\.com\/[^\s]+/i;
      const match = text.match(spotifyRegex);
      return match ? match[0] : null;
    };

    const spotifyUrl = extractSpotifyUrl(keyword);
    if (spotifyUrl) {
      await handleSpotifyDownloadCommand(api, message, command);
      return;
    }

    const tracks = await searchSpotify(keyword);

    if (tracks && tracks.length > 0) {
      if (tracks.length === 1) {
        const modifiedMessage = {
          ...message,
          data: {
            ...message.data,
            content: `${prefix}${command} ${tracks[0].url}`,
          },
        };
        await handleSpotifyDownloadCommand(api, modifiedMessage, command);
        return;
      }

      imagePath = await createSearchResultImage(tracks.map(track => ({
        title: track.title || "No title",
        artistsNames: track.artist || "Unknown Artist",
        thumbnailM: track.thumbnail,
        listen: track.listen || 0,
        like: track.like || 0,
        comment: track.comment || 0,
      })));

      const processingMessage = {
        caption: `Vui lòng trả lời tin nhắn này với số thứ tự bài hát bạn muốn tải!`,
        imagePath: imagePath,
      };
      const listMessage = await sendMessageCompleteRequest(api, message, processingMessage, TIME_WAIT_SELECTION);
      const quotedMsgId = listMessage?.message?.msgId || listMessage?.attachment?.[0]?.msgId;
      if (!quotedMsgId) {
        const processingMessage = {
          caption: `Lỗi hệ thống: Không thể tạo danh sách bài hát. Vui lòng thử lại.`,
        };
        await sendMessageWarningRequest(api, message, processingMessage, 30000);
        return;
      }

      const ownedPaths = imagePath ? [imagePath] : [];
      imagePath = null;
      await setSelectionsMapData(senderId, {
        quotedMsgId: quotedMsgId.toString(),
        collection: tracks,
        timestamp: Date.now(),
        mediaType: "spotify",
        platform: PLATFORM,
        replyAccess: "public",
        threadId: message.threadId,
        api,
        sentMessage: listMessage,
        messageContext: message,
        type: message.type,
        seconds: 60,
        ownedTempPaths: ownedPaths,
        resendPrompt: async () => sendMessageCompleteRequest(api, message, {
          caption: `Vui lòng trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn tải!`,
          imagePath: ownedPaths[0],
        }, TIME_WAIT_SELECTION),
        onSelect: async (media, index, modifier, replyMessage, claim) =>
          consumeSpotifyDownloadSelection(api, replyMessage, {
            media,
            uniqueId: sanitizeFilename(media.title || `spotify_${Date.now()}_${randomString(8)}`),
            fallbackTitle: media.title || "Unknown Title",
            fallbackAuthor: media.artist || "Unknown Artist",
            fallbackDuration: media.duration || 0,
            claim,
          }),
      });
    } else {
      const processingMessage = {
        caption: `Không tìm được bài hát phù hợp trên Spotify. Hãy thử từ khóa khác hoặc kiểm tra Client ID/Secret.`,
      };
      await sendMessageWarningRequest(api, message, processingMessage, 30000);
    }
  } catch (error) {
    const processingMessage = {
      caption: `Đã xảy ra lỗi khi tìm kiếm bài hát Spotify: ${error.message}. Kiểm tra Client ID/Secret và thử lại.`,
    };
    await sendMessageWarningRequest(api, message, processingMessage, 30000);
  } finally {
    if (imagePath) await deleteFile(imagePath);
  }
}
