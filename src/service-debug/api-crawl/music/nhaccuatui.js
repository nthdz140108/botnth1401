import axios from "axios";
import * as cheerio from "cheerio";
import { MessageMention } from "../../../api-zalo/models/index.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service.js";
import { downloadAndConvertAudio, uploadAudioFile } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
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
import { downloadAudioWithYtDlp, runYtDlpJson } from "../youtube/youtube-runtime.js";
import { searchSoundCloudTracks, resolveSoundCloudStreamUrl } from "./soundcloud.js";

const PLATFORM = "nhaccuatui";
const TIME_TO_SELECT = 60000;
const DEFAULT_NCT_THUMB = "https://stc-id.nixcdn.com/v11/images/avatar_default_2020.png";
const NCT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
  Referer: "https://www.nhaccuatui.com/",
};

function resolveNuxtValue(arr, idx, depth = 0) {
  if (depth > 6 || !Array.isArray(arr)) return idx;
  if (typeof idx !== "number" || idx < 0 || idx >= arr.length) return idx;
  const val = arr[idx];
  if (Array.isArray(val)) {
    if (val.length === 2 && (val[0] === "Reactive" || val[0] === "ShallowReactive" || val[0] === "Ref")) {
      return resolveNuxtValue(arr, val[1], depth + 1);
    }
    return val.map((v) => resolveNuxtValue(arr, v, depth + 1));
  }
  if (val && typeof val === "object") {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = resolveNuxtValue(arr, v, depth + 1);
    }
    return out;
  }
  return val;
}

function extractSongsFromNuxtHtml(html) {
  const items = [];
  const seen = new Set();
  const $ = cheerio.load(html);

  const nuxtRaw = $("script#__NUXT_DATA__").html() || "";
  if (nuxtRaw) {
    try {
      const parsed = JSON.parse(nuxtRaw);
      if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
          const entry = parsed[i];
          if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            if (("key" in entry || "songKey" in entry || "encodeId" in entry) && ("title" in entry || "name" in entry)) {
              const obj = resolveNuxtValue(parsed, i);
              const id = String(obj.key || obj.songKey || obj.encodeId || obj.id || "").trim();
              const title = String(obj.title || obj.name || "").trim();
              if (!id || !title || seen.has(id)) continue;
              seen.add(id);
              const artistStr = Array.isArray(obj.artists)
                ? obj.artists.map((a) => a?.name || a?.shortLink || a).filter(Boolean).join(", ")
                : String(obj.artistsNames || obj.artistName || obj.singer || "Nghệ sĩ").trim();
              const streamUrl = Array.isArray(obj.streamUrls)
                ? obj.streamUrls[0]?.streamUrl || ""
                : String(obj.streamURL || obj.streamUrl || "").trim();
              items.push({
                id,
                songLink: obj.shareUrl || obj.url || `https://www.nhaccuatui.com/bai-hat/song.${id}.html`,
                title,
                artistsNames: artistStr || "Nghệ sĩ",
                thumbnail: obj.thumbnail || obj.imageUrl || obj.avatar || DEFAULT_NCT_THUMB,
                streamUrl: /^https?:\/\//i.test(streamUrl) ? streamUrl : "",
                isOfficial: Boolean(obj.isOfficial ?? true),
                isHD: Boolean(obj.isHD ?? true),
              });
            }
          }
        }
      }
    } catch {}
  }

  if (items.length === 0) {
    $("a[href*='/bai-hat/']").each((_, el) => {
      const anchor = $(el);
      const href = anchor.attr("href") || "";
      const keyMatch = href.match(/\.([A-Za-z0-9]{10,16})\.html/);
      const id = anchor.attr("key") || keyMatch?.[1] || "";
      const title = (anchor.attr("title") || anchor.text() || "").trim();
      if (!id || !title || seen.has(id) || title.length < 2) return;
      seen.add(id);
      const parent = anchor.closest("li, div");
      const artist =
        parent.find(".name_singer, .singer, [class*='artist'], [class*='singer']").first().text().trim() ||
        "Nghệ sĩ";
      const thumb =
        parent.find("img").attr("data-src") ||
        parent.find("img").attr("src") ||
        DEFAULT_NCT_THUMB;
      items.push({
        id,
        songLink: href.startsWith("http") ? href : `https://www.nhaccuatui.com${href}`,
        title,
        artistsNames: artist,
        thumbnail: thumb,
        streamUrl: "",
        isOfficial: true,
        isHD: false,
      });
    });
  }

  return items;
}

async function searchMusicFallback(keyword, limit = 10) {
  try {
    const itunesRes = await axios.get("https://itunes.apple.com/search", {
      params: { term: keyword, entity: "song", country: "VN", limit },
      timeout: 8000,
    });
    const results = Array.isArray(itunesRes.data?.results) ? itunesRes.data.results : [];
    if (results.length > 0) {
      return results.map((item) => ({
        id: `nct_it_${item.trackId}`,
        songLink: item.trackViewUrl || "",
        title: item.trackName || "Bài hát",
        artistsNames: item.artistName || "Nghệ sĩ",
        thumbnail: item.artworkUrl100
          ? String(item.artworkUrl100).replace("100x100bb", "600x600bb")
          : DEFAULT_NCT_THUMB,
        previewUrl: item.previewUrl || "",
        streamUrl: "",
        isOfficial: true,
        isHD: true,
      }));
    }
  } catch {}

  try {
    const scTracks = await searchSoundCloudTracks(keyword, limit);
    if (scTracks.length > 0) {
      return scTracks.map((sc) => ({
        id: `nct_sc_${sc.id}`,
        songLink: sc.permalink_url,
        title: sc.title,
        artistsNames: sc.artist,
        thumbnail: sc.thumbnail || DEFAULT_NCT_THUMB,
        streamUrl: "",
        permalinkUrl: sc.permalink_url,
        isOfficial: false,
        isHD: true,
      }));
    }
  } catch {}

  try {
    const raw = await runYtDlpJson(`ytsearch${Math.min(limit, 8)}:${keyword}`, {
      flatPlaylist: true,
      skipDownload: true,
    });
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];
    return entries
      .filter((e) => e?.id && e?.title)
      .map((e) => ({
        id: `nct_yt_${e.id}`,
        songLink: e.webpage_url || `https://www.youtube.com/watch?v=${e.id}`,
        title: e.title,
        artistsNames: e.channel || e.uploader || "Nghệ sĩ",
        thumbnail: e.thumbnail || e.thumbnails?.[0]?.url || DEFAULT_NCT_THUMB,
        streamUrl: "",
        isOfficial: true,
        isHD: true,
      }));
  } catch {
    return [];
  }
}

export const searchMusic = async (keyword, limit = 10) => {
  const bounded = Math.min(20, Math.max(1, parseInt(limit, 10) || 10));
  try {
    const encodedKeyword = encodeURIComponent(keyword);
    const url = `https://www.nhaccuatui.com/tim-kiem/bai-hat?q=${encodedKeyword}`;
    const response = await axios.get(url, {
      timeout: 9000,
      headers: NCT_HEADERS,
    });
    const nctItems = extractSongsFromNuxtHtml(response.data);
    if (nctItems.length > 0) {
      return { data: { items: nctItems.slice(0, bounded) } };
    }
  } catch {}

  const fallbackItems = await searchMusicFallback(keyword, bounded);
  return { data: { items: fallbackItems.slice(0, bounded) } };
};

async function extractDirectNctStream(songLink) {
  if (!songLink || !songLink.includes("nhaccuatui.com")) return null;
  try {
    const res = await axios.get(songLink, {
      headers: NCT_HEADERS,
      timeout: 9000,
      maxRedirects: 5,
    });
    const html = String(res.data || "");
    const nuxtItems = extractSongsFromNuxtHtml(html);
    const withStream = nuxtItems.find((item) => item.streamUrl);
    if (withStream?.streamUrl) return withStream.streamUrl;

    const mp3Match = html.match(/https?:\/\/[^"'\\\s]+\.(?:mp3|m4a)(?:\?[^"'\\\s]*)?/i);
    if (mp3Match?.[0] && !mp3Match[0].toLowerCase().includes("vip")) {
      return mp3Match[0];
    }
  } catch {}
  return null;
}

async function resolveAndUploadNctAudio(track, api, message) {
  // 1. Direct NCT stream URL if available
  const directStream = track.streamUrl || (await extractDirectNctStream(track.songLink));
  if (directStream) {
    try {
      const uploaded = await downloadAndConvertAudio(directStream, api, message);
      if (uploaded) return uploaded;
    } catch {}
  }

  // 2. Direct SoundCloud permalink if sourced from SC
  if (track.permalinkUrl) {
    const scUrl = await resolveSoundCloudStreamUrl(track.permalinkUrl);
    if (scUrl) {
      const uploaded = await downloadAndConvertAudio(scUrl, api, message);
      if (uploaded) return uploaded;
    }
  }

  // 3. yt-dlp official audio search / songLink extraction
  let localAudioPath = null;
  const searchTarget =
    track.songLink && /youtube\.com|youtu\.be/i.test(track.songLink)
      ? track.songLink
      : `ytsearch1:${track.title} ${track.artistsNames || ""} official audio`;
  try {
    localAudioPath = await downloadAudioWithYtDlp(searchTarget);
    const uploaded = await uploadAudioFile(localAudioPath, api, message);
    if (uploaded) return uploaded;
  } catch {} finally {
    if (localAudioPath) {
      await deleteFile(localAudioPath).catch(() => {});
    }
  }

  // 4. SoundCloud search fallback
  try {
    const scCandidates = await searchSoundCloudTracks(`${track.title} ${track.artistsNames || ""}`.trim(), 3);
    for (const sc of scCandidates) {
      const streamUrl = await resolveSoundCloudStreamUrl(sc.permalink_url);
      if (streamUrl) {
        const uploaded = await downloadAndConvertAudio(streamUrl, api, message);
        if (uploaded) return uploaded;
      }
    }
  } catch {}

  // 5. iTunes preview fallback
  if (track.previewUrl) {
    const uploaded = await downloadAndConvertAudio(track.previewUrl, api, message);
    if (uploaded) return uploaded;
  }

  throw new Error("Không tìm thấy luồng phát hợp lệ cho bài hát này");
}

export async function handleNhacCuaTuiCommand(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  let imagePath = null;
  let registered = false;

  try {
    const prefix = getGlobalPrefix();
    const commandContent = extractCommandBody(message, prefix, aliasCommand || "nhaccuatui");
    const [rawKeyword, numberMusic] = commandContent.split("&&");
    const keyword = String(rawKeyword || "").trim();

    if (!keyword) {
      await sendMessageWarningRequest(api, message, {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Nơi này có anh`,
      }, 30000);
      return;
    }

    const limit = Math.min(20, Math.max(1, parseInt(numberMusic, 10) || 10));
    const result = await searchMusic(keyword, limit);

    if (!result?.data?.items || result.data.items.length === 0) {
      await sendMessageWarningRequest(api, message, {
        caption: `Không tìm thấy bài hát nào với từ khóa: ${keyword}`,
      }, 30000);
      return;
    }

    const songs = result.data.items.slice(0, limit);
    const musicListTxt =
      "Đây là danh sách bài hát trên NhacCuaTui mà tôi tìm thấy:\n" +
      "Hãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự của bài hát bạn muốn nghe!\n\n";

    const songsCustom = songs.map((song) => ({
      title: song.title,
      artistsNames: song.artistsNames,
      thumbnailM: song.thumbnail || DEFAULT_NCT_THUMB,
      isOfficial: song.isOfficial,
      isHD: song.isHD,
    }));
    imagePath = await createSearchResultImage(songsCustom);

    const musicListMessage = await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: musicListTxt,
        imagePath,
      },
      TIME_TO_SELECT
    );

    const quotedMsgId = musicListMessage?.message?.msgId || musicListMessage?.attachment?.[0]?.msgId;

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
      resendPrompt: async () =>
        sendMessageCompleteRequest(api, message, {
          caption: musicListTxt,
          imagePath,
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
            caption: `Không thể lấy bài hát này, vui lòng thử bài khác!\nNguyên nhân: ${error.message}`,
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
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}

export async function handleNhacCuaTuiReply(api, message) {
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Lỗi xử lý reply NhacCuaTui:", error);
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi lấy nhạc từ NhacCuaTui cho bạn, vui lòng thử lại sau.`,
    }, 30000);
    return true;
  }
}

export async function handleSendTrackNhacCuaTui(api, message, track) {
  const cachedMusic = await getCachedMedia(PLATFORM, track.id, null, track.title);
  let voiceUrl;

  if (cachedMusic?.fileUrl) {
    voiceUrl = cachedMusic.fileUrl;
  } else {
    await sendMessageCompleteRequest(api, message, {
      caption: `Chờ bé lấy nhạc một chút, xong bé gọi cho hay.\n\n⏳ ${track.title}`,
    }, 5000);

    voiceUrl = await resolveAndUploadNctAudio(track, api, message);
    await setCacheData(
      PLATFORM,
      track.id,
      { fileUrl: voiceUrl, title: track.title, artist: track.artistsNames },
      null
    );
  }

  const objectMusic = {
    trackId: track.id,
    title: track.title,
    artists: track.artistsNames || "Unknown Artist",
    source: "NhacCuaTui",
    caption: `> From NhacCuaTui <\nNhạc Bạn Chọn Đây!!!`,
    imageUrl: track.thumbnail || DEFAULT_NCT_THUMB,
    voiceUrl,
  };
  await sendVoiceMusic(api, message, objectMusic, 86400000);
  return true;
}
