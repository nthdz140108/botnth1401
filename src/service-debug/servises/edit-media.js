import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";
import { sendMessageWarningRequest } from "../chat-zalo/chat-style/chat-style.js";
import { checkExstentionFileRemote, downloadFile, deleteFile } from "../../utils/util.js";
import { tempDir } from "../../utils/io-json.js";
import { getFfmpegExecutableSync } from "../../utils/runtime-dependencies.js";
import { getGlobalPrefix } from "../service.js";
import { removeMention } from "../../utils/format-util.js";
import { uploadAudioFile } from "../chat-zalo/chat-special/send-voice/process-audio.js";
import { sendVoiceMusic } from "../chat-zalo/chat-special/send-voice/send-voice.js";

const execFileAsync = promisify(execFile);
const ALLOWED_AUDIO_EXTENSIONS = ["mp3", "wav", "aac", "m4a"];
const ALLOWED_VIDEO_EXTENSIONS = ["mp4", "mkv", "avi", "mov"];

export function normalizeMediaExtension(rawExt) {
    return String(rawExt ?? "").trim().replace(/^\./, "").toLowerCase();
}

function parseTimestampSeconds(timeStr) {
    const parts = String(timeStr ?? "").split(":").map(Number);
    if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
        return NaN;
    }
    return parts[0] * 60 + parts[1];
}

function extractFileUrl(message) {
    const quote = message.data?.quote || message.reply_message;
    if (!quote) return null;

    try {
        const attachData = typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
        const candidate =
            attachData?.hdUrl ||
            attachData?.href ||
            attachData?.oriUrl ||
            attachData?.normalUrl ||
            quote.href ||
            null;
        return typeof candidate === "string" ? candidate.trim() || null : null;
    } catch (error) {
        console.error("Lỗi khi parse dữ liệu attach:", error);
        return null;
    }
}

async function cutAudio(inputPath, outputPath, startTime, endTime, fadeDuration, speed) {
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    const endSec = parseTimestampSeconds(endTime);
    const startSec = parseTimestampSeconds(startTime);
    const clipLen = Number.isFinite(endSec) && Number.isFinite(startSec) ? Math.max(0, endSec - startSec) : 0;
    const fadeIn = fadeDuration ? `afade=t=in:ss=0:d=${fadeDuration}` : "";
    const fadeOut =
        fadeDuration && clipLen > fadeDuration
            ? `afade=t=out:st=${Math.max(0, clipLen - fadeDuration)}:d=${fadeDuration}`
            : "";
    const fadeFilter = [fadeIn, fadeOut].filter(Boolean).join(",");
    const speedFilter = speed ? `atempo=${speed}` : "";
    const filter = [fadeFilter, speedFilter].filter(Boolean).join(",");

    const args = ["-y", "-i", inputPath, "-ss", String(startTime), "-to", String(endTime)];
    if (filter) {
        args.push("-af", filter);
    }
    args.push(outputPath);

    await execFileAsync(ffmpegBin, args, { timeout: 60000 });
    return outputPath;
}

async function cutVideo(inputPath, outputPath, startTime, endTime, speed) {
    const ffmpegBin = getFfmpegExecutableSync() || "ffmpeg";
    const speedFilter = speed ? `setpts=${1 / speed}*PTS` : "";
    const args = ["-y", "-i", inputPath, "-ss", String(startTime), "-to", String(endTime)];
    if (speedFilter) {
        args.push("-vf", speedFilter);
    } else {
        args.push("-c", "copy");
    }
    args.push(outputPath);

    await execFileAsync(ffmpegBin, args, { timeout: 60000 });
    return outputPath;
}

export async function processEditAudioCommand(api, message, aliasCommand) {
    let inputPath = null;
    let outputPath = null;
    try {
        const prefix = getGlobalPrefix();
        const content = removeMention(message).replace(`${prefix}${aliasCommand}`, "").trim();
        const fileUrl = extractFileUrl(message);
        const ext = fileUrl ? normalizeMediaExtension(await checkExstentionFileRemote(fileUrl)) : "";

        if (!fileUrl || !ALLOWED_AUDIO_EXTENSIONS.includes(ext)) {
            await sendMessageWarningRequest(api, message, { caption: "Bạn cần reply vào một file audio hợp lệ để cắt!" }, 30000);
            return;
        }

        const match = content.match(/(\d{1,2}:\d{2}) (\d{1,2}:\d{2})(?: -v (\d+))?(?: x([0-9.]+))?/);
        if (!match) {
            await sendMessageWarningRequest(api, message, { caption: `Sai cú pháp! Vui lòng dùng: ${prefix}${aliasCommand} <bắt đầu> <kết thúc> [-v giây] [x tốc độ]` }, 30000);
            return;
        }
        const startTime = match[1];
        const endTime = match[2];
        const fadeDuration = match[3] ? parseInt(match[3], 10) : null;
        const speed = match[4] ? parseFloat(match[4]) : null;

        await fs.promises.mkdir(tempDir, { recursive: true });
        const jobId = randomUUID();
        inputPath = path.join(tempDir, `cuta_in_${jobId}.${ext}`);
        outputPath = path.join(tempDir, `cuta_out_${jobId}.mp3`);
        await downloadFile(fileUrl, inputPath);
        await cutAudio(inputPath, outputPath, startTime, endTime, fadeDuration, speed);

        const uploadedFileUrl = await uploadAudioFile(outputPath, api, message);
        if (uploadedFileUrl) {
            await sendVoiceMusic(api, message, { voiceUrl: uploadedFileUrl, caption: `Đây là voice sau khi cắt từ đoạn ${startTime} tới ${endTime}` }, 1800000);
        } else {
            throw new Error("Upload audio thất bại.");
        }
    } catch (error) {
        console.error("Lỗi xử lý lệnh edit audio:", error);
        await sendMessageWarningRequest(api, message, { caption: `Đã xảy ra lỗi khi cắt audio: ${error.message}` }, 30000);
    } finally {
        if (inputPath) await deleteFile(inputPath).catch(() => {});
        if (outputPath) await deleteFile(outputPath).catch(() => {});
    }
}

export async function processEditVideoCommand(api, message, aliasCommand) {
    let inputPath = null;
    let outputPath = null;
    try {
        const prefix = getGlobalPrefix();
        const content = removeMention(message).replace(`${prefix}${aliasCommand}`, "").trim();
        const fileUrl = extractFileUrl(message);
        const ext = fileUrl ? normalizeMediaExtension(await checkExstentionFileRemote(fileUrl)) : "";

        if (!fileUrl || !ALLOWED_VIDEO_EXTENSIONS.includes(ext)) {
            await sendMessageWarningRequest(api, message, { caption: "Bạn cần reply vào một video hợp lệ để cắt!" }, 30000);
            return;
        }

        const match = content.match(/(\d{1,2}:\d{2}) (\d{1,2}:\d{2})(?: x([0-9.]+))?/);
        if (!match) {
            await sendMessageWarningRequest(api, message, { caption: `Sai cú pháp! Vui lòng dùng: ${prefix}${aliasCommand} <bắt đầu> <kết thúc> [x tốc độ]` }, 30000);
            return;
        }
        const startTime = match[1];
        const endTime = match[2];
        const speed = match[3] ? parseFloat(match[3]) : null;

        await fs.promises.mkdir(tempDir, { recursive: true });
        const jobId = randomUUID();
        inputPath = path.join(tempDir, `cutv_in_${jobId}.${ext}`);
        outputPath = path.join(tempDir, `cutv_out_${jobId}.mp4`);
        await downloadFile(fileUrl, inputPath);
        await cutVideo(inputPath, outputPath, startTime, endTime, speed);

        const uploadResult = await api.uploadAttachment([outputPath], message.threadId, message.type);
        if (uploadResult && uploadResult.length > 0) {
            const videoUrl = uploadResult[0].fileUrl || uploadResult[0].normalUrl;
            await api.sendVideo({
                videoUrl,
                threadId: message.threadId,
                threadType: message.type,
                message: { text: `Đây là video sau khi cắt từ đoạn ${startTime} tới ${endTime}` },
                ttl: 600000
            });
        } else {
            throw new Error("Upload video thất bại.");
        }
    } catch (error) {
        console.error("Lỗi xử lý lệnh edit video:", error);
        await sendMessageWarningRequest(api, message, { caption: `Đã xảy ra lỗi khi cắt video: ${error.message}` }, 30000);
    } finally {
        if (inputPath) await deleteFile(inputPath).catch(() => {});
        if (outputPath) await deleteFile(outputPath).catch(() => {});
    }
}
