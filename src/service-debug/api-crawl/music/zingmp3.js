import axios from "axios";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { MessageMention } from "../../../api-zalo/models/index.js";
import { getGlobalPrefix } from "../../service.js";
import { downloadAndConvertAudio } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../../utils/format-util.js";
import { sendVoiceMusic, sendVoiceMusicNotQuote } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { createSearchResultImage } from "../../../utils/canvas/search-canvas.js";
import { deleteFile } from "../../../utils/util.js";
import { canContinueReply } from "../../reply-access.js";

// Author: ndqitvn
// Description: ZingMP3 API rebuild by Thanh Hung
let mp3FilePath, accFilePath, m4aFilePath;
const PLATFORM = "zingmp3";
const URL = "https://zingmp3.vn";
let API_KEY = process.env.ZINGMP3_API_KEY || "";
let SECRET_KEY = process.env.ZINGMP3_SECRET_KEY || "";

let VERSION = "1.11.11";
let CTIME = String(Math.floor(Date.now() / 1000));
const p = ["ctime", "id", "type", "page", "count", "version"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../config.json");

(async () => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (config?.zingmp3) {
      SECRET_KEY = process.env.ZINGMP3_SECRET_KEY || config.zingmp3.secretKey || "";
      API_KEY = process.env.ZINGMP3_API_KEY || config.zingmp3.apiKey || "";
      VERSION = config.zingmp3.version || VERSION;
    }
  } catch {}
})();

const TIME_TO_SELECT = 60000;

function getHash256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function getHmac512(str, key) {
  return crypto
    .createHmac("sha512", key)
    .update(Buffer.from(str, "utf8"))
    .digest("hex");
}

function sortParams(params) {
  const sorted = {};
  Object.keys(params)
    .sort()
    .forEach((key) => {
      sorted[key] = params[key];
    });
  return sorted;
}

function encodeParamsToString(params, separator = "") {
  const encode = encodeURIComponent;
  return Object.keys(params)
    .map((key) => {
      const value = encode(params[key]);
      return value.length > 5000 ? "" : `${encode(key)}=${value}`;
    })
    .filter((param) => param !== "")
    .join(separator);
}

function getStringParams(params) {
  const sortedParams = sortParams(params);
  const filteredParams = {};

  for (const key in sortedParams) {
    if (
      p.includes(key) &&
      params[key] !== null &&
      params[key] !== undefined &&
      params[key] !== ""
    ) {
      filteredParams[key] = sortedParams[key];
    }
  }

  return encodeParamsToString(filteredParams, "");
}

function getSig(path, params) {
  const stringParams = getStringParams(params);
  return getHmac512(path + getHash256(stringParams), SECRET_KEY);
}

let cachedZingCookie = null;
let cachedZingCookieAt = 0;

async function getCookie() {
  const now = Date.now();
  if (cachedZingCookie && now - cachedZingCookieAt < 10 * 60 * 1000) {
    return cachedZingCookie;
  }
  try {
    const res = await axios.get(URL, { timeout: 10000 });
    if (res.headers["set-cookie"]) {
      cachedZingCookie = res.headers["set-cookie"][1] || res.headers["set-cookie"][0] || null;
      cachedZingCookieAt = now;
      return cachedZingCookie;
    }
    return null;
  } catch (error) {
    console.error("Lỗi khi lấy cookie:", error.message || error);
    throw error;
  }
}

async function requestZingMp3(path, params = {}) {
  try {
    const cookie = await getCookie();
    const response = await axios.get(`${URL}${path}`, {
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
      },
      params,
      timeout: 10000,
    });
    return response.data;
  } catch (error) {
    console.error("Lỗi request Zing MP3:", error.message || error);
    throw error;
  }
}

export async function chartHomeZingMp3() {
  CTIME = String(Math.floor(Date.now() / 1000));
  const pathChart = "/api/v2/page/get/chart-home";
  const params = {
    ctime: CTIME,
    version: VERSION,
    apiKey: API_KEY,
  };
  return requestZingMp3(pathChart, {
    ...params,
    sig: getSig(pathChart, params),
  });
}

export async function searchMusicZingMp3(keyword, numberMusic) {
  CTIME = String(Math.floor(Date.now() / 1000));
  const pathSearch = "/api/v2/search";
  const params = {
    q: keyword,
    type: "song",
    count: numberMusic || 30,
    allowCorrect: 1,
    ctime: CTIME,
    version: VERSION,
    apiKey: API_KEY,
  };
  return requestZingMp3(pathSearch, {
    ...params,
    sig: getSig(pathSearch, params),
  });
}

export async function getSong(songId) {
  CTIME = String(Math.floor(Date.now() / 1000));
  const pathSong = "/api/v2/page/get/song";
  const params = {
    id: songId,
    ctime: CTIME,
    version: VERSION,
    apiKey: API_KEY,
  };
  return requestZingMp3(pathSong, {
    ...params,
    sig: getSig(pathSong, params),
  });
}

export async function getStreamingSong(songId) {
  CTIME = String(Math.floor(Date.now() / 1000));
  const pathStreaming = "/api/v2/song/get/streaming";
  const params = {
    id: songId,
    ctime: CTIME,
    version: VERSION,
    apiKey: API_KEY,
  };
  return requestZingMp3(pathStreaming, {
    ...params,
    sig: getSig(pathStreaming, params),
  });
}

export async function getLyric(songId) {
  CTIME = String(Math.floor(Date.now() / 1000));
  const pathLyric = "/api/v2/lyric/get/lyric";
  const params = {
    id: songId,
    BGId: 0,
    ctime: CTIME,
    version: VERSION,
    apiKey: API_KEY,
  };
  return requestZingMp3(pathLyric, {
    ...params,
    sig: getSig(pathLyric, params),
  });
}

function extractZingMp3Url(keyword) {
  const urlPattern = /https?:\/\/zingmp3\.vn\/[^\s]+/;
  const match = keyword.match(urlPattern);
  return match ? match[0] : null;
}

async function processSongData(songId, songData) {
  const [songInfo, streamingInfo] = await Promise.all([
    songData ? songData : getSong(songId),
    getStreamingSong(songId)
  ]);

  if (songInfo.err === -1023) {
    throw new Error(songInfo.msg);
  }

  if (!streamingInfo.data) {
    throw new Error(streamingInfo.msg);
  }

  let linkMusic = streamingInfo.data["320"];
  let quality = "320kbps";
  if (!linkMusic || linkMusic.toUpperCase().includes("VIP")) {
    linkMusic = streamingInfo.data["128"];
    quality = "128kbps";
  }

  return {
    songData: songInfo.data,
    linkMusic,
    quality
  };
}

async function getChartRankInfo(encodeId) {
  try {
    const resultChart = await chartHomeZingMp3();
    let chartData = new Map();

    if (resultChart?.data?.RTChart?.items) {
      resultChart.data.RTChart.items.forEach((item, index) => {
        chartData.set(item.encodeId, {
          rank: index + 1,
          score: item.score
        });
      });
    }
    return chartData.get(encodeId);
  } catch (error) {
    console.error("Lỗi lấy thông tin chart:", error);
    return null;
  }
}

async function prepareAndSendMusic(api, message, songData, linkMusic, quality, captionCustom) {
  const cachedMusic = await getCachedMedia(PLATFORM, songData.encodeId, quality, songData.title);
  let voiceUrl;

  if (cachedMusic) {
    voiceUrl = cachedMusic.fileUrl;
  } else {
    const object = {
      caption: `Chờ bé lấy nhạc một chút, xong bé gọi cho hay.\n\n⏳ ${songData.title}`,
    };
    await sendMessageCompleteRequest(api, message, object, 5000);
    voiceUrl = await downloadAndConvertAudio(linkMusic, api, message, songData.encodeId);
    await setCacheData(PLATFORM, songData.encodeId, {
      fileUrl: voiceUrl,
      title: songData.title,
      artist: songData.artistsNames
    }, quality);
    
  }

  const thumbnailUrl = songData.thumbnailM.replace(/w\d+_/i, 'w1200_');

  const stats = [
    songData.listen && `${songData.listen.toLocaleString()} 👂`,
    songData.like && `${songData.like.toLocaleString()} ❤️`,
    songData.rank && `🏆 Top ${songData.rank} BXH`
  ].filter(Boolean);

  const objectMusic = {
    trackId: songData.encodeId,
    title: songData.title,
    artists: songData.artistsNames,
    like: songData.like,
    listen: songData.listen,
    comment: songData.comment,
    source: "ZingMP3",
    caption: captionCustom || `> From ZingMP3 <\nNhạc Bạn Chọn Đây!!!`,
    imageUrl: thumbnailUrl,
    voiceUrl: voiceUrl,
    stats: stats,
    rank: songData.rankChart || songData.rank,
    score: songData.score || 0,
  };

  await sendVoiceMusic(api, message, objectMusic, 3600000);
  mp3FilePath = path.resolve(process.cwd(), 'assets', 'temp', `${songData.encodeId}.mp3`)
    accFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${songData.encodeId}.acc`)
    m4aFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${songData.encodeId}.m4a`)
    // if (fs.existsSync(mp3FilePath)) await fs.promises.unlink(mp3FilePath);
    if (fs.existsSync(accFilePath)) void deleteFile(accFilePath);
    if (fs.existsSync(m4aFilePath)) void deleteFile(m4aFilePath);
    if (fs.existsSync(mp3FilePath)) void deleteFile(mp3FilePath);
}

export async function handleZingMp3Command(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  let imagePath = null;
  let registered = false;

  try {
    const content = removeMention(message);
    const prefix = getGlobalPrefix();
    const commandContent = content.replace(`${prefix}${aliasCommand}`, "").trim();
    const [keyword, numberMusic] = commandContent.split("&&");

    if (!keyword) {
      const object = {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Bài Hát Cần Tìm`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const url = extractZingMp3Url(keyword);
    if (url) {
      const encodeId = url.split("/").pop().split(".")[0];
      try {
        const { songData, linkMusic, quality } = await processSongData(encodeId);

        const chartInfo = await getChartRankInfo(encodeId);

        if (chartInfo) {
          songData.rank = chartInfo.rank;
          songData.score = chartInfo.score;
        }

        await prepareAndSendMusic(api, message, songData, linkMusic, quality);
      } catch (error) {
        const object = {
          caption: `Link Không hợp lệ hoặc link thuộc thể loại album!`
            + `\nNguyên Nhân: ${error.message}`,
        };
        await sendMessageWarningRequest(api, message, object, 30000);
      }
      return;
    }

    const boundedLimit = Math.min(30, Math.max(1, parseInt(numberMusic, 10) || 10));
    const result = await searchMusicZingMp3(keyword, boundedLimit);
    if (!result.data || !result.data.items || result.data.items.length === 0) {
      const object = {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${keyword}`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const songs = result.data.items.slice(0, boundedLimit);
    const resultChart = await chartHomeZingMp3();
    let chartData = new Map();

    if (resultChart?.data?.RTChart?.items) {
      resultChart.data.RTChart.items.forEach((item, index) => {
        chartData.set(item.encodeId, {
          rank: index + 1,
          score: item.score
        });
      });
    }

    const songsWithInfo = await Promise.all(
      songs.map(async (song) => {
        const songInfo = await getSong(song.encodeId);
        const chartInfo = chartData.get(song.encodeId);
        return {
          ...song,
          ...songInfo.data,
          rank: chartInfo?.rank
        };
      })
    );

    let musicListTxt = "Đây là danh sách bài hát trên ZingMP3 mà tôi tìm thấy:\n";
    musicListTxt +=
      "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số index của bài hát bạn muốn nghe!\nVD: 1 hoặc 1 lyric";

    const formattedSongs = songsWithInfo.map(song => ({
      title: song.title,
      artistsNames: song.artistsNames,
      thumbnailM: song.thumbnailM,
      listen: song.listen,
      like: song.like,
      rankChart: song.rank,
      comment: song.comment,
      isPremium: song.streamingStatus == 2
    }));

    imagePath = await createSearchResultImage(formattedSongs);

    const object = {
      caption: musicListTxt,
      imagePath: imagePath,
    };
    const musicListMessage = await sendMessageCompleteRequest(
      api,
      message,
      object,
      TIME_TO_SELECT
    );

    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

    // Preview temp thuộc sở hữu session; chỉ xóa đúng một lần khi kết thúc.
    await setSelectionsMapData(senderId, {
      quotedMsgId: (quotedMsgId || "").toString(),
      collection: songsWithInfo,
      timestamp: Date.now(),
      platform: PLATFORM,
      replyAccess: "public",
      threadId: message.threadId,
      api,
      sentMessage: musicListMessage,
      messageContext: message,
      type: message.type,
      seconds: 60,
      ownedTempPaths: imagePath ? [imagePath] : [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: musicListTxt,
        imagePath: imagePath,
      }, TIME_TO_SELECT),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTrackZingMp3(api, replyMessage, media, modifier);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error(`Không thể lấy stream URL cho track ${media?.encodeId}:`, error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption:
              `Không thể lấy bài này, vui lòng thử bài khác!\n` +
              `Nguyên Nhân: ${error.message}`,
          }, 30000);
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;
  } catch (error) {
    console.error("Lỗi xử lý lệnh ZingMP3:", error);
    await api.sendMessage(
      {
        msg: `${senderName} Đã xảy ra lỗi khi xử lý lệnh của bạn. Vui lòng thử lại sau.`,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
  } finally {
    if (imagePath && !registered) deleteFile(imagePath);
  }
}

export async function handleTopChartZingMp3(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();
  const commandContent = removeMention(message)
    .replace(`${prefix}${aliasCommand}`, "")
    .trim();
  let numberMusic = Math.min(30, Math.max(1, parseInt(commandContent, 10) || 10));
  let imagePath = null;
  let registered = false;

  try {
    const result = await chartHomeZingMp3();
    if (!result.data || !result.data.RTChart || !result.data.RTChart.items) {
      throw new Error("Không thể lấy được danh sách bài hát từ ZingMP3");
    }

    const top20Songs = result.data.RTChart.items.slice(0, numberMusic);
    const songsWithRank = await Promise.all(top20Songs.map(async (song, index) => {
      const songInfo = await getSong(song.encodeId);
      return {
        ...song,
        ...songInfo.data,
        rankChart: index + 1,
        score: song.score
      };
    }));

    let musicListTxt = `[ TOP ${numberMusic} Bài Hát Hot Nhất ZingMP3 ]\n\n`;
    musicListTxt += "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn nghe!\n\n";

    const formattedSongs = songsWithRank.map(song => ({
      title: song.title,
      artistsNames: song.artistsNames,
      thumbnailM: song.thumbnailM.replace(/w\d+_/i, 'w600_'),
      rankChart: song.rankChart,
      score: song.score
    }));

    imagePath = await createSearchResultImage(formattedSongs);

    const object = {
      caption: musicListTxt,
      imagePath: imagePath,
    };

    const musicListMessage = await sendMessageCompleteRequest(
      api,
      message,
      object,
      TIME_TO_SELECT
    );

    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

    // Preview temp thuộc sở hữu session; chỉ xóa đúng một lần khi kết thúc.
    await setSelectionsMapData(senderId, {
      quotedMsgId: (quotedMsgId || "").toString(),
      collection: songsWithRank,
      timestamp: Date.now(),
      platform: PLATFORM,
      replyAccess: "public",
      threadId: message.threadId,
      api,
      sentMessage: musicListMessage,
      messageContext: message,
      type: message.type,
      seconds: 60,
      ownedTempPaths: imagePath ? [imagePath] : [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: musicListTxt,
        imagePath: imagePath,
      }, TIME_TO_SELECT),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTrackZingMp3(api, replyMessage, media, modifier);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error(`Không thể lấy stream URL cho track ${media?.encodeId}:`, error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption:
              `Không thể lấy bài này, vui lòng thử bài khác!\n` +
              `Nguyên Nhân: ${error.message}`,
          }, 30000);
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;

  } catch (error) {
    console.error("Lỗi xử lý chart ZingMP3:", error);
    await api.sendMessage(
      {
        msg: `${senderName} Đã xảy ra lỗi khi lấy danh sách bài hát. Vui lòng thử lại sau.`,
        mentions: [MessageMention(senderId, senderName.length, 0)],
        ttl: 30000,
      },
      message.threadId,
      message.type
    );
  } finally {
    if (imagePath && !registered) deleteFile(imagePath);
  }
}

export async function handleZingMp3Reply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    if (!message.data.quote || !message.data.quote.globalMsgId) return false;
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Lỗi xử lý reply ZingMP3:", error);
    await sendMessageWarningRequest(api, message, {
      caption: "Đã xảy ra lỗi khi xử lý tin nhắn của bạn.",
    }, 30000);
    return true;
  }
}

export async function handleSendTrackZingMp3(api, message, track, subCommand) {
  const { linkMusic, quality } = await processSongData(track.encodeId, track);
  await prepareAndSendMusic(api, message, track, linkMusic, quality);

  const lyric = subCommand === "lyric" ? await getLyric(track.encodeId) : null;
  if (subCommand) {
    switch (subCommand) {
      case "lyric":
        if (lyric.data && lyric.data.sentences) {
          let formattedLyric = "Lời bài hát:\n\n";
          lyric.data.sentences.forEach((sentence) => {
            const line = sentence.words.map((word) => word.data).join(" ");
            if (line.trim()) {
              formattedLyric += line + "\n";
            }
          });
          await api.sendMessage(
            { msg: formattedLyric, ttl: 1800000 },
            message.threadId,
            message.type
          );
        } else {
          await api.sendMessage(
            {
              msg: "Không tìm thấy lời cho bài hát này.",
              ttl: 30000,
            },
            message.threadId,
            message.type
          );
        }
        break;
    }
  }
  return true;
}

/**
 * Giai đoạn NGUỒN: lấy chart, enrich thông tin và chọn ngẫu nhiên một bài có stream.
 * - Throw khi provider lỗi (network/API) → scheduler phân loại là source-error.
 * - Trả null khi không có bài hoặc không có stream dùng được → source-empty.
 * Không bao giờ tự nuốt lỗi: scheduler cần biết nguồn thật sự hỏng để chạy fallback.
 */
export async function resolveRandomChartTrack() {
  const result = await chartHomeZingMp3();
  const items = result?.data?.RTChart?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  const pickWindow = Math.min(20, items.length);
  const randomIndex = Math.floor(Math.random() * pickWindow);
  const baseSong = items[randomIndex];
  if (!baseSong?.encodeId) return null;
  const [songInfo, streamingInfo] = await Promise.all([
    getSong(baseSong.encodeId),
    getStreamingSong(baseSong.encodeId),
  ]);
  const randomSong = {
    ...baseSong,
    ...(songInfo?.data || {}),
    rankChart: randomIndex + 1,
    score: baseSong.score,
  };
  if (!streamingInfo?.data) {
    return null;
  }
  let linkMusic = streamingInfo.data["320"];
  if (!linkMusic || linkMusic.toUpperCase().includes("VIP")) {
    linkMusic = streamingInfo.data["128"];
  }
  if (!linkMusic) return null;
  return { song: randomSong, linkMusic, randomIndex };
}

/**
 * Giai đoạn GỬI: tải và phát một track đã resolve.
 * Mọi lỗi ở đây là lỗi gửi Zalo/không xác định → scheduler KHÔNG được fallback
 * để tránh gửi trùng; chỉ được retry theo chính sách hiện có.
 */
export async function deliverRandomChartTrack(api, message, track, caption, timeToLive = 1800000) {
  const { song: randomSong, linkMusic, randomIndex } = track;
  const thumbnailUrl = randomSong.thumbnailM.replace(/w\d+_/i, 'w1200_');
  const voiceUrl = await downloadAndConvertAudio(linkMusic, api, message, randomSong.encodeId);

  let captionFinal = caption || `[ Zing MP3 Chart ]\nChào buổi sáng!\n\n`;
  captionFinal += `🎵 Music: ${randomSong.title}\n👤 Artist: ${randomSong.artistsNames
    }\n#Top${randomIndex + 1}_ZingMP3\n\n`;
  captionFinal += `Cùng thưởng thức bài hát hiện tại đang hot thứ ${randomIndex + 1
    } trên nền tảng ZingMP3 nào!!!`;

  const stats = [
    randomSong.listen && `${randomSong.listen.toLocaleString()} 👂`,
    randomSong.like && `${randomSong.like.toLocaleString()} ❤️`,
    randomSong.rank && `🏆 Top ${randomSong.rank} BXH`
  ].filter(Boolean);

  const object = {
    trackId: randomSong.encodeId,
    title: randomSong.title,
    artists: randomSong.artistsNames,
    like: randomSong.like,
    listen: randomSong.listen,
    comment: randomSong.comment,
    source: "ZingMP3",
    caption: captionFinal,
    imageUrl: thumbnailUrl,
    voiceUrl: voiceUrl,
    stats: stats,
    rank: randomSong.rankChart || randomSong.rank,
    score: randomSong.score || 0,
  };

  await sendVoiceMusicNotQuote(api, message, object, timeToLive);
  mp3FilePath = path.resolve(process.cwd(), 'assets', 'temp', `${randomSong.encodeId}.mp3`)
  accFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${randomSong.encodeId}.acc`)
  m4aFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${randomSong.encodeId}.m4a`)
  // if (fs.existsSync(mp3FilePath)) await fs.promises.unlink(mp3FilePath);
  if (fs.existsSync(accFilePath)) void deleteFile(accFilePath);
  if (fs.existsSync(m4aFilePath)) void deleteFile(m4aFilePath);
  if (fs.existsSync(mp3FilePath)) void deleteFile(mp3FilePath);
}

/**
 * Gửi một bài ngẫu nhiên từ chart Zing.
 * Chỉ trả `true` sau khi media đã gửi thật; lỗi nguồn nổi lên trên để scheduler
 * xử lý (fallback), không còn nuốt lỗi rồi báo thành công như trước.
 */
export async function handleRandomChartZingMp3(
  api,
  message,
  caption,
  timeToLive = 1800000
) {
  const track = await resolveRandomChartTrack();
  if (!track) return false;
  await deliverRandomChartTrack(api, message, track, caption, timeToLive);
  return true;
}

