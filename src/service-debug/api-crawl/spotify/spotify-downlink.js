import axios from "axios";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageProcessingRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { deleteFile } from "../../../utils/util.js";
import { sendVoiceMusic } from "../../chat-zalo/chat-special/send-voice/send-voice.js";
import { capitalizeEachWord } from "../../../utils/format-util.js";
import { extractCommandBody } from "../../../commands/shared/command-input-utils.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  setSelectionsMapData,
} from "../index.js";
import { createSearchResultImage } from "./search-canvas.js";
import { downloadAndConvertAudio, uploadAudioFile } from "../../chat-zalo/chat-special/send-voice/process-audio.js";
import { canContinueReply } from "../../reply-access.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { downloadAudioWithYtDlp } from "../youtube/youtube-runtime.js";
import { searchSoundCloudTracks, resolveSoundCloudStreamUrl } from "../music/soundcloud.js";

const PLATFORM = "spotify";
const URL_SPOTIFY_SEARCH = "https://api.spotify.com/v1/search";
const TIME_WAIT_SELECTION = 120000;
const DEFAULT_SPOTIFY_THUMBNAIL = "https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png";

function getSpotifyProviderEnv() {
  return {
    clientId: String(process.env.SPOTIFY_CLIENT_ID || "").trim(),
    clientSecret: String(process.env.SPOTIFY_CLIENT_SECRET || "").trim(),
    downloaderSecret: String(process.env.SPOTIFY_DOWNLOADER_SECRET || "").trim(),
    downloaderPassphrase: String(process.env.SPOTIFY_DOWNLOADER_PASSPHRASE || "").trim(),
  };
}

function randomString(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function sanitizeFilename(name) {
  if (!name) return `media_${Date.now()}_${randomString(8)}`;
  return (
    name
      .replace(/[<>:"/\\|?*&%=#@!$'`~\s]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .substring(0, 100) || `media_${Date.now()}_${randomString(8)}`
  );
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

function extractSpotifyTrackId(url) {
  const match = String(url || "").match(/spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})/i);
  return match ? match[1] : null;
}

async function fetchSpotifyMetadataFromUrl(url) {
  const { clientId, clientSecret } = getSpotifyProviderEnv();
  const trackId = extractSpotifyTrackId(url);

  if (trackId && clientId && clientSecret && clientId !== "YOUR_SPOTIFY_CLIENT_ID_HERE") {
    try {
      const accessToken = await getSpotifyAccessToken(clientId, clientSecret);
      const res = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      const track = res.data;
      if (track?.name) {
        return {
          id: track.id || trackId,
          title: track.name,
          author: track.artists?.map((a) => a.name).join(", ") || "Unknown Artist",
          thumbnail: track.album?.images?.[0]?.url || DEFAULT_SPOTIFY_THUMBNAIL,
          duration: track.duration_ms || 0,
          url: track.external_urls?.spotify || url,
          previewUrl: track.preview_url || "",
        };
      }
    } catch {}
  }

  let title = "";
  let author = "Spotify Artist";
  let thumbnail = DEFAULT_SPOTIFY_THUMBNAIL;
  let duration = 0;

  try {
    const oembedRes = await axios.get("https://open.spotify.com/oembed", {
      params: { url },
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      },
    });
    if (oembedRes.data?.title) {
      title = String(oembedRes.data.title).trim();
    }
    if (oembedRes.data?.thumbnail_url) {
      thumbnail = oembedRes.data.thumbnail_url;
    }
  } catch {}

  if (trackId) {
    try {
      const embedRes = await axios.get(`https://open.spotify.com/embed/track/${trackId}`, {
        timeout: 10000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
        },
      });
      const html = String(embedRes.data || "");
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
      if (nextDataMatch?.[1]) {
        const parsed = JSON.parse(nextDataMatch[1]);
        const entity = parsed?.props?.pageProps?.state?.data?.entity;
        if (entity) {
          title = entity.title || entity.name || title;
          if (Array.isArray(entity.artists) && entity.artists.length > 0) {
            author = entity.artists.map((a) => a.name).filter(Boolean).join(", ") || author;
          } else if (entity.subtitle) {
            author = entity.subtitle;
          }
          duration = entity.duration || duration;
          const cover = entity.visualIdentity?.image?.[0]?.url;
          if (cover) thumbnail = cover;
        }
      }
    } catch {}
  }

  if (!title) {
    return null;
  }

  return {
    id: trackId || sanitizeFilename(title),
    title,
    author,
    thumbnail,
    duration,
    url,
    previewUrl: "",
  };
}

export async function getDataDownload(url) {
  try {
    const meta = await fetchSpotifyMetadataFromUrl(url);
    if (!meta || !meta.title) {
      return { error: "Không thể lấy thông tin bài hát từ link Spotify này." };
    }
    return {
      id: meta.id,
      title: meta.title,
      author: meta.author,
      thumbnail: meta.thumbnail,
      duration: meta.duration || 0,
      url: meta.url,
      medias: [
        {
          url: meta.url,
          previewUrl: meta.previewUrl || "",
          quality: "HQ Audio",
          type: "audio",
          extension: "m4a",
          thumbnail: meta.thumbnail,
          title: meta.title,
          artist: meta.author,
          duration: meta.duration || 0,
        },
      ],
    };
  } catch (error) {
    return { error: error?.message || "Không thể xử lý link Spotify." };
  }
}

async function searchViaItunes(query, limit = 8) {
  try {
    const res = await axios.get("https://itunes.apple.com/search", {
      params: {
        term: query,
        entity: "song",
        country: "VN",
        limit,
      },
      timeout: 10000,
    });
    const results = Array.isArray(res.data?.results) ? res.data.results : [];
    if (results.length === 0) return null;
    return results.map((item) => ({
      id: String(item.trackId || randomString(8)),
      title: item.trackName || "Unknown Title",
      artist: item.artistName || "Unknown Artist",
      thumbnail: item.artworkUrl100
        ? String(item.artworkUrl100).replace("100x100bb", "600x600bb")
        : DEFAULT_SPOTIFY_THUMBNAIL,
      url: item.trackViewUrl || `spotify:search:${encodeURIComponent(`${item.trackName} ${item.artistName}`)}`,
      previewUrl: item.previewUrl || "",
      quality: "HQ Audio",
      extension: "m4a",
      type: "audio",
      duration: item.trackTimeMillis || 0,
      album: item.collectionName || "",
    }));
  } catch {
    return null;
  }
}

export async function searchSpotify(query) {
  const { clientId, clientSecret } = getSpotifyProviderEnv();

  if (clientId && clientSecret && clientId !== "YOUR_SPOTIFY_CLIENT_ID_HERE") {
    try {
      const accessToken = await getSpotifyAccessToken(clientId, clientSecret);
      let optimizedQuery = query;
      const queryParts = query.split(" by ");
      if (queryParts.length > 1) {
        optimizedQuery = `track:${queryParts[0]} artist:${queryParts[1]}`;
      }

      const res = await axios.get(URL_SPOTIFY_SEARCH, {
        params: {
          q: optimizedQuery,
          type: "track",
          limit: 8,
        },
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 10000,
      });

      const tracks = res.data?.tracks?.items;
      if (Array.isArray(tracks) && tracks.length > 0) {
        return tracks
          .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
          .map((track) => ({
            id: track.id,
            title: track.name || "Unknown Title",
            artist: track.artists?.map((a) => a.name).join(", ") || "Unknown Artist",
            thumbnail: track.album?.images?.[0]?.url || DEFAULT_SPOTIFY_THUMBNAIL,
            url: track.external_urls?.spotify || "",
            previewUrl: track.preview_url || "",
            quality: "HQ Audio",
            extension: "m4a",
            type: "audio",
            duration: track.duration_ms || 0,
            album: track.album?.name || "",
          }));
      }
    } catch (error) {
      console.warn("Spotify Web API search fallback:", error?.message || error);
    }
  }

  const itunesTracks = await searchViaItunes(query, 8);
  if (itunesTracks && itunesTracks.length > 0) {
    return itunesTracks;
  }

  const scTracks = await searchSoundCloudTracks(query, 8);
  if (scTracks && scTracks.length > 0) {
    return scTracks.map((sc) => ({
      id: sc.id,
      title: sc.title,
      artist: sc.artist,
      thumbnail: sc.thumbnail,
      url: sc.permalink_url,
      quality: "HQ Audio",
      extension: "mp3",
      type: "audio",
      duration: sc.duration || 0,
      album: "SoundCloud",
    }));
  }

  return null;
}

async function resolveAndUploadSpotifyAudio({ title, author, selectedMedia, api, message }) {
  const searchQuery = `${title} ${author && author !== "Unknown Artist" ? author : ""}`.trim();

  // 1. Primary: yt-dlp official audio stream
  let localAudioPath = null;
  try {
    localAudioPath = await downloadAudioWithYtDlp(`ytsearch1:${searchQuery} official audio`);
    const uploadedUrl = await uploadAudioFile(localAudioPath, api, message);
    if (uploadedUrl) return uploadedUrl;
  } catch {
    // Fallback to SoundCloud / direct stream below
  } finally {
    if (localAudioPath) {
      await deleteFile(localAudioPath).catch(() => {});
    }
  }

  // 2. Fallback: SoundCloud progressive stream
  try {
    const scTracks = await searchSoundCloudTracks(searchQuery, 3);
    for (const sc of scTracks) {
      const streamUrl = await resolveSoundCloudStreamUrl(sc.permalink_url);
      if (streamUrl) {
        const uploadedUrl = await downloadAndConvertAudio(streamUrl, api, message);
        if (uploadedUrl) return uploadedUrl;
      }
    }
  } catch {}

  // 3. Fallback: direct audio URL or previewUrl if available
  const directCandidate =
    selectedMedia?.previewUrl ||
    (selectedMedia?.url &&
    !/spotify\.com|apple\.com/i.test(String(selectedMedia.url)) &&
    /^https?:\/\//i.test(String(selectedMedia.url))
      ? selectedMedia.url
      : "");

  if (directCandidate) {
    return await downloadAndConvertAudio(directCandidate, api, message);
  }

  throw new Error("Không tìm thấy luồng âm thanh khả dụng (kiểm tra yt-dlp hoặc kết nối mạng)");
}

export async function processAndSendSpotifyMedia(api, message, mediaData) {
  const {
    selectedMedia,
    mediaType,
    uniqueId,
    duration,
    title,
    author,
  } = mediaData;

  const quality = selectedMedia?.quality || "HQ Audio";
  const typeFile = String(selectedMedia?.type || "audio").toLowerCase();

  if (typeFile !== "audio") {
    await sendMessageWarningRequest(api, message, {
      caption: "Spotify chỉ hỗ trợ tải nội dung âm thanh.",
    }, 30000);
    return false;
  }

  if (duration > 3000000) {
    await sendMessageWarningRequest(api, message, {
      caption: `Bài hát "${title}" có thời lượng quá dài (>${Math.floor(duration / 1000)}s). Vui lòng chọn bài khác.`,
    }, 30000);
    return false;
  }

  const cacheKey = String(selectedMedia?.id || uniqueId || sanitizeFilename(title));
  const cached = await getCachedMedia(PLATFORM, cacheKey, null, title);
  let voiceUrl = cached?.fileUrl || null;
  const validatedDuration = Math.floor((duration || 0) / 1000) || 1;

  if (!voiceUrl) {
    await sendMessageProcessingRequest(api, message, {
      caption: `Đang tải nhạc từ Spotify, chờ xíu nha!\n\n⏳ ${title}\n👤 Nghệ sĩ: ${author || "Unknown Artist"}`,
    }, 8000);

    try {
      voiceUrl = await resolveAndUploadSpotifyAudio({
        title,
        author,
        selectedMedia,
        api,
        message,
      });
      if (!voiceUrl) {
        throw new Error("Không thể tải lên file âm thanh");
      }
      await setCacheData(PLATFORM, cacheKey, { fileUrl: voiceUrl, title, artist: author }, null);
    } catch (error) {
      await sendMessageWarningRequest(api, message, {
        caption: `Không tải được bài hát "${title}": ${error.message}. Vui lòng thử bài khác.`,
      }, 30000);
      return false;
    }
  }

  const object = {
    trackId: cacheKey,
    title: title || "Không rõ",
    artists: author || "Unknown Artist",
    source: capitalizeEachWord(mediaType || "Spotify"),
    caption: `> From Spotify <\nNhạc đây nè! 🎉\n\n🎵 Music: ${title}\n👤 Artist: ${author || "Unknown Artist"}`,
    imageUrl: selectedMedia?.thumbnail || DEFAULT_SPOTIFY_THUMBNAIL,
    voiceUrl,
    duration: validatedDuration,
  };

  try {
    await sendVoiceMusic(api, message, object, 86400000);
    return true;
  } catch (error) {
    console.error("Lỗi khi gửi nhạc Spotify:", error?.message || error);
    return false;
  }
}

export async function handleSpotifyDownloadCommand(api, message, aliasCommand) {
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();

  try {
    const query = extractCommandBody(message, prefix, aliasCommand || "spotify");
    if (!query) {
      await sendMessageWarningRequest(api, message, {
        caption: `Vui lòng nhập link Spotify cần tải\nVí dụ:\n${prefix}${aliasCommand} <link>`,
      }, 30000);
      return;
    }

    if (!/spotify\.com|spotify\.link/i.test(query)) {
      await sendMessageWarningRequest(api, message, {
        caption: `Link không phải từ Spotify. Vui lòng cung cấp link bài hát Spotify hợp lệ.`,
      }, 30000);
      return;
    }

    const downloadData = await getDataDownload(query);
    if (!downloadData || downloadData.error || !downloadData.medias?.length) {
      await sendMessageWarningRequest(api, message, {
        caption: `Không thể lấy thông tin từ link Spotify: ${downloadData?.error || "Lỗi không xác định"}.`,
      }, 30000);
      return;
    }

    const uniqueId = sanitizeFilename(downloadData.id || downloadData.title || `spotify_${Date.now()}`);
    await processAndSendSpotifyMedia(api, message, {
      selectedMedia: downloadData.medias[0],
      mediaType: "spotify",
      uniqueId,
      duration: downloadData.duration || 0,
      title: downloadData.title || "Unknown Title",
      author: downloadData.author || "Unknown Artist",
      senderId,
      senderName,
    });
  } catch (error) {
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi xử lý link Spotify: ${error.message}.`,
    }, 30000);
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

  if (!media || !media.title) {
    await sendMessageWarningRequest(api, message, {
      caption: `Dữ liệu bài hát không hợp lệ. Vui lòng chọn bài khác.`,
    }, 30000);
    return { ok: false, claimed: false };
  }

  const claimed = typeof claim === "function" ? await claim() : true;
  if (!claimed) return { ok: false, claimed: false, handled: false };

  const sent = await processAndSendSpotifyMedia(api, message, {
    selectedMedia: media,
    mediaType: "spotify",
    uniqueId: media.id || uniqueId,
    duration: media.duration || fallbackDuration || 0,
    title: media.title || fallbackTitle || "Unknown Title",
    author: media.artist || fallbackAuthor || "Unknown Artist",
    senderId: message.data.uidFrom,
    senderName: message.data.dName,
  });
  return { ok: sent !== false, claimed: true };
}

export async function handleSpotifyDownloadReply(api, message) {
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi xử lý lựa chọn bài hát: ${error.message}.`,
    }, 30000);
    return true;
  }
}

export async function handleSpotifyCommand(api, message, command) {
  const senderId = message.data.uidFrom;
  const prefix = getGlobalPrefix();
  let imagePath = null;
  let registered = false;

  try {
    const keyword = extractCommandBody(message, prefix, command || "spotify");

    if (!keyword) {
      await sendMessageWarningRequest(api, message, {
        caption: `Vui lòng nhập từ khóa tìm kiếm hoặc link Spotify\nVí dụ:\n${prefix}${command} Sơn Tùng hoặc ${prefix}${command} <link Spotify>`,
      }, 30000);
      return;
    }

    const spotifyMatch = keyword.match(/https?:\/\/(?:open\.|play\.)?spotify\.com\/[^\s]+|https?:\/\/spotify\.link\/[^\s]+/i);
    if (spotifyMatch) {
      const modifiedMessage = {
        ...message,
        data: {
          ...message.data,
          content: `${prefix}${command} ${spotifyMatch[0]}`,
        },
      };
      await handleSpotifyDownloadCommand(api, modifiedMessage, command);
      return;
    }

    const tracks = await searchSpotify(keyword);
    if (!tracks || tracks.length === 0) {
      await sendMessageWarningRequest(api, message, {
        caption: `Không tìm được bài hát phù hợp với từ khóa: "${keyword}". Hãy thử từ khóa khác!`,
      }, 30000);
      return;
    }

    if (tracks.length === 1) {
      await processAndSendSpotifyMedia(api, message, {
        selectedMedia: tracks[0],
        mediaType: "spotify",
        uniqueId: sanitizeFilename(tracks[0].id || tracks[0].title),
        duration: tracks[0].duration || 0,
        title: tracks[0].title,
        author: tracks[0].artist,
        senderId,
        senderName: message.data.dName,
      });
      return;
    }

    imagePath = await createSearchResultImage(
      tracks.map((track) => ({
        title: track.title || "No title",
        artistsNames: track.artist || "Unknown Artist",
        thumbnailM: track.thumbnail || DEFAULT_SPOTIFY_THUMBNAIL,
        listen: track.listen || 0,
        like: track.like || 0,
        comment: track.comment || 0,
      }))
    );

    const listCaption = `Đây là danh sách bài hát tìm thấy trên Spotify:\nHãy trả lời tin nhắn này HOẶC gửi trực tiếp số thứ tự bài hát bạn muốn nghe!`;
    const listMessage = await sendMessageCompleteRequest(api, message, {
      caption: listCaption,
      imagePath,
    }, TIME_WAIT_SELECTION);

    const quotedMsgId = listMessage?.message?.msgId || listMessage?.attachment?.[0]?.msgId;
    if (!quotedMsgId) {
      await sendMessageWarningRequest(api, message, {
        caption: `Lỗi hệ thống: Không thể tạo danh sách bài hát. Vui lòng thử lại.`,
      }, 30000);
      return;
    }

    const ownedPaths = imagePath ? [imagePath] : [];
    registered = true;
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
      resendPrompt: async () =>
        sendMessageCompleteRequest(api, message, {
          caption: listCaption,
          imagePath: ownedPaths[0],
        }, TIME_WAIT_SELECTION),
      onSelect: async (media, index, modifier, replyMessage, claim) =>
        consumeSpotifyDownloadSelection(api, replyMessage, {
          media,
          uniqueId: sanitizeFilename(media.id || media.title || `spotify_${Date.now()}`),
          fallbackTitle: media.title || "Unknown Title",
          fallbackAuthor: media.artist || "Unknown Artist",
          fallbackDuration: media.duration || 0,
          claim,
        }),
    });
  } catch (error) {
    await sendMessageWarningRequest(api, message, {
      caption: `Đã xảy ra lỗi khi tìm kiếm bài hát Spotify: ${error.message}. Vui lòng thử lại sau.`,
    }, 30000);
  } finally {
    if (imagePath && !registered) await deleteFile(imagePath).catch(() => {});
  }
}
