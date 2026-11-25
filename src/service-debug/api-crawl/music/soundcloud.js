import axios from "axios";
import fs from "fs";
import path from "path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageFromSQL,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { downloadAudio, uploadAudioFile } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { deleteFile } from "../../../utils/util.js";
import { createSearchResultImage } from "../../../utils/canvas/search-canvas.js";
import { isAdmin } from "../../../index.js";
import { canContinueReply } from "../../reply-access.js";
import { tempDir } from "../../../utils/io-json.js";
import { getFfmpegExecutableSync } from "../../../utils/runtime-dependencies.js";
import { downloadAudioWithYtDlp } from "../youtube/youtube-runtime.js";

const execFileAsync = promisify(execFile);

let clientId = "";
let clientIdUpdatedAt = 0;

const PLATFORM = "soundcloud";
const DEFAULT_SOUNDCLOUD_ARTWORK = "https://a-v2.sndcdn.com/assets/images/sc-icons/ios-a62dfc8fe7.png";
const CLIENT_ID_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const TIME_TO_SELECT = 60000;

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
];

const acceptLanguages = ["en-US,en;q=0.9", "vi-VN,vi;q=0.9", "fr-FR,fr;q=0.9"];

const getRandomElement = (array) => array[Math.floor(Math.random() * array.length)];

const getHeaders = () => ({
  "User-Agent": getRandomElement(userAgents),
  "Accept-Language": getRandomElement(acceptLanguages),
  Referer: "https://soundcloud.com/",
  "Upgrade-Insecure-Requests": "1",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
});

export const getClientId = async (forceRefresh = false) => {
  if (process.env.SOUNDCLOUD_CLIENT_ID) return process.env.SOUNDCLOUD_CLIENT_ID;
  const now = Date.now();
  if (!forceRefresh && clientId && now - clientIdUpdatedAt < CLIENT_ID_CACHE_TTL_MS) {
    return clientId;
  }

  try {
    const response = await axios.get("https://soundcloud.com/", {
      headers: getHeaders(),
      timeout: 10000,
    });

    const dom = new JSDOM(response.data);
    const scriptTags = Array.from(dom.window.document.querySelectorAll("script[crossorigin]"));
    const urls = scriptTags.map((tag) => tag.src).filter((src) => src && src.startsWith("https"));

    if (!urls.length) {
      throw new Error("Không tìm thấy URL script SoundCloud");
    }

    for (let i = urls.length - 1; i >= Math.max(0, urls.length - 4); i--) {
      const scriptResponse = await axios.get(urls[i], {
        headers: getHeaders(),
        timeout: 10000,
      });
      const extracted =
        scriptResponse.data.split(',client_id:"')[1]?.split('"')[0] ||
        scriptResponse.data.match(/client_id\s*:\s*"([A-Za-z0-9]{20,40})"/)?.[1];
      if (extracted) {
        clientId = extracted;
        clientIdUpdatedAt = now;
        return extracted;
      }
    }
    throw new Error("Không thể trích xuất client_id từ script");
  } catch (error) {
    console.error(`Không thể lấy SoundCloud client ID: ${error.message || error}`);
    return process.env.SOUNDCLOUD_CLIENT_ID || clientId || "";
  }
};

async function getMusicInfo(question, limit, retried = false) {
  limit = Math.min(20, Math.max(1, parseInt(limit, 10) || 10));
  if (!clientId) clientId = await getClientId();
  if (!clientId) return null;

  try {
    const response = await axios.get("https://api-v2.soundcloud.com/search/tracks", {
      timeout: 10000,
      params: {
        q: question,
        variant_ids: "",
        facet: "genre",
        client_id: clientId,
        limit,
        offset: 0,
        linked_partitioning: 1,
        app_locale: "en",
      },
    });
    return response.data;
  } catch (error) {
    if (!retried && (error?.response?.status === 401 || error?.response?.status === 403)) {
      clientId = await getClientId(true);
      if (clientId) return getMusicInfo(question, limit, true);
    }
    console.error("Error fetching SoundCloud music info:", error.message || error);
    return null;
  }
}

export async function searchSoundCloudTracks(query, limit = 8) {
  const info = await getMusicInfo(query, limit);
  const collection = Array.isArray(info?.collection) ? info.collection : [];
  return collection.map((track) => ({
    id: String(track.id),
    title: track.title || "Unknown Title",
    artist: track.user?.username || "Unknown Artist",
    thumbnail:
      track.artwork_url?.replace("-large", "-t500x500") ||
      track.user?.avatar_url?.replace("-large", "-t500x500") ||
      DEFAULT_SOUNDCLOUD_ARTWORK,
    permalink_url: track.permalink_url,
    url: track.permalink_url,
    duration: track.duration || 0,
    playback_count: track.playback_count || 0,
    likes_count: track.likes_count || 0,
    comment_count: track.comment_count || 0,
  }));
}

export async function resolveSoundCloudStreamInfo(link, retried = false) {
  if (!clientId) clientId = await getClientId();
  if (!clientId) return null;

  try {
    const headers = getHeaders();
    const apiUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(link)}&client_id=${clientId}`;
    const response = await axios.get(apiUrl, { headers, timeout: 10000 });
    const data = response.data;
    const transcodings = Array.isArray(data?.media?.transcodings) ? data.media.transcodings : [];

    const progressive = transcodings.find((t) => t?.format?.protocol === "progressive");
    if (progressive?.url) {
      const streamResponse = await axios.get(
        `${progressive.url}?client_id=${clientId}&track_authorization=${data.track_authorization}`,
        { headers, timeout: 10000 }
      );
      if (streamResponse.data?.url) {
        return { url: streamResponse.data.url, protocol: "progressive" };
      }
    }

    const hls = transcodings.find((t) => t?.format?.protocol === "hls");
    if (hls?.url) {
      const hlsResponse = await axios.get(
        `${hls.url}?client_id=${clientId}&track_authorization=${data.track_authorization}`,
        { headers, timeout: 10000 }
      );
      if (hlsResponse.data?.url) {
        return { url: hlsResponse.data.url, protocol: "hls" };
      }
    }

    return null;
  } catch (error) {
    if (!retried && (error?.response?.status === 401 || error?.response?.status === 403)) {
      clientId = await getClientId(true);
      if (clientId) return resolveSoundCloudStreamInfo(link, true);
    }
    console.error("Error getting SoundCloud stream URL:", error.message || error);
    return null;
  }
}

export async function resolveSoundCloudStreamUrl(link) {
  const info = await resolveSoundCloudStreamInfo(link);
  return info?.protocol === "progressive" ? info.url : null;
}

async function downloadAndUploadSoundCloudTrack(track, api, message) {
  const permalink = track.permalink_url || track.url;
  const streamInfo = permalink ? await resolveSoundCloudStreamInfo(permalink) : null;

  if (streamInfo?.protocol === "progressive" && streamInfo.url) {
    return downloadAudio(streamInfo.url, api, message);
  }

  let localAudioPath = null;
  try {
    if (streamInfo?.protocol === "hls" && streamInfo.url) {
      const ffmpegBin = getFfmpegExecutableSync();
      if (ffmpegBin && fs.existsSync(ffmpegBin)) {
        await fs.promises.mkdir(tempDir, { recursive: true });
        localAudioPath = path.join(tempDir, `sc_hls_${randomUUID()}.m4a`);
        await execFileAsync(
          ffmpegBin,
          ["-y", "-i", streamInfo.url, "-vn", "-c:a", "aac", "-b:a", "128k", localAudioPath],
          { timeout: 60000, windowsHide: true }
        );
        return await uploadAudioFile(localAudioPath, api, message);
      }
    }

    const target = permalink || `ytsearch1:${track.title} ${track.user?.username || track.artist || ""} audio`;
    localAudioPath = await downloadAudioWithYtDlp(target);
    return await uploadAudioFile(localAudioPath, api, message);
  } finally {
    if (localAudioPath) {
      await deleteFile(localAudioPath).catch(() => {});
    }
  }
}

export async function handleMusicCommand(api, message, aliasCommand) {
  let imagePath = null;
  let registered = false;
  try {
    if (!clientId) clientId = await getClientId();
    const senderId = message.data.uidFrom;
    const prefix = getGlobalPrefix();
    const commandContent = extractCommandBody(message, prefix, aliasCommand || "soundcloud");
    const [rawQuestion, numberMusic] = commandContent.split("&&");
    const question = String(rawQuestion || "").trim();

    if (!question) {
      const object = {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Bài Hát Cần Tìm`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const musicInfo = await getMusicInfo(question, parseInt(numberMusic, 10));
    if (!musicInfo || !Array.isArray(musicInfo.collection) || musicInfo.collection.length === 0) {
      const object = {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${question}`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    let musicListTxt = "Đây là danh sách bài hát trên SoundCloud mà tôi tìm thấy:\n";
    musicListTxt += "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn nghe!";

    const songs = musicInfo.collection.map((track) => ({
      title: track.title,
      artistsNames: track.user?.username || "Unknown Artist",
      thumbnailM:
        track.artwork_url?.replace("-large", "-t500x500") ||
        track.user?.avatar_url?.replace("-large", "-t500x500") ||
        DEFAULT_SOUNDCLOUD_ARTWORK,
      listen: track.playback_count,
      like: track.likes_count,
      comment: track.comment_count,
    }));

    imagePath = await createSearchResultImage(songs);

    const object = {
      caption: musicListTxt,
      imagePath,
    };
    const musicListMessage = await sendMessageCompleteRequest(api, message, object, TIME_TO_SELECT);
    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

    await setSelectionsMapData(senderId, {
      quotedMsgId: (quotedMsgId || "").toString(),
      collection: musicInfo.collection,
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
        sendMessageCompleteRequest(
          api,
          message,
          {
            caption: musicListTxt,
            imagePath,
          },
          TIME_TO_SELECT
        ),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        if (!isAdmin(senderId) && media.duration > 1800000) {
          await sendMessageWarningRequest(
            api,
            replyMessage,
            {
              caption: `Thời lượng nhạc vượt quá giới hạn cho phép (30 phút), vui lòng chọn bài khác.`,
            },
            30000
          );
          return { ok: false, claimed: false };
        }
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTrackSoundCloud(api, replyMessage, media);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error("Error handling soundcloud selection:", error);
          await sendMessageWarningRequest(
            api,
            replyMessage,
            {
              caption: `Đã xảy ra lỗi khi lấy nhạc từ SoundCloud cho bạn, vui lòng thử lại sau.`,
            },
            30000
          );
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;
  } catch (error) {
    console.error("Error handling music command:", error);
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: "Đã xảy ra lỗi khi xử lý lệnh của bạn. Vui lòng thử lại sau.",
      },
      true,
      30000
    );
  } finally {
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleMusicReply(api, message) {
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Error handling music reply:", error);
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Đã xảy ra lỗi khi xử lý lấy nhạc từ SoundCloud cho bạn, vui lòng thử lại sau.`,
      },
      30000
    );
    return true;
  }
}

export async function handleSendTrackSoundCloud(api, message, track) {
  const cachedMusic = await getCachedMedia(PLATFORM, track.id, null, track.title);
  let voiceUrl;

  if (cachedMusic?.fileUrl) {
    voiceUrl = cachedMusic.fileUrl;
  } else {
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: `Chờ bé lấy nhạc một chút, xong bé gọi cho hay.\n\n⏳ ${track.title}`,
      },
      10000
    );
    try {
      voiceUrl = await downloadAndUploadSoundCloudTrack(track, api, message);
    } catch {
      voiceUrl = null;
    }

    if (!voiceUrl) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `Xin lỗi, bé không thể lấy được bài hát này về. Vui lòng thử chọn bài khác.`,
        },
        30000
      );
      return false;
    }

    await setCacheData(
      PLATFORM,
      track.id,
      {
        title: track.title,
        artist: track.user?.username || "Unknown Artist",
        fileUrl: voiceUrl,
      },
      null
    );
  }

  const thumbnailUrl =
    track.artwork_url?.replace("-large", "-t500x500") ||
    track.user?.avatar_url?.replace("-large", "-t500x500") ||
    DEFAULT_SOUNDCLOUD_ARTWORK;

  const stats = [
    track.playback_count && `${track.playback_count.toLocaleString()} 👂`,
    track.likes_count && `${track.likes_count.toLocaleString()} ❤️`,
    track.comment_count && `${track.comment_count.toLocaleString()} 💬`,
  ].filter(Boolean);

  const objectMusic = {
    trackId: track.id,
    title: track.title,
    artists: track.user?.username || "Unknown Artist",
    like: track.likes_count,
    listen: track.playback_count,
    comment: track.comment_count,
    source: "SoundCloud",
    caption: `> From SoundCloud <\nNhạc Bạn Chọn Đây!!!`,
    imageUrl: thumbnailUrl,
    voiceUrl,
    stats,
  };
  await sendVoiceMusic(api, message, objectMusic, 86400000);
  return true;
}
