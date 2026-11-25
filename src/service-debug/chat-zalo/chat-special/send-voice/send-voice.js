import gtts from "gtts";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import axios from "axios";
import googleTTS from "google-tts-api";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getGlobalPrefix } from "../../../service.js";
import {
  convertToM4A,
  downloadAudio,
  extractAudioFromVideo,
  uploadAudioFile,
} from "./process-audio.js";
import {
  sendMessageCompleteRequest,
  sendMessageFailed,
  sendMessageFromSQL,
  sendMessageImageNotQuote,
  sendMessageStateQuote,
} from "../../chat-style/chat-style.js";
import { checkExstentionFileRemote, deleteFile, downloadFile } from "../../../../utils/util.js";
import { getFfmpegExecutableSync } from "../../../../utils/runtime-dependencies.js";
import { resolveExecutableSync, projectRoot } from "../../../../platform/index.js";
import { tempDir } from "../../../../utils/io-json.js";
import { removeMention } from "../../../../utils/format-util.js";
import { createMusicCard } from "../../../../utils/canvas/music-canvas.js";
import { getUserInfoData } from "../../../info-service/user-info.js";
import {
  extractCommandBody,
  getQuoteData,
  safeThreadType,
} from "../../../../commands/shared/command-input-utils.js";
import { validateSafeRemoteResourceUrl } from "../../../utilities/download-resource.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const execFileAsync = promisify(execFile);

const AUDIO_EXTENSIONS = new Set(["aac", "m4a", "mp3", "wav", "ogg", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv", "m4v", "3gp"]);

function resolveYtDlpExecutableSync() {
  const exeName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const runtimeBin = path.join(projectRoot, ".runtime", "bin", exeName);
  const bundledNpmBin = path.join(projectRoot, "node_modules", "youtube-dl-exec", "bin", exeName);
  return resolveExecutableSync(
    [
      process.env.YTDLP_BIN,
      process.env.YT_DLP_BIN,
      runtimeBin,
      bundledNpmBin,
      "yt-dlp",
    ].filter(Boolean),
    { probeArgs: ["--version"] },
  );
}

function buildConcatArgs(audioPaths, outputPath) {
  return [
    "-y",
    ...audioPaths.flatMap((filePath) => ["-i", filePath]),
    "-filter_complex",
    `concat=n=${audioPaths.length}:v=0:a=1[out]`,
    "-map",
    "[out]",
    "-c:a",
    "libmp3lame",
    "-q:a",
    "2",
    outputPath,
  ];
}

async function runFfmpegConcat(audioPaths, outputPath) {
  const ffmpegBinary = getFfmpegExecutableSync();
  if (!ffmpegBinary) {
    throw new Error("FFmpeg không được cài đặt hoặc không thể truy cập");
  }
  await execFileAsync(ffmpegBinary, buildConcatArgs(audioPaths, outputPath), {
    timeout: 30000,
    windowsHide: true,
  });
}

async function textToSpeech(text, api, message, lang = "vi") {
  fs.mkdirSync(tempDir, { recursive: true });
  return new Promise((resolve, reject) => {
    try {
      const tts = new gtts(text, lang);
      const fileName = `voice_${randomUUID()}.mp3`;
      const filePath = path.join(tempDir, fileName);

      tts.save(filePath, async (err) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const voiceUrl = await uploadAudioFile(filePath, api, message);
          resolve(voiceUrl);
        } catch (error) {
          reject(error);
        } finally {
          await deleteFile(filePath);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Nhận diện ngôn ngữ từ text dựa trên bộ ký tự
 */
function detectLanguage(text) {
  const patterns = {
    vi: /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i,
    zh: /[\u4E00-\u9FFF]/,
    ja: /[\u3040-\u309F\u30A0-\u30FF]/,
    ko: /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/,
  };

  const counts = {
    vi: (text.match(patterns.vi) || []).length,
    zh: (text.match(patterns.zh) || []).length,
    ja: (text.match(patterns.ja) || []).length,
    ko: (text.match(patterns.ko) || []).length,
  };

  const maxLang = Object.entries(counts).reduce(
    (max, [lang, count]) => {
      return count > max.count ? { lang, count } : max;
    },
    { lang: "vi", count: 0 },
  );

  if (maxLang.count === 0 && /^[\x00-\x7F]*$/.test(text)) {
    return "vi";
  }

  return maxLang.count > 0 ? maxLang.lang : "vi";
}

/**
 * Tách văn bản thành các phần theo ngôn ngữ
 */
function splitByLanguage(text) {
  const words = text.split(" ");
  const parts = [];
  let currentPart = {
    text: words[0],
    lang: detectLanguage(words[0]),
  };

  for (let i = 1; i < words.length; i += 1) {
    const word = words[i];
    const lang = detectLanguage(word);

    if (lang === currentPart.lang) {
      currentPart.text += " " + word;
    } else {
      parts.push(currentPart);
      currentPart = {
        text: word,
        lang,
      };
    }
  }
  parts.push(currentPart);
  return parts;
}

/**
 * Ép các từ lặp liên tiếp thành nhịp đọc tự nhiên hơn cho TTS.
 * Ví dụ: "hưng hưng hưng" -> "hưng, hưng, hưng"
 * Không động vào kiểu kéo dài ký tự như "hmmmm".
 */
function emphasizeRepeatedWords(text) {
  const tokens = text.split(/(\s+)/);
  const output = [];

  for (const token of tokens) {
    if (!token.trim()) {
      output.push(token);
      continue;
    }

    const previousWord =
      output.length > 0
        ? output[output.length - 1].replace(/[,\.\!\?\:\;]+$/g, "").trim()
        : "";
    if (previousWord && previousWord.toLowerCase() === token.toLowerCase()) {
      output.push(", ", token);
      continue;
    }

    output.push(token);
  }

  return output.join("").replace(/\s+,/g, ",").replace(/,\s+/g, ", ");
}

/**
 * Ghép các file audio
 */
async function concatenateAudios(audioPaths) {
  const outputPath = path.join(tempDir, `combined_${randomUUID()}.mp3`);
  await runFfmpegConcat(audioPaths, outputPath);
  return outputPath;
}

/**
 * Chuyển văn bản đa ngôn ngữ thành giọng nói.
 * Nếu môi trường thiếu FFmpeg, trả về mảng URL của từng phân đoạn để gửi tuần tự.
 */
async function multilingualTextToSpeech(text, api, message) {
  let finalAudioPath = null;
  const audioFiles = [];
  try {
    const normalizedText = emphasizeRepeatedWords(text);
    const parts = splitByLanguage(normalizedText);

    if (parts.length === 1) {
      return await textToSpeech(parts[0].text, api, message, parts[0].lang);
    }

    fs.mkdirSync(tempDir, { recursive: true });
    for (const part of parts) {
      if (!part.text || !part.text.trim()) continue;
      const fileName = `voice_${randomUUID()}_${part.lang}.mp3`;
      const filePath = path.join(tempDir, fileName);

      const tts = new gtts(part.text, part.lang);
      await new Promise((resolve, reject) => {
        tts.save(filePath, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      audioFiles.push(filePath);
    }

    if (audioFiles.length === 0) return null;
    if (audioFiles.length === 1) {
      return await uploadAudioFile(audioFiles[0], api, message);
    }

    const ffmpegBinary = getFfmpegExecutableSync();
    if (ffmpegBinary) {
      try {
        finalAudioPath = await concatenateAudios(audioFiles);
        return await uploadAudioFile(finalAudioPath, api, message);
      } catch (concatErr) {
        console.warn("[voice] Không thể nối bằng FFmpeg, chuyển sang gửi tuần tự từng đoạn:", concatErr.message);
      }
    }

    const segmentUrls = [];
    for (const segmentPath of audioFiles) {
      const segUrl = await uploadAudioFile(segmentPath, api, message);
      if (segUrl) segmentUrls.push(segUrl);
    }
    return segmentUrls;
  } catch (error) {
    console.error("Lỗi khi xử lý audio đa ngôn ngữ:", error);
    throw error;
  } finally {
    await Promise.all(audioFiles.map((file) => deleteFile(file)));
    if (finalAudioPath) {
      await deleteFile(finalAudioPath);
    }
  }
}

/**
 * Chia văn bản nhiều dòng an toàn (<= maxLen ký tự) theo câu/từ bằng [\s\S],
 * tuyệt đối không trả về null khi gặp ký tự xuống dòng \n.
 */
export function splitTextIntoTtsChunks(rawText, maxLen = 200) {
  const normalized = String(rawText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\s\S]/g, (ch) => (ch === "\n" ? ". " : ch))
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return [];

  const sentences = normalized.split(/(?<=[.!?;:])\s+/).filter(Boolean);
  const chunks = [];
  let current = "";

  const pushLongPiece = (piece) => {
    const words = piece.split(/\s+/).filter(Boolean);
    let wordBuf = "";
    for (const word of words) {
      if (Array.from(word).length > maxLen) {
        if (wordBuf) {
          chunks.push(wordBuf);
          wordBuf = "";
        }
        const chars = Array.from(word);
        for (let idx = 0; idx < chars.length; idx += maxLen) {
          chunks.push(chars.slice(idx, idx + maxLen).join(""));
        }
        continue;
      }
      const nextWordBuf = wordBuf ? `${wordBuf} ${word}` : word;
      if (Array.from(nextWordBuf).length <= maxLen) {
        wordBuf = nextWordBuf;
      } else {
        if (wordBuf) chunks.push(wordBuf);
        wordBuf = word;
      }
    }
    if (wordBuf) chunks.push(wordBuf);
  };

  for (const sentence of sentences) {
    if (Array.from(sentence).length > maxLen) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      pushLongPiece(sentence);
      continue;
    }

    const combined = current ? `${current} ${sentence}` : sentence;
    if (Array.from(combined).length <= maxLen) {
      current = combined;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

/**
 * Chuẩn hóa văn bản truyện cười trên RAM (xóa chữ Wink thừa và sửa lỗi viết hoa chữ Không giữa câu),
 * KHÔNG chỉnh sửa file z_truyencuoi.txt trên đĩa.
 */
export function normalizeStoryText(rawStory) {
  const unescaped = String(rawStory ?? "").replaceAll("\\n", "\n");
  const withoutWink = unescaped
    .replace(/[ \t]*\bWink\b[ \t]*/gi, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  const lines = withoutWink.split("\n");
  return lines
    .map((line, index) => {
      // Giữ nguyên dòng tiêu đề "Truyện: ..."
      if (index === 0 && /^\s*Truyện\s*:/i.test(line)) {
        return line.trim();
      }
      // Hạ chữ "Không" viết hoa nhầm ở giữa câu (sau chữ cái/chữ số/dấu phẩy/ngoặc đóng)
      return line
        .replace(/([\p{L}\p{N},;)\]])(\s+)Không\b/gu, "$1$2không")
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd();
    })
    .join("\n")
    .trim();
}

/**
 * Xử lý lệnh chuyển văn bản thành giọng nói
 */
export async function handleVoiceCommand(api, message, command = "voice") {
  const threadType = safeThreadType(message);
  try {
    const prefix = getGlobalPrefix();
    const cmdName = command || "voice";
    let text = extractCommandBody(message, prefix, cmdName);

    const quote = getQuoteData(message);
    if (quote && !text) {
      text = quote.msg || quote.content || null;
      if (!text && quote.attach) {
        try {
          const parseMessage =
            typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
          text = parseMessage?.description || parseMessage?.title || null;
        } catch {}
      }
    }

    if (!text || !String(text).trim()) {
      await api.sendMessage(
        {
          msg: `Vui lòng nhập nội dung cần chuyển thành giọng nói.\nVí dụ:\n${prefix}${cmdName} Xin chào mọi người`,
          quote: message,
          ttl: 600000,
        },
        message.threadId,
        threadType,
      );
      return;
    }

    const voiceResult = await multilingualTextToSpeech(String(text).trim(), api, message);
    const voiceUrls = (Array.isArray(voiceResult) ? voiceResult : [voiceResult]).filter(Boolean);

    if (voiceUrls.length === 0) {
      throw new Error("Không thể tạo file âm thanh");
    }

    for (const url of voiceUrls) {
      await api.sendVoice(message, url, 600000);
    }
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh voice:", error);
    await api.sendMessage(
      {
        msg: "Đã xảy ra lỗi khi chuyển văn bản thành giọng nói. Vui lòng thử lại sau.",
        quote: message,
        ttl: 600000,
      },
      message.threadId,
      threadType,
    );
  }
}

export async function handleStoryCommand(api, message) {
  const threadType = safeThreadType(message);
  try {
    const storyFilePath = path.join(__dirname, "z_truyencuoi.txt");
    const stories = fs
      .readFileSync(storyFilePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());

    const rawStory = stories[Math.floor(Math.random() * stories.length)];
    if (!rawStory) {
      throw new Error("Không tìm thấy truyện cười");
    }

    const randomStory = normalizeStoryText(rawStory);
    const voiceUrl = await textToSpeech(randomStory, api, message);

    if (!voiceUrl) {
      throw new Error("Không thể tạo file âm thanh");
    }

    await Promise.all([
      api.sendVoice(message, voiceUrl, 600000),
      api.sendMessage(
        {
          msg: randomStory,
          quote: message,
          ttl: 600000,
        },
        message.threadId,
        threadType,
      ),
    ]);
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh story:", error);
    await api.sendMessage(
      {
        msg: "Đã xảy ra lỗi khi đọc truyện cười. Vui lòng thử lại sau.",
        quote: message,
        ttl: 600000,
      },
      message.threadId,
      threadType,
    );
  }
}

export async function handleTarrotCommand(api, message) {
  const threadType = safeThreadType(message);
  try {
    const tarotFilePath = path.join(__dirname, "z_tarot.txt");
    const tarots = fs
      .readFileSync(tarotFilePath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim());

    const randomTarot = tarots[Math.floor(Math.random() * tarots.length)];
    if (!randomTarot) {
      throw new Error("Không tìm thấy Tarot");
    }

    const displayTarot = randomTarot.replaceAll("\\n", "\n");
    const tarotText = displayTarot
      .replaceAll("♠", "Bích")
      .replaceAll("♥", "Cơ")
      .replaceAll("♣", "Chuồn")
      .replaceAll("♦", "Rô");
    const voiceUrl = await textToSpeech(tarotText, api, message);

    const tasks = [
      api.sendMessage(
        { msg: displayTarot, quote: message, ttl: 600000 },
        message.threadId,
        threadType,
      ),
    ];
    if (voiceUrl) {
      tasks.push(api.sendVoice(message, voiceUrl, 600000));
    }
    await Promise.all(tasks);
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh Tarot:", error);
    await api.sendMessage(
      {
        msg: "Đã xảy ra lỗi khi đọc Tarot. Vui lòng thử lại sau.",
        quote: message,
        ttl: 600000,
      },
      message.threadId,
      threadType,
    );
  }
}

export async function sendVoiceMusic(api, message, object, ttl, { throwOnError = false } = {}) {
  const thumbnailPath = path.resolve(tempDir, `${randomUUID()}.jpg`);
  const voiceUrl = object.voiceUrl;
  if (!voiceUrl) {
    if (throwOnError) {
      throw Object.assign(new Error("Missing uploaded audio URL"), { stage: "upload" });
    }
    sendMessageFailed(api, message, "Upload file nhạc thất bại!", true);
    return;
  }

  try {
    if (message?.data?.uidFrom) {
      const senderId = message.data.uidFrom;
      const userInfo = await getUserInfoData(api, senderId);
      object.userAvatar = userInfo.avatar;
    }
  } catch (error) {
    console.error("Lỗi khi lấy thông tin người dùng:", error);
  }

  let imagePath = null;
  try {
    if (object.imageUrl) {
      fs.mkdirSync(tempDir, { recursive: true });
      await downloadFile(object.imageUrl, thumbnailPath);
      try {
        object.thumbnailPath = thumbnailPath;
        imagePath = await createMusicCard(object);
      } catch (error) {
        console.error("Lỗi khi tạo music card:", error);
        imagePath = null;
      }
    }

    await sendMessageCompleteRequest(api, message, object, 180000);
    if (imagePath) {
      await api.sendMessage(
        {
          msg: "",
          attachments: [imagePath],
          ttl,
        },
        message.threadId,
        safeThreadType(message),
      );
    }
    await api.sendVoice(message, voiceUrl, ttl);
  } catch (error) {
    if (throwOnError) throw Object.assign(error, { stage: error.stage || "send" });
    console.error("Lỗi khi gửi voice music:", error);
  } finally {
    await deleteFile(thumbnailPath);
    if (imagePath && imagePath !== thumbnailPath) await deleteFile(imagePath);
  }
}

export async function sendVoiceMusicNotQuote(api, message, object, ttl) {
  const thumbnailPath = path.resolve(tempDir, `${randomUUID()}.jpg`);
  let imagePath = null;
  try {
    const voiceUrl = object.voiceUrl;
    if (!voiceUrl) return;
    if (object.imageUrl) {
      fs.mkdirSync(tempDir, { recursive: true });
      await downloadFile(object.imageUrl, thumbnailPath);
      try {
        object.thumbnailPath = thumbnailPath;
        imagePath = await createMusicCard(object);
      } catch (error) {
        console.error("Lỗi khi tạo music card:", error);
        imagePath = null;
      }
    }

    const result = {
      message: object.caption,
      success: true,
    };

    await sendMessageImageNotQuote(api, result, message.threadId, imagePath, ttl, false);
    await api.sendVoice(message, voiceUrl, ttl);
  } catch (error) {
    console.error("Lỗi khi gửi voice music:", error);
  } finally {
    await deleteFile(thumbnailPath);
    if (imagePath && imagePath !== thumbnailPath) await deleteFile(imagePath);
  }
}

async function extractVoiceFromRemoteUrl(rawUrl, api, message) {
  const safeUrl = await validateSafeRemoteResourceUrl(rawUrl);
  let urlExt = "";
  try {
    urlExt = path.extname(new URL(safeUrl).pathname).replace(/^\./, "").toLowerCase();
  } catch {}

  if (!urlExt) {
    urlExt = String((await checkExstentionFileRemote(safeUrl)) || "")
      .replace(/^\./, "")
      .toLowerCase();
  }

  if (AUDIO_EXTENSIONS.has(urlExt)) {
    return await downloadAudio(safeUrl, api, message);
  }

  if (VIDEO_EXTENSIONS.has(urlExt)) {
    return await extractAudioFromVideo(safeUrl, api, message);
  }

  // Hỗ trợ trích xuất âm thanh từ link nền tảng (YouTube/TikTok/SoundCloud/FB...) qua yt-dlp
  const ytDlpBin = resolveYtDlpExecutableSync();
  if (!ytDlpBin) {
    return await extractAudioFromVideo(safeUrl, api, message);
  }

  fs.mkdirSync(tempDir, { recursive: true });
  const jobId = randomUUID();
  const outputTemplate = path.join(tempDir, `getvoice_ytdlp_${jobId}.%(ext)s`);
  const ffmpegBin = getFfmpegExecutableSync();

  const ytArgs = [
    "--no-playlist",
    "--max-filesize",
    "50M",
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
    "-o",
    outputTemplate,
  ];
  if (ffmpegBin) {
    ytArgs.push("--ffmpeg-location", ffmpegBin, "-x", "--audio-format", "m4a");
  }
  ytArgs.push(safeUrl);

  const createdFiles = () =>
    fs
      .readdirSync(tempDir)
      .filter((f) => f.startsWith(`getvoice_ytdlp_${jobId}.`))
      .map((f) => path.join(tempDir, f));

  let convertedM4a = null;
  try {
    await execFileAsync(ytDlpBin, ytArgs, {
      timeout: 90000,
      windowsHide: true,
    });

    const matches = createdFiles();
    if (matches.length === 0) {
      throw new Error("Không tải được dữ liệu âm thanh từ liên kết.");
    }

    let uploadTarget = matches[0];
    const downloadedExt = path.extname(uploadTarget).replace(/^\./, "").toLowerCase();
    if (!AUDIO_EXTENSIONS.has(downloadedExt) && ffmpegBin) {
      convertedM4a = path.join(tempDir, `getvoice_conv_${jobId}.m4a`);
      await execFileAsync(
        ffmpegBin,
        ["-y", "-i", uploadTarget, "-vn", "-c:a", "aac", "-q:a", "2", convertedM4a],
        { timeout: 45000, windowsHide: true },
      );
      uploadTarget = convertedM4a;
    }

    return await uploadAudioFile(uploadTarget, api, message);
  } finally {
    for (const file of createdFiles()) {
      await deleteFile(file).catch(() => {});
    }
    if (convertedM4a) {
      await deleteFile(convertedM4a).catch(() => {});
    }
  }
}

export async function handleGetVoiceCommand(api, message, aliasCommand = "getvoice") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const quote = getQuoteData(message);
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "getvoice";

  let keyContent = extractCommandBody(message, prefix, cmdName);
  let voiceUrl = null;
  let videoUrl = null;
  let isTextToSpeech = false;

  // 1. Kiểm tra nếu tin nhắn được reply có chứa file hoặc văn bản
  if (quote) {
    try {
      const attachData = quote.attach
        ? typeof quote.attach === "string"
          ? JSON.parse(quote.attach)
          : quote.attach
        : null;
      const rawHref =
        attachData?.hdUrl ||
        attachData?.href ||
        attachData?.oriUrl ||
        attachData?.normalUrl ||
        quote.href ||
        "";
      const cleanHref = typeof rawHref === "string" ? rawHref.replace(/\\\//g, "/").trim() : "";

      if (cleanHref) {
        let urlExt = "";
        try {
          urlExt = path.extname(new URL(cleanHref).pathname).replace(/^\./, "").toLowerCase();
        } catch {}

        if (VIDEO_EXTENSIONS.has(urlExt)) {
          videoUrl = cleanHref;
        } else if (AUDIO_EXTENSIONS.has(urlExt)) {
          voiceUrl = cleanHref;
        } else {
          const remoteExt = String((await checkExstentionFileRemote(cleanHref)) || "")
            .replace(/^\./, "")
            .toLowerCase();
          if (VIDEO_EXTENSIONS.has(remoteExt)) {
            videoUrl = cleanHref;
          } else if (AUDIO_EXTENSIONS.has(remoteExt)) {
            voiceUrl = cleanHref;
          }
        }
      }

      if (quote.msg && !videoUrl && !voiceUrl && !keyContent) {
        isTextToSpeech = true;
        keyContent = quote.msg;
      }
    } catch (error) {
      console.error("[getvoice] Lỗi khi xử lý file đính kèm:", error);
    }
  }

  // 2. Nếu không có quote media và đối số là một URL http(s):// -> Tách âm thanh từ link, KHÔNG đọc chuỗi URL!
  if (!quote && !videoUrl && !voiceUrl && /^https?:\/\/\S+$/i.test(keyContent)) {
    try {
      const extractedVoiceUrl = await extractVoiceFromRemoteUrl(keyContent, api, message);
      if (!extractedVoiceUrl) {
        throw new Error("Không trích xuất được URL âm thanh");
      }
      await sendVoiceMusic(
        api,
        message,
        {
          voiceUrl: extractedVoiceUrl,
          caption: "Tách âm thanh từ liên kết thành công!",
        },
        1800000,
      );
      return;
    } catch (error) {
      console.error("[getvoice] Lỗi khi tách âm thanh từ URL:", error?.message || error);
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Không thể tải hoặc tách âm thanh từ liên kết này (${error?.message || "lỗi xử lý media"}).`,
        },
        false,
        30000,
      );
      return;
    }
  }

  // 3. Chuyển văn bản thành giọng nói nếu không phải video/audio
  if (!videoUrl && !voiceUrl && (keyContent || isTextToSpeech)) {
    try {
      const chunks = splitTextIntoTtsChunks(keyContent, 200);
      if (chunks.length === 0) {
        await sendMessageStateQuote(
          api,
          message,
          `Vui lòng nhập nội dung hoặc reply tin nhắn cần chuyển thành giọng nói và dùng lệnh ${prefix}${cmdName}.`,
          false,
          30000,
        );
        return;
      }

      const audioBuffers = [];
      for (const part of chunks) {
        const audioUrl = googleTTS.getAudioUrl(part, {
          lang: "vi",
          slow: false,
          host: "https://translate.google.com",
        });

        const response = await axios({
          method: "GET",
          url: audioUrl,
          responseType: "arraybuffer",
          timeout: 15000,
        });
        audioBuffers.push(Buffer.from(response.data));
      }

      fs.mkdirSync(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, `temp_${randomUUID()}.mp3`);
      fs.writeFileSync(tempFile, Buffer.concat(audioBuffers));

      try {
        const results = await api.uploadAttachment([tempFile], threadId, threadType);
        voiceUrl =
          results?.[0]?.fileUrl || results?.[0]?.hdUrl || results?.[0]?.normalUrl || "";
        if (!voiceUrl) {
          throw new Error("Upload âm thanh TTS thất bại");
        }

        await sendVoiceMusic(
          api,
          message,
          {
            voiceUrl,
            caption: "Chuyển đổi văn bản thành giọng nói thành công!",
          },
          1800000,
        );
      } finally {
        await deleteFile(tempFile).catch(() => {});
      }
      return;
    } catch (error) {
      console.error("[getvoice] Lỗi khi chuyển đổi văn bản thành giọng nói:", error);
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: "Đã xảy ra lỗi khi chuyển đổi văn bản thành giọng nói, vui lòng thử lại.",
        },
        false,
        30000,
      );
      return;
    }
  }

  // 4. Xử lý file voice có sẵn từ quote
  if (voiceUrl) {
    await sendVoiceMusic(api, message, { voiceUrl, caption: "Đã là định dạng Voice!" }, 1800000);
    return;
  }

  // 5. Xử lý file video từ quote
  if (videoUrl) {
    try {
      const extracted = await extractAudioFromVideo(videoUrl, api, message);
      await sendVoiceMusic(
        api,
        message,
        {
          voiceUrl: extracted,
          caption: "Chuyển đổi voice từ video thành công!",
        },
        1800000,
      );
    } catch (error) {
      console.error("[getvoice] Lỗi khi tách âm thanh:", error);
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: "Đã xảy ra lỗi khi tách âm thanh từ video, vui lòng thử lại với video khác.",
        },
        false,
        30000,
      );
    }
    return;
  }

  await sendMessageStateQuote(
    api,
    message,
    `Vui lòng nhập liên kết video, nội dung văn bản hoặc reply video/audio/văn bản hợp lệ và dùng lệnh ${prefix}${cmdName}.`,
    false,
    30000,
  );
}
