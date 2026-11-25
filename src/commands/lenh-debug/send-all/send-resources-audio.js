import fs from "node:fs";
import path from "node:path";
import ffmpeg from "fluent-ffmpeg";
import {
  sendMessageCompleteRequest,
  sendMessageFailed,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { getProjectRoot } from "../../../utils/env.js";
import {
  configureFluentFfmpeg,
  getFfmpegExecutableSync,
} from "../../../utils/runtime-dependencies.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../shared/command-input-utils.js";

configureFluentFfmpeg();

const projectRoot = getProjectRoot();
const audioFilePath = path.join(projectRoot, "assets", "resources", "audio");
const convertedCachePath = path.join(audioFilePath, ".converted");
const PLATFORM = "ZaloAudio";
const DIRECT_AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac"]);

function listRegularAudioFiles() {
  if (!fs.existsSync(audioFilePath)) {
    fs.mkdirSync(audioFilePath, { recursive: true });
    return [];
  }
  return fs
    .readdirSync(audioFilePath, { withFileTypes: true })
    .filter((entry) => {
      if (!entry || entry.name.startsWith(".")) return false;
      if (entry.isFile()) return true;
      if (entry.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(audioFilePath, entry.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "vi"));
}

function selectAudioFile(files, keyword) {
  const trimmed = String(keyword || "").trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10) - 1;
    if (index >= 0 && index < files.length) {
      return files[index];
    }
  }

  const lower = trimmed.toLowerCase();
  return (
    files.find((file) => file.toLowerCase() === lower) ||
    files.find((file) => path.parse(file).name.toLowerCase() === lower) ||
    null
  );
}

async function resolveUploadableAudioPath(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  // File .mp3 / .m4a / .aac gửi trực tiếp không bắt buộc đi qua ffmpeg
  if (DIRECT_AUDIO_EXTS.has(ext)) {
    return inputPath;
  }

  fs.mkdirSync(convertedCachePath, { recursive: true });
  const baseName = path.basename(inputPath, ext);
  const cachedMp3Path = path.join(convertedCachePath, `${baseName}.mp3`);
  if (fs.existsSync(cachedMp3Path) && fs.statSync(cachedMp3Path).size > 0) {
    return cachedMp3Path;
  }

  const ffmpegBin = getFfmpegExecutableSync();
  if (!ffmpegBin) {
    throw new Error("Cần cài đặt FFmpeg (npm run setup:media) để chuyển đổi định dạng audio này.");
  }

  await new Promise((resolve, reject) => {
    configureFluentFfmpeg();
    const cmd = ffmpeg(inputPath);
    cmd.setFfmpegPath(ffmpegBin);
    cmd
      .toFormat("mp3")
      .on("end", resolve)
      .on("error", reject)
      .save(cachedMp3Path);
  });

  return cachedMp3Path;
}

export async function handleSendAudio(api, message, aliasCommand = "sendresourcesaudio") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "sendresourcesaudio";
  const keyword = extractCommandBody(message, prefix, cmdName);
  const files = listRegularAudioFiles();

  if (!keyword) {
    if (files.length === 0) {
      await sendMessageCompleteRequest(
        api,
        message,
        {
          caption:
            `🎵 Kho audio/voice lưu trữ hiện đang trống.\n` +
            `👉 Thêm audio mới bằng lệnh: ${prefix}dlrsrc audio|<tên_audio> (reply voice/audio hoặc kèm link).`,
        },
        60000,
      );
      return;
    }

    const audioList = files.map((file, index) => `${index + 1}. ${path.parse(file).name}`).join("\n");
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption:
          `🎵 Danh sách file audio đã lưu trữ (${files.length}):\n${audioList}\n\n` +
          `👉 Dùng lệnh: ${prefix}${cmdName} <STT hoặc tên file> để gửi audio.`,
      },
      60000,
    );
    return;
  }

  if (files.length === 0) {
    await sendMessageFailed(
      api,
      message,
      `Kho audio đang trống! Hãy nạp audio bằng lệnh ${prefix}dlrsrc audio|<tên_audio>.`,
      false,
    );
    return;
  }

  const audioFile = selectAudioFile(files, keyword);
  if (!audioFile) {
    await sendMessageFailed(
      api,
      message,
      `Không tìm thấy file audio với số thứ tự hoặc tên "${keyword}"! Gõ ${prefix}${cmdName} để xem danh sách.`,
      false,
    );
    return;
  }

  const parsed = path.parse(audioFile);
  const filePath = path.join(audioFilePath, audioFile);
  const nameLocalFile = parsed.name;
  const cacheExt = DIRECT_AUDIO_EXTS.has(parsed.ext.toLowerCase()) ? parsed.ext.toLowerCase() : ".mp3";
  const threadType = safeThreadType(message);

  try {
    // Thông báo trạng thái xử lý TRƯỚC khi convert/upload với TTL 30s
    await sendMessageCompleteRequest(
      api,
      message,
      {
        caption: `📤 Đang xử lý audio: ${nameLocalFile}...`,
      },
      30000,
    );

    const cachedFile = await getCachedMedia(PLATFORM, audioFile, cacheExt, nameLocalFile);
    let voiceUrl = cachedFile?.fileUrl || "";

    if (!voiceUrl) {
      const uploadReadyPath = await resolveUploadableAudioPath(filePath);
      const linkUploadZalo = await api.uploadAttachment(
        [uploadReadyPath],
        message.threadId,
        threadType,
      );
      voiceUrl =
        linkUploadZalo?.[0]?.fileUrl ||
        linkUploadZalo?.[0]?.hdUrl ||
        linkUploadZalo?.[0]?.normalUrl ||
        "";
      if (!voiceUrl) {
        throw new Error("Tải audio lên Zalo thất bại.");
      }

      setCacheData(
        PLATFORM,
        audioFile,
        {
          fileUrl: voiceUrl,
          title: nameLocalFile,
        },
        cacheExt,
      );
    }

    await api.sendVoice(message, voiceUrl, 3600000);
  } catch (error) {
    console.error("[sendresourcesaudio] Lỗi khi gửi audio:", error);
    await sendMessageFailed(
      api,
      message,
      `Có lỗi xảy ra khi gửi audio: ${error?.message || "Không xác định"}`,
      false,
    );
  }
}
