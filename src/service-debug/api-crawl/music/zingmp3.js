import axios from "axios";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { MessageMention } from "../../../api-zalo/models/index.js";
import { getGlobalPrefix } from "../../service.js";
import { downloadAndConvertAudio, uploadAudioFile } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
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
import { downloadAudioWithYtDlp } from "../youtube/youtube-runtime.js";
import { searchSoundCloudTracks, resolveSoundCloudStreamUrl } from "./soundcloud.js";

const PLATFORM = "zingmp3";
const URL = "https://zingmp3.vn";
const DEFAULT_ZING_THUMB = "https://photo-zmp3.zmdcdn.me/cover/3/2/a/3/32a35f4d26ee5e366397c09998f6c269.jpg";
const MAX_CONCURRENT_SONG_INFO = 12;

let VERSION = "1.11.11";
const p = ["ctime", "id", "type", "page", "count", "version"];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../config.json");

let configApiKey = "";
let configSecretKey = "";

(() => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (config?.zingmp3) {
      configSecretKey = config.zingmp3.secretKey || "";
      configApiKey = config.zingmp3.apiKey || "";
      VERSION = config.zingmp3.version || VERSION;
    }
  } catch {}
})();

function getZingCredentials() {
  const apiKey = String(process.env.ZINGMP3_API_KEY || configApiKey || "").trim();
  const secretKey = String(process.env.ZINGMP3_SECRET_KEY || configSecretKey || "").trim();
  return { apiKey, secretKey, configured: Boolean(apiKey && secretKey) };
}

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

function getSig(pathUrl, params, secretKey) {
  const stringParams = getStringParams(params);
  return getHmac512(pathUrl + getHash256(stringParams), secretKey);
}

let cachedZingCookie = null;
let cachedZingCookieAt = 0;

async function getCookie() {
  const now = Date.now();
  if (cachedZingCookie && now - cachedZingCookieAt < 10 * 60 * 1000) {
    return cachedZingCookie;
  }
  const res = await axios.get(URL, { timeout: 10000 });
  if (res.headers["set-cookie"]) {
    cachedZingCookie = res.headers["set-cookie"][1] || res.headers["set-cookie"][0] || null;
    cachedZingCookieAt = now;
    return cachedZingCookie;
  }
  return null;
}

async function requestZingMp3(pathUrl, params = {}) {
  const cookie = await getCookie();
  const response = await axios.get(`${URL}${pathUrl}`, {
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
    },
    params,
    timeout: 10000,
  });
  return response.data;
}

export async function chartHomeZingMp3() {
  const { apiKey, secretKey, configured } = getZingCredentials();
  if (!configured) {
    const err = new Error("Chưa cấu hình ZINGMP3_API_KEY và ZINGMP3_SECRET_KEY");
    err.code = "MISSING_ZING_KEY";
    throw err;
  }
  const ctime = String(Math.floor(Date.now() / 1000));
  const pathChart = "/api/v2/page/get/chart-home";
  const params = {
    ctime,
    version: VERSION,
    apiKey,
  };
  return requestZingMp3(pathChart, {
    ...params,
    sig: getSig(pathChart, params, secretKey),
  });
}

export async function searchMusicZingMp3(keyword, numberMusic) {
  const { apiKey, secretKey, configured } = getZingCredentials();
  if (!configured) {
    const err = new Error("Chưa cấu hình ZINGMP3_API_KEY và ZINGMP3_SECRET_KEY");
    err.code = "MISSING_ZING_KEY";
    throw err;
  }
  const ctime = String(Math.floor(Date.now() / 1000));
  const pathSearch = "/api/v2/search";
  const params = {
    q: keyword,
    type: "song",
    count: Math.min(MAX_CONCURRENT_SONG_INFO, Number(numberMusic) || 10),
    allowCorrect: 1,
    ctime,
    version: VERSION,
    apiKey,
  };
  return requestZingMp3(pathSearch, {
    ...params,
    sig: getSig(pathSearch, params, secretKey),
  });
}

export async function getSong(songId) {
  const { apiKey, secretKey, configured } = getZingCredentials();
  if (!configured) {
    const err = new Error("Chưa cấu hình ZINGMP3_API_KEY và ZINGMP3_SECRET_KEY");
    err.code = "MISSING_ZING_KEY";
    throw err;
  }
  const ctime = String(Math.floor(Date.now() / 1000));
  const pathSong = "/api/v2/page/get/song";
  const params = {
    id: songId,
    ctime,
    version: VERSION,
    apiKey,
  };
  return requestZingMp3(pathSong, {
    ...params,
    sig: getSig(pathSong, params, secretKey),
  });
}

export async function getStreamingSong(songId) {
  const { apiKey, secretKey, configured } = getZingCredentials();
  if (!configured) {
    const err = new Error("Chưa cấu hình ZINGMP3_API_KEY và ZINGMP3_SECRET_KEY");
    err.code = "MISSING_ZING_KEY";
    throw err;
  }
  const ctime = String(Math.floor(Date.now() / 1000));
  const pathStreaming = "/api/v2/song/get/streaming";
  const params = {
    id: songId,
    ctime,
    version: VERSION,
    apiKey,
  };
  return requestZingMp3(pathStreaming, {
    ...params,
    sig: getSig(pathStreaming, params, secretKey),
  });
}

export async function getLyric(songId) {
  const { apiKey, secretKey, configured } = getZingCredentials();
  if (!configured) return { data: null };
  const ctime = String(Math.floor(Date.now() / 1000));
  const pathLyric = "/api/v2/lyric/get/lyric";
  const params = {
    id: songId,
    BGId: 0,
    ctime,
    version: VERSION,
    apiKey,
  };
  return requestZingMp3(pathLyric, {
    ...params,
    sig: getSig(pathLyric, params, secretKey),
  });
}

function extractZingMp3Url(keyword) {
  const urlPattern = /https?:\/\/zingmp3\.vn\/[^\s]+/i;
  const match = keyword.match(urlPattern);
  return match ? match[0] : null;
}

async function searchFallbackSongs(keyword, limit = 10) {
  try {
    const itunesRes = await axios.get("https://itunes.apple.com/search", {
      params: { term: keyword, entity: "song", country: "VN", limit },
      timeout: 9000,
    });
    const list = Array.isArray(itunesRes.data?.results) ? itunesRes.data.results : [];
    if (list.length > 0) {
      return list.slice(0, limit).map((item, idx) => ({
        encodeId: `zfb_it_${item.trackId || idx}`,
        title: item.trackName || "Bài hát",
        artistsNames: item.artistName || "Nghệ sĩ",
        thumbnailM: item.artworkUrl100
          ? String(item.artworkUrl100).replace("100x100bb", "600x600bb")
          : DEFAULT_ZING_THUMB,
        previewUrl: item.previewUrl || "",
        isFallbackTrack: true,
        streamingStatus: 1,
      }));
    }
  } catch {}

  try {
    const scTracks = await searchSoundCloudTracks(keyword, limit);
    if (scTracks.length > 0) {
      return scTracks.slice(0, limit).map((sc) => ({
        encodeId: `zfb_sc_${sc.id}`,
        title: sc.title,
        artistsNames: sc.artist,
        thumbnailM: sc.thumbnail || DEFAULT_ZING_THUMB,
        permalinkUrl: sc.permalink_url,
        listen: sc.playback_count || 0,
        like: sc.likes_count || 0,
        comment: sc.comment_count || 0,
        isFallbackTrack: true,
        streamingStatus: 1,
      }));
    }
  } catch {}

  return [];
}

async function fetchVietnamChartFallback(limit = 12) {
  try {
    const rssRes = await axios.get(
      `https://itunes.apple.com/vn/rss/topsongs/limit=${Math.min(15, limit)}/json`,
      { timeout: 9000 }
    );
    const entries = rssRes.data?.feed?.entry;
    const arr = Array.isArray(entries) ? entries : entries ? [entries] : [];
    if (arr.length > 0) {
      return arr.slice(0, limit).map((entry, idx) => {
        const imgs = Array.isArray(entry["im:image"]) ? entry["im:image"] : [];
        const rawImg = imgs[imgs.length - 1]?.label || DEFAULT_ZING_THUMB;
        const links = Array.isArray(entry.link) ? entry.link : [entry.link];
        const previewHref = links.find((l) => l?.attributes?.type?.includes("audio"))?.attributes?.href || "";
        return {
          encodeId: `zchart_vn_${entry.id?.attributes?.["im:id"] || idx}`,
          title: entry["im:name"]?.label || "Bài hát",
          artistsNames: entry["im:artist"]?.label || "Nghệ sĩ",
          thumbnailM: rawImg.replace(/\d+x\d+bb/, "600x600bb"),
          previewUrl: previewHref,
          rankChart: idx + 1,
          rank: idx + 1,
          score: Math.max(100 - idx * 3, 10),
          isFallbackTrack: true,
        };
      });
    }
  } catch {}
  return searchFallbackSongs("nhạc trẻ việt nam hot", limit);
}

async function resolveFallbackAudioUpload(track, api, message) {
  if (track.permalinkUrl) {
    const scStream = await resolveSoundCloudStreamUrl(track.permalinkUrl);
    if (scStream) {
      return downloadAndConvertAudio(scStream, api, message);
    }
  }

  let localAudioPath = null;
  try {
    localAudioPath = await downloadAudioWithYtDlp(
      `ytsearch1:${track.title} ${track.artistsNames || ""} official audio`
    );
    const uploaded = await uploadAudioFile(localAudioPath, api, message);
    if (uploaded) return uploaded;
  } catch {} finally {
    if (localAudioPath) await deleteFile(localAudioPath).catch(() => {});
  }

  try {
    const scTracks = await searchSoundCloudTracks(`${track.title} ${track.artistsNames || ""}`.trim(), 3);
    for (const sc of scTracks) {
      const streamUrl = await resolveSoundCloudStreamUrl(sc.permalink_url);
      if (streamUrl) {
        const uploaded = await downloadAndConvertAudio(streamUrl, api, message);
        if (uploaded) return uploaded;
      }
    }
  } catch {}

  if (track.previewUrl) {
    return downloadAndConvertAudio(track.previewUrl, api, message);
  }

  throw new Error(
    "Không tải được luồng phát cho bài hát này (cấu hình ZINGMP3_API_KEY + ZINGMP3_SECRET_KEY hoặc cài đặt yt-dlp)"
  );
}

async function processSongData(songId, songData) {
  const [songInfo, streamingInfo] = await Promise.all([
    songData ? { data: songData } : getSong(songId),
    getStreamingSong(songId),
  ]);

  if (songInfo?.err === -1023) {
    throw new Error(songInfo.msg);
  }

  if (!streamingInfo?.data) {
    throw new Error(streamingInfo?.msg || "Bài hát VIP hoặc không có luồng phát công khai");
  }

  let linkMusic = streamingInfo.data["320"];
  let quality = "320kbps";
  if (!linkMusic || String(linkMusic).toUpperCase().includes("VIP")) {
    linkMusic = streamingInfo.data["128"];
    quality = "128kbps";
  }

  if (!linkMusic || String(linkMusic).toUpperCase().includes("VIP")) {
    throw new Error("Bài hát yêu cầu tài khoản VIP trên ZingMP3");
  }

  return {
    songData: songInfo?.data || songData,
    linkMusic,
    quality,
  };
}

async function getChartRankInfo(encodeId) {
  try {
    const resultChart = await chartHomeZingMp3();
    const chartData = new Map();

    if (resultChart?.data?.RTChart?.items) {
      resultChart.data.RTChart.items.forEach((item, index) => {
        chartData.set(item.encodeId, {
          rank: index + 1,
          score: item.score,
        });
      });
    }
    return chartData.get(encodeId);
  } catch {
    return null;
  }
}

function safeZingThumb(songData, sizeToken = "w1200_") {
  const raw = songData?.thumbnailM || songData?.thumbnail || DEFAULT_ZING_THUMB;
  return String(raw).replace(/w\d+_/i, sizeToken);
}

async function prepareAndSendMusic(api, message, songData, linkMusic, quality, captionCustom) {
  const cacheQuality = quality || "128kbps";
  const cachedMusic = await getCachedMedia(PLATFORM, songData.encodeId, cacheQuality, songData.title);
  let voiceUrl;

  if (cachedMusic?.fileUrl) {
    voiceUrl = cachedMusic.fileUrl;
  } else {
    await sendMessageCompleteRequest(api, message, {
      caption: `Chờ bé lấy nhạc một chút, xong bé gọi cho hay.\n\n⏳ ${songData.title}`,
    }, 5000);

    if (linkMusic) {
      voiceUrl = await downloadAndConvertAudio(linkMusic, api, message, songData.encodeId);
    } else {
      voiceUrl = await resolveFallbackAudioUpload(songData, api, message);
    }

    await setCacheData(
      PLATFORM,
      songData.encodeId,
      {
        fileUrl: voiceUrl,
        title: songData.title,
        artist: songData.artistsNames,
      },
      cacheQuality
    );
  }

  const thumbnailUrl = safeZingThumb(songData, "w1200_");

  const stats = [
    songData.listen && `${songData.listen.toLocaleString()} 👂`,
    songData.like && `${songData.like.toLocaleString()} ❤️`,
    (songData.rankChart || songData.rank) && `🏆 Top ${songData.rankChart || songData.rank} BXH`,
  ].filter(Boolean);

  const objectMusic = {
    trackId: songData.encodeId,
    title: songData.title,
    artists: songData.artistsNames || "Nghệ sĩ",
    like: songData.like,
    listen: songData.listen,
    comment: songData.comment,
    source: "ZingMP3",
    caption: captionCustom || `> From ZingMP3 <\nNhạc Bạn Chọn Đây!!!`,
    imageUrl: thumbnailUrl,
    voiceUrl,
    stats,
    rank: songData.rankChart || songData.rank,
    score: songData.score || 0,
  };

  await sendVoiceMusic(api, message, objectMusic, 3600000);
}

export async function handleZingMp3Command(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  let imagePath = null;
  let registered = false;

  try {
    const prefix = getGlobalPrefix();
    const commandContent = extractCommandBody(message, prefix, aliasCommand || "zingmp3");
    const [rawKeyword, numberMusic] = commandContent.split("&&");
    const keyword = String(rawKeyword || "").trim();

    if (!keyword) {
      await sendMessageWarningRequest(api, message, {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Bài Hát Cần Tìm`,
      }, 30000);
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
        const hint =
          error?.code === "MISSING_ZING_KEY"
            ? "Chưa cấu hình ZINGMP3_API_KEY và ZINGMP3_SECRET_KEY trong .env.local để tải trực tiếp link ZingMP3. Bạn có thể tìm theo tên bài hát!"
            : `Link không hợp lệ hoặc thuộc thể loại album!\nNguyên nhân: ${error.message}`;
        await sendMessageWarningRequest(api, message, { caption: hint }, 30000);
      }
      return;
    }

    const boundedLimit = Math.min(MAX_CONCURRENT_SONG_INFO, Math.max(1, parseInt(numberMusic, 10) || 10));
    let songsWithInfo = [];

    if (getZingCredentials().configured) {
      try {
        const result = await searchMusicZingMp3(keyword, boundedLimit);
        const rawItems = Array.isArray(result?.data?.items) ? result.data.items.slice(0, boundedLimit) : [];
        if (rawItems.length > 0) {
          const chartData = new Map();
          try {
            const resultChart = await chartHomeZingMp3();
            resultChart?.data?.RTChart?.items?.forEach((item, index) => {
              chartData.set(item.encodeId, { rank: index + 1, score: item.score });
            });
          } catch {}

          songsWithInfo = await Promise.all(
            rawItems.map(async (song) => {
              try {
                const songInfo = await getSong(song.encodeId);
                const chartInfo = chartData.get(song.encodeId);
                return {
                  ...song,
                  ...(songInfo?.data || {}),
                  rank: chartInfo?.rank,
                };
              } catch {
                return song;
              }
            })
          );
        }
      } catch (err) {
        console.warn("ZingMP3 API search failed, using fallback:", err?.message || err);
      }
    }

    if (songsWithInfo.length === 0) {
      songsWithInfo = await searchFallbackSongs(keyword, boundedLimit);
    }

    if (songsWithInfo.length === 0) {
      const missingHint = !getZingCredentials().configured
        ? `\n(Gợi ý: Cấu hình ZINGMP3_API_KEY và ZINGMP3_SECRET_KEY trong .env.local để dùng API ZingMP3 gốc)`
        : "";
      await sendMessageWarningRequest(api, message, {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${keyword}${missingHint}`,
      }, 30000);
      return;
    }

    const musicListTxt =
      "Đây là danh sách bài hát trên ZingMP3 mà tôi tìm thấy:\n" +
      "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn nghe!\nVD: 1 hoặc 1 lyric";

    const formattedSongs = songsWithInfo.map((song) => ({
      title: song.title,
      artistsNames: song.artistsNames || "Nghệ sĩ",
      thumbnailM: safeZingThumb(song, "w600_"),
      listen: song.listen,
      like: song.like,
      rankChart: song.rank,
      comment: song.comment,
      isPremium: song.streamingStatus == 2,
    }));

    imagePath = await createSearchResultImage(formattedSongs);

    const musicListMessage = await sendMessageCompleteRequest(
      api,
      message,
      { caption: musicListTxt, imagePath },
      TIME_TO_SELECT
    );

    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

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
      resendPrompt: async () =>
        sendMessageCompleteRequest(api, message, { caption: musicListTxt, imagePath }, TIME_TO_SELECT),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTrackZingMp3(api, replyMessage, media, modifier);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error(`Không thể lấy stream URL cho track ${media?.encodeId}:`, error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption: `Không thể lấy bài này, vui lòng thử bài khác!\nNguyên nhân: ${error.message}`,
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
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleTopChartZingMp3(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();
  const commandContent = extractCommandBody(message, prefix, aliasCommand || "zingchart");
  const numberMusic = Math.min(15, Math.max(1, parseInt(commandContent, 10) || 10));
  let imagePath = null;
  let registered = false;

  try {
    let songsWithRank = [];

    if (getZingCredentials().configured) {
      try {
        const result = await chartHomeZingMp3();
        if (Array.isArray(result?.data?.RTChart?.items) && result.data.RTChart.items.length > 0) {
          const topSongs = result.data.RTChart.items.slice(0, numberMusic);
          songsWithRank = await Promise.all(
            topSongs.map(async (song, index) => {
              try {
                const songInfo = await getSong(song.encodeId);
                return {
                  ...song,
                  ...(songInfo?.data || {}),
                  rankChart: index + 1,
                  score: song.score,
                };
              } catch {
                return {
                  ...song,
                  rankChart: index + 1,
                  score: song.score,
                };
              }
            })
          );
        }
      } catch (err) {
        console.warn("ZingChart API failed, using Vietnam top chart fallback:", err?.message || err);
      }
    }

    if (songsWithRank.length === 0) {
      songsWithRank = await fetchVietnamChartFallback(numberMusic);
    }

    if (songsWithRank.length === 0) {
      await sendMessageWarningRequest(api, message, {
        caption:
          "Hiện chưa thể lấy BXH nhạc. Vui lòng cấu hình ZINGMP3_API_KEY + ZINGMP3_SECRET_KEY trong .env.local hoặc kiểm tra kết nối mạng.",
      }, 30000);
      return;
    }

    const musicListTxt =
      `[ TOP ${songsWithRank.length} Bài Hát Hot Nhất ]\n\n` +
      "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn nghe!\n\n";

    const formattedSongs = songsWithRank.map((song) => ({
      title: song.title,
      artistsNames: song.artistsNames || "Nghệ sĩ",
      thumbnailM: safeZingThumb(song, "w600_"),
      rankChart: song.rankChart,
      score: song.score,
    }));

    imagePath = await createSearchResultImage(formattedSongs);

    const musicListMessage = await sendMessageCompleteRequest(
      api,
      message,
      { caption: musicListTxt, imagePath },
      TIME_TO_SELECT
    );

    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

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
      resendPrompt: async () =>
        sendMessageCompleteRequest(api, message, { caption: musicListTxt, imagePath }, TIME_TO_SELECT),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTrackZingMp3(api, replyMessage, media, modifier);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error(`Không thể lấy stream URL cho track ${media?.encodeId}:`, error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption: `Không thể lấy bài này, vui lòng thử bài khác!\nNguyên nhân: ${error.message}`,
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
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleZingMp3Reply(api, message) {
  try {
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
  if (track.isFallbackTrack || !getZingCredentials().configured) {
    await prepareAndSendMusic(api, message, track, null, "HQ Audio");
    if (subCommand === "lyric") {
      await api.sendMessage(
        { msg: "Hiện chưa hỗ trợ lời bài hát khi chưa cấu hình ZINGMP3_API_KEY.", ttl: 30000 },
        message.threadId,
        message.type
      );
    }
    return true;
  }

  let linkMusic = null;
  let quality = "128kbps";
  try {
    const processed = await processSongData(track.encodeId, track);
    linkMusic = processed.linkMusic;
    quality = processed.quality;
  } catch {
    linkMusic = null;
    quality = "HQ Audio";
  }

  await prepareAndSendMusic(api, message, track, linkMusic, quality);

  if (subCommand === "lyric") {
    const lyric = await getLyric(track.encodeId).catch(() => null);
    if (lyric?.data?.sentences) {
      let formattedLyric = "Lời bài hát:\n\n";
      lyric.data.sentences.forEach((sentence) => {
        const line = sentence.words.map((word) => word.data).join(" ");
        if (line.trim()) {
          formattedLyric += line + "\n";
        }
      });
      await api.sendMessage({ msg: formattedLyric, ttl: 1800000 }, message.threadId, message.type);
    } else {
      await api.sendMessage(
        { msg: "Không tìm thấy lời cho bài hát này.", ttl: 30000 },
        message.threadId,
        message.type
      );
    }
  }
  return true;
}

export async function resolveRandomChartTrack() {
  const result = await chartHomeZingMp3();
  const items = result?.data?.RTChart?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  const pickWindow = Math.min(15, items.length);
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
  if (!linkMusic || String(linkMusic).toUpperCase().includes("VIP")) {
    linkMusic = streamingInfo.data["128"];
  }
  if (!linkMusic) return null;
  return { song: randomSong, linkMusic, randomIndex };
}

export async function deliverRandomChartTrack(api, message, track, caption, timeToLive = 1800000) {
  const { song: randomSong, linkMusic, randomIndex } = track;
  const thumbnailUrl = safeZingThumb(randomSong, "w1200_");
  const voiceUrl = await downloadAndConvertAudio(linkMusic, api, message, randomSong.encodeId);

  let captionFinal = caption || `[ Zing MP3 Chart ]\nChào buổi sáng!\n\n`;
  captionFinal += `🎵 Music: ${randomSong.title}\n👤 Artist: ${
    randomSong.artistsNames || "Nghệ sĩ"
  }\n#Top${randomIndex + 1}_ZingMP3\n\n`;
  captionFinal += `Cùng thưởng thức bài hát hiện tại đang hot thứ ${randomIndex + 1} trên nền tảng ZingMP3 nào!!!`;

  const stats = [
    randomSong.listen && `${randomSong.listen.toLocaleString()} 👂`,
    randomSong.like && `${randomSong.like.toLocaleString()} ❤️`,
    randomSong.rank && `🏆 Top ${randomSong.rank} BXH`,
  ].filter(Boolean);

  const object = {
    trackId: randomSong.encodeId,
    title: randomSong.title,
    artists: randomSong.artistsNames || "Nghệ sĩ",
    like: randomSong.like,
    listen: randomSong.listen,
    comment: randomSong.comment,
    source: "ZingMP3",
    caption: captionFinal,
    imageUrl: thumbnailUrl,
    voiceUrl,
    stats,
    rank: randomSong.rankChart || randomSong.rank,
    score: randomSong.score || 0,
  };

  await sendVoiceMusicNotQuote(api, message, object, timeToLive);
}

export async function handleRandomChartZingMp3(api, message, caption, timeToLive = 1800000) {
  const track = await resolveRandomChartTrack();
  if (!track) return false;
  await deliverRandomChartTrack(api, message, track, caption, timeToLive);
  return true;
}
