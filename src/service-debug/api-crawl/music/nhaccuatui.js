import axios from "axios";
import path from 'path';
import fs from 'fs';
import * as cheerio from "cheerio";
import { MessageMention } from "../../../api-zalo/models/index.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service.js";
import http from "http";
import https from "https";
import { downloadAndConvertAudio } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { removeMention } from "../../../utils/format-util.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { createSearchResultImage } from "../../../utils/canvas/search-canvas.js";
import { deleteFile } from "../../../utils/util.js";
import { canContinueReply } from "../../reply-access.js";
let mp3FilePath, accFilePath, m4aFilePath;
const PLATFORM = "nhaccuatui";
const TIME_TO_SELECT = 60000;

const searchMusic = async (keyword) => {
  try {
    const encodedKeyword = encodeURIComponent(keyword);
    const url = `https://www.nhaccuatui.com/tim-kiem/bai-hat?q=${encodedKeyword}&b=keyword&l=tat-ca&s=default`;

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(response.data);

    const results = {
      data: {
        items: [],
      },
    };

    $(".sn_search_returns_list_song .sn_search_single_song").each((i, el) => {
      const songElement = $(el);
      const songLink = songElement.find("a").first();
      const title = songLink.attr("title")?.trim() || "";
      const key = songLink.attr("key") || "";
      const songLinkHref = songLink.attr("href") || "";
      const artist = songElement.find(".name_singer").text().trim();
      const isOfficial = songElement.find(".icon_tag_official").length > 0;
      const isHD = songElement.find(".icon_tag_hd").length > 0;
      let thumbnail =
        songLink.find(".thumb").attr("data-src") ||
        songLink.find(".thumb").attr("src") ||
        "";
      if (thumbnail) thumbnail = thumbnail.replace(".jpg", "_600.jpg");

      results.data.items.push({
        id: key,
        songLink: songLinkHref,
        title,
        artistsNames: artist,
        thumbnail,
        streamingStatus: isOfficial ? 1 : 2,
        isOfficial,
        isHD,
      });
    });

    return results;
  } catch (error) {
    console.error("Lỗi khi tìm kiếm nhạc:", error);
    return {
      data: {
        items: [],
      },
    };
  }
};

const getStreamUrl = async (songId, songLink, retryCount = 3, preloadedHtml = null) => {
  try {
    let htmlData = preloadedHtml;
    if (!htmlData) {
      const response = await axios.get(songLink, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          Referer: "https://www.nhaccuatui.com/",
        },
        timeout: 10000,
      });
      htmlData = response.data;
    }

    const $ = cheerio.load(htmlData);

    let key = null;
    const scripts = $("script").get();
    for (const script of scripts) {
      const content = $(script).html() || "";
      const keyMatch = content.match(/key1=([a-f0-9]{32})/i);
      if (keyMatch && keyMatch[1]) {
        key = keyMatch[1];
        break;
      }
    }

    if (!key) {
      console.error("Không tìm thấy key trong HTML");
      return null;
    }

    const xmlUrl = `https://www.nhaccuatui.com/flash/xml?html5=true&key1=${key}`;

    const getXmlWithRetry = async (attempt = 0) => {
      try {
        const xmlResponse = await axios.get(xmlUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/xml,text/xml,*/*",
            Referer: songLink,
          },
          timeout: 15000,
          maxRedirects: 5,
          validateStatus: function (status) {
            return status >= 200 && status < 400;
          },
          httpAgent: new http.Agent({ keepAlive: true }),
          httpsAgent: new https.Agent({ keepAlive: true }),
        });
        return xmlResponse;
      } catch (error) {
        if (
          attempt < 3 &&
          (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
        ) {
          console.log(`Retry XML request lần ${attempt + 1}...`);
          await new Promise((resolve) =>
            setTimeout(resolve, 2000 * (attempt + 1))
          );
          return getXmlWithRetry(attempt + 1);
        }
        throw error;
      }
    };

    const xmlResponse = await getXmlWithRetry();

    const $xml = cheerio.load(xmlResponse.data, {
      xmlMode: true,
    });

    const cleanCdata = (str) =>
      String(str || "")
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/[\n\r\t]/g, "")
        .trim();

    let streamUrl = cleanCdata($xml("locationHQ").text()) || cleanCdata($xml("location").text());

    try {
      new URL(streamUrl);
    } catch (e) {
      console.error("Stream URL Không hợp lệ:", streamUrl);
      return null;
    }

    return streamUrl;
  } catch (error) {
    console.error("Lỗi khi lấy stream URL:", error);

    if (retryCount > 0) {
      console.log(`Thử lại toàn bộ quá trình lần ${4 - retryCount}...`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return getStreamUrl(songId, songLink, retryCount - 1);
    }
    return null;
  }
};

const getSongInfo = async (songData, retryCount = 3) => {
  try {
    const response = await axios.get(songData.songLink, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        Connection: "keep-alive",
        "Cache-Control": "max-age=0",
        Referer: "https://www.nhaccuatui.com/",
      },
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: function (status) {
        return status >= 200 && status < 400;
      },
      retry: retryCount,
      retryDelay: (retryCount) => {
        return retryCount * 1000;
      },
    });

    const $ = cheerio.load(response.data);

    const finalUrl = response.request?.res?.responseUrl || songData.songLink;

    const streamUrl = await getStreamUrl(songData.id, finalUrl, 2, response.data);

    const title =
      $(".name_title").text().trim() || $(".title_song").text().trim();

    return {
      title,
      artistsNames: songData.artistsNames,
      thumbnail: songData.thumbnail,
      streamUrl,
    };
  } catch (error) {
    console.error("Lỗi khi lấy thông tin bài hát:", error);

    if (retryCount > 0) {
      console.log(`Thử lại lần ${4 - retryCount}...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return getSongInfo(songData, retryCount - 1);
    }
    return null;
  }
};

export async function handleNhacCuaTuiCommand(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  let imagePath = null;
  let registered = false;

  try {
    const content = removeMention(message);
    const prefix = getGlobalPrefix();
    const commandContent = content
      .replace(`${prefix}${aliasCommand}`, "")
      .trim();
    const [keyword, numberMusic] = commandContent.split("&&");

    if (!keyword) {
      const object = {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Bài Hát Cần Tìm`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const result = await searchMusic(keyword, numberMusic);

    if (!result?.data?.items || result.data.items.length === 0) {
      const object = {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${keyword}`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return;
    }

    const limit = Math.min(20, Math.max(1, parseInt(numberMusic, 10) || 10));
    const songs = result.data.items.slice(0, limit);
    let musicListTxt = "Đây là danh sách bài hát trên NhacCuaTui mà tôi tìm thấy:\n";
    musicListTxt +=
      "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số index của bài hát bạn muốn nghe!\n\n";
    // musicListTxt += songs
    //   .map((song, index) => {
    //     const tag = [song.isOfficial && "Official", song.isHD && "HD"]
    //       .filter(Boolean)
    //       .join(" | ");

    //     const displayTag = tag ? ` [${tag}]` : "";
    //     return `${index + 1}. ${song.title} - ${song.artistsNames
    //       } ${displayTag}`;
    //   })
    //   .join("\n\n");

    const songsCustom = songs.map(song => ({
      title: song.title,
      artistsNames: song.artistsNames,
      thumbnailM: song.thumbnail,
      isOfficial: song.isOfficial,
      isHD: song.isHD,
    }));
    imagePath = await createSearchResultImage(songsCustom);

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
      collection: songs,
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
          const sent = await handleSendTrackNhacCuaTui(api, replyMessage, media);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error("Lỗi xử lý chọn NhacCuaTui:", error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption: `Không thể lấy bài này, vui lòng thử bài khác!\nNguyên Nhân: ${error.message}`,
          }, 30000);
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;
  } catch (error) {
    console.error("Lỗi xử lý lệnh NhacCuaTui:", error);
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

export async function handleNhacCuaTuiReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    if (!message.data.quote || !message.data.quote.globalMsgId) return false;
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Lỗi xử lý reply NhacCuaTui:", error);
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý lấy nhạc từ NhacCuaTui cho bạn, vui lòng thử lại sau.`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
    return true;
  }
}

export async function handleSendTrackNhacCuaTui(api, message, track) {
  const cachedMusic = await getCachedMedia(PLATFORM, track.id, null, track.title);
  let voiceUrl;

  const object = {
    caption: `Chờ bé lấy nhạc một chút, xong bé gọi cho hay.\n\n⏳ ${track.title}`,
  };

  if (cachedMusic) {
    voiceUrl = cachedMusic.fileUrl;
  } else {
    await sendMessageCompleteRequest(api, message, object, 5000);
    const songInfo = await getSongInfo(track);
    if (!songInfo || !songInfo.streamUrl) {
      throw new Error("Không thể lấy thông tin bài hát");
    }

    voiceUrl = await downloadAndConvertAudio(
      songInfo.streamUrl,
      api,
      message,
      track.id
    );
    await setCacheData(PLATFORM, track.id, { fileUrl: voiceUrl, title: track.title, artist: track.artistsNames }, null);
    mp3FilePath = path.resolve(process.cwd(), 'assets', 'temp', `${track.id}.mp3`)
    accFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${track.id}.acc`)
    m4aFilePath = path.resolve(process.cwd(), 'assets', 'temp', `${track.id}.m4a`)
    // if (fs.existsSync(mp3FilePath)) await fs.promises.unlink(mp3FilePath);
    if (fs.existsSync(accFilePath)) void deleteFile(accFilePath);
    if (fs.existsSync(m4aFilePath)) void deleteFile(m4aFilePath);
    if (fs.existsSync(mp3FilePath)) void deleteFile(mp3FilePath);
  }

  const caption = `> From NhacCuaTui <\nNhạc Bạn Chọn Đây!!!`;

  const objectMusic = {
    trackId: track.id,
    title: track.title,
    artists: track.artistsNames || "Unknown Artist",
    source: "NhacCuaTui",
    caption: caption,
    imageUrl: track.thumbnail,
    voiceUrl: voiceUrl,
  }
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
