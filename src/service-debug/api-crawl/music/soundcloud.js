import axios from "axios";
import fs from "fs";
import path from "path";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "url";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageFromSQL,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { downloadAudio } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { removeMention } from "../../../utils/format-util.js";
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

let clientId, mp3FilePath, accFilePath, m4aFilePath;

const PLATFORM = "soundcloud";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../config.json");
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/127.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
];
const TIME_TO_SELECT = 60000;

const acceptLanguages = ["en-US,en;q=0.9", "fr-FR,fr;q=0.9", "es-ES,es;q=0.9", "de-DE,de;q=0.9", "zh-CN,zh;q=0.9"];

const getRandomElement = (array) => {
  return array[Math.floor(Math.random() * array.length)];
};

const getHeaders = () => {
  return {
    "User-Agent": getRandomElement(userAgents),
    "Accept-Language": getRandomElement(acceptLanguages),
    Referer: "https://soundcloud.com/",
    "Upgrade-Insecure-Requests": "1",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  };
};

const getClientId = async (forceRefresh = false) => {
  if (process.env.SOUNDCLOUD_CLIENT_ID) return process.env.SOUNDCLOUD_CLIENT_ID;

  try {
    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {}
    const lastUpdate = config?.soundcloud?.lastUpdate ? new Date(config.soundcloud.lastUpdate) : new Date(0);
    const now = new Date();

    const daysDiff = (now - lastUpdate) / (1000 * 60 * 60 * 24);

    if (!forceRefresh && daysDiff < 3 && config?.soundcloud?.clientId) {
      return config.soundcloud.clientId;
    }

    const response = await axios.get("https://soundcloud.com/", {
      headers: getHeaders(),
      timeout: 10000,
    });

    const dom = new JSDOM(response.data);
    const scriptTags = Array.from(dom.window.document.querySelectorAll("script[crossorigin]"));

    const urls = scriptTags.map((tag) => tag.src).filter((src) => src && src.startsWith("https"));

    if (!urls.length) {
      throw new Error("Không tìm thấy URL script");
    }

    const scriptResponse = await axios.get(urls[urls.length - 1], {
      headers: getHeaders(),
      timeout: 10000,
    });

    const newClientId = scriptResponse.data.split(',client_id:"')[1]?.split('"')[0];
    if (!newClientId) {
      throw new Error("Không thể trích xuất client_id từ script");
    }

    config.soundcloud = {
      clientId: newClientId,
      lastUpdate: now.toISOString(),
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return newClientId;
  } catch (error) {
    console.error(`Không thể lấy client ID: ${error.message || error}`);
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return process.env.SOUNDCLOUD_CLIENT_ID || config?.soundcloud?.clientId || "";
    } catch {
      return process.env.SOUNDCLOUD_CLIENT_ID || "";
    }
  }
};

async function getMusicInfo(question, limit, retried = false) {
  limit = Math.min(20, Math.max(1, parseInt(limit, 10) || 10));
  try {
    const response = await axios.get("https://api-v2.soundcloud.com/search/tracks", {
      timeout: 10000,
      params: {
        q: question,
        variant_ids: "",
        facet: "genre",
        client_id: clientId,
        limit: limit,
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
    console.error("Error fetching music info:", error.message || error);
    return null;
  }
}

async function getMusicStreamUrl(link, retried = false) {
  try {
    const headers = getHeaders();
    const apiUrl = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(link)}&client_id=${clientId}`;

    const response = await axios.get(apiUrl, { headers, timeout: 10000 });
    const data = response.data;

    const progressiveUrl = data?.media?.transcodings?.find((t) => t.format.protocol === "progressive")?.url;

    if (!progressiveUrl) {
      throw new Error("Không tìm thấy URL âm thanh");
    }

    const streamResponse = await axios.get(
      `${progressiveUrl}?client_id=${clientId}&track_authorization=${data.track_authorization}`,
      {
        headers,
        timeout: 10000,
      }
    );

    return streamResponse.data.url;
  } catch (error) {
    if (!retried && (error?.response?.status === 401 || error?.response?.status === 403)) {
      clientId = await getClientId(true);
      if (clientId) return getMusicStreamUrl(link, true);
    }
    console.error("Error getting music stream URL:", error.message || error);
    return null;
  }
}

export async function handleMusicCommand(api, message, aliasCommand) {
  let imagePath = null;
  let registered = false;
  try {
    if (!clientId) clientId = await getClientId();
    const content = removeMention(message);
    const senderId = message.data.uidFrom;
    const prefix = getGlobalPrefix();
    const commandContent = content.replace(`${prefix}${aliasCommand}`, "").trim();
    const [question, numberMusic] = commandContent.split("&&");

    if (!question) {
      const object = {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Bài Hát Cần Tìm`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const musicInfo = await getMusicInfo(question, parseInt(numberMusic));
    if (!musicInfo || !musicInfo.collection || musicInfo.collection.length === 0) {
      const object = {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${question}`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    let musicListTxt = "Đây là danh sách bài hát trên SoundCloud mà tôi tìm thấy:\n";
    musicListTxt += "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số index của bài hát bạn muốn tìm!";
    musicInfo.collection = musicInfo.collection.filter((track) => track.artwork_url);

    if (musicInfo.collection.length === 0) {
      const object = {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${question}`,
      };
      await sendMessageWarningRequest(api, message, object, TIME_TO_SELECT);
      return;
    }

    // musicListTxt += musicInfo.collection
    //   .map((music, index) => {
    //     const stats = [
    //       music.playback_count && `${music.playback_count.toLocaleString()} 👂`,
    //       music.likes_count && `${music.likes_count.toLocaleString()} ❤️`,
    //       music.comment_count && `${music.comment_count.toLocaleString()} 💬`
    //     ].filter(Boolean);

    //     return `${index + 1}. ${music.title}${music.user?.username ? ` _ ${music.user.username}` : ""}` +
    //       `${stats.length ? `\n(${stats.join(" | ")})` : ""}`
    //   })
    //   .join("\n\n");

    const songs = musicInfo.collection.map(track => ({
      title: track.title,
      artistsNames: track.user?.username || "Unknown Artist",
      thumbnailM: track.artwork_url?.replace("-large", "-t500x500") || null,
      listen: track.playback_count,
      like: track.likes_count,
      comment: track.comment_count
    }));

    imagePath = await createSearchResultImage(songs);

    const object = {
      caption: musicListTxt,
      imagePath: imagePath,
    };
    const musicListMessage = await sendMessageCompleteRequest(api, message, object, 30000);

    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

    // Preview temp thuộc sở hữu session; chỉ xóa đúng một lần khi kết thúc.
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
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: musicListTxt,
        imagePath: imagePath,
      }, 30000),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        if (!isAdmin(senderId) && media.duration > 1800000) {
          await sendMessageWarningRequest(api, replyMessage, {
            caption: `Thời lượng nhạc vượt quá thời gian tin nhắn tồn tại, vui lòng chọn bài khác.`,
          }, 30000);
          return { ok: false, claimed: false };
        }
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTrackSoundCloud(api, replyMessage, media);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error("Error handling soundcloud selection:", error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption: `Đã xảy ra lỗi khi xử lý lấy nhạc từ SoundCloud cho bạn, vui lòng thử lại sau.`,
          }, 30000);
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
    if (imagePath && !registered) deleteFile(imagePath);
  }
}

export async function handleMusicReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    if (!message.data.quote || !message.data.quote.globalMsgId) return false;
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Error handling music reply:", error);
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý lấy nhạc từ SoundCloud cho bạn, vui lòng thử lại sau.`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
    return true;
  }
}

export async function handleSendTrackSoundCloud(api, message, track) {
  const cachedMusic = await getCachedMedia(PLATFORM, track.id, null, track.title);
  let voiceUrl;

  const object = {
    caption: `Chờ bé lấy nhạc một chút, xong bé gọi cho hay.` + `\n\n⏳ ${track.title}`,
  };

  if (cachedMusic) {
    voiceUrl = cachedMusic.fileUrl;
  } else {
    await sendMessageCompleteRequest(api, message, object, 10000);
    const url = await getMusicStreamUrl(track.permalink_url);

    if (!url) {
      const object = {
        caption: `Xin lỗi, bé Không thể lấy được bài hát này về. Vui lòng thử lại bài khác.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return true;
    }

    voiceUrl = await downloadAudio(url, api, message, track.id);
    await setCacheData(PLATFORM, track.id, {
      title: track.title,
      artist: track.user?.username || "Unknown Artist",
      fileUrl: voiceUrl,
    }, null);
  }

  const thumbnailUrl = track.artwork_url?.replace("-large", "-t500x500");

  const stats = [
    track.playback_count && `${track.playback_count.toLocaleString()} 👂`,
    track.likes_count && `${track.likes_count.toLocaleString()} ❤️`,
    track.comment_count && `${track.comment_count.toLocaleString()} 💬`
  ].filter(Boolean);

  const caption = `> From SoundCloud <\nNhạc Bạn Chọn Đây!!!`;

  const objectMusic = {
    trackId: track.id,
    title: track.title,
    artists: track.user?.username || "Unknown Artist",
    like: track.likes_count,
    listen: track.playback_count,
    comment: track.comment_count,
    source: "SoundCloud",
    caption: caption,
    imageUrl: thumbnailUrl,
    voiceUrl: voiceUrl,
    stats: stats,
  };
  await sendVoiceMusic(api, message, objectMusic, 86400000);
  mp3FilePath = path.resolve(process.cwd(), 'assets', 'temp', `${track.id}.mp3`)
    accFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${track.id}.acc`)
    m4aFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${track.id}.m4a`)
    // if (fs.existsSync(mp3FilePath)) await fs.promises.unlink(mp3FilePath);
    if (fs.existsSync(accFilePath)) void deleteFile(accFilePath);
    if (fs.existsSync(m4aFilePath)) void deleteFile(m4aFilePath);
    if (fs.existsSync(mp3FilePath)) void deleteFile(mp3FilePath);
  return true;
}
