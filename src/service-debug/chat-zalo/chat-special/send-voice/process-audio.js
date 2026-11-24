import axios from "axios";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "path";
import fs from "fs";
import { promisify } from "node:util";
import { getFileExtension, getFileSize } from "../../../../api-zalo/utils.js";
import { deleteFile, uploadTempFile } from "../../../../utils/util.js";
import { getFfmpegExecutableSync } from "../../../../utils/runtime-dependencies.js";
import { tempDir } from "../../../../utils/io-json.js";

const execFileAsync = promisify(execFile);

function makeTempPath(prefix, extension) {
  return path.join(tempDir, `${prefix}_${randomUUID()}${extension}`);
}

export function buildFfmpegArgs(inputPath, outputPath) {
  return [
    "-y",
    "-i", inputPath,
    "-vn",
    "-c:a", "aac",
    "-q:a", "2",
    outputPath
  ];
}

async function runFfmpeg(inputPath, outputPath, { execFileImpl = execFileAsync, resolveBinary = getFfmpegExecutableSync } = {}) {
  const ffmpegBinary = resolveBinary();
  if (!ffmpegBinary) {
    throw new Error("Không tìm thấy ffmpeg trong môi trường runtime.");
  }
  const args = buildFfmpegArgs(inputPath, outputPath);
  await execFileImpl(ffmpegBinary, args, { timeout: 30000, windowsHide: true });
}

/**
 * Chuyển đổi file MP3 sang M4A
 */
export async function convertToM4A(inputPath, options = {}) {
  const outputPath = inputPath.replace(".mp3", ".m4a");
  const timeStart = performance.now()
  try {
    await runFfmpeg(inputPath, outputPath, options);
    const timeEnd = performance.now();
    console.log(`Thời gian chuyển đổi sang M4A: ${((timeEnd - timeStart) / 1000).toFixed(2)} s`);
    return outputPath;
  } catch (error) {
    console.error("Lỗi khi chuyển đổi sang M4A:", error);
    throw error;
  }
}

/**
 * Chuyển đổi file MP3 sang AAC
 */
export async function convertToAAC(inputPath, options = {}) {
  const outputPath = inputPath.replace(".mp3", ".aac");
  try {
    await runFfmpeg(inputPath, outputPath, options);
    return outputPath;
  } catch (error) {
    console.error("Lỗi khi chuyển đổi sang AAC:", error);
    throw error;
  }
}

/**
 * Upload file audio và trả về URL
 */
export async function uploadAudioFile(filePath, api, message) {
  try {
    const uploadResult = await api.uploadAttachment([filePath], message.threadId, message.type);
    const voiceFinalUrl = uploadResult[0].fileUrl 
    return voiceFinalUrl;
  } catch (error) {
    throw error;
  }
}


/**
 * Tải Và Chuyển Đổi Âm Thanh Sang Dạng Tương Thích
 */
export async function downloadAndConvertAudio(url, api, message) {
  const mp3Path = makeTempPath("temp", ".mp3");

  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
      timeout: 20000,
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(mp3Path);
      response.data.on("error", reject);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const voiceFinalUrl = await uploadAudioFile(mp3Path, api, message);

    return voiceFinalUrl;
  } catch (error) {
    throw error;
  } finally {
    await deleteFile(mp3Path);
  }
}

/**
 * Download Audio không chuyển đổi
 */
export async function downloadAudio(url, api, message) {
  const filePath = makeTempPath("temp", ".mp3");

  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
      timeout: 20000,
    });

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(filePath);
      response.data.on("error", reject);
      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    const voiceFinalUrl = await uploadAudioFile(filePath, api, message);

    return voiceFinalUrl;
  } catch (error) {
    throw error;
  } finally {
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  }
}


/**
 * Tách âm thanh từ video và chuyển đổi sang định dạng audio
 * @param {string|Buffer} input - URL video hoặc buffer của video
 * @returns {Promise<string>} URL của file âm thanh đã xử lý
 */
export async function extractAudioFromVideo(input, api, message, options = {}) {
  // const timeStart = performance.now();
  const tempVideoPath = makeTempPath("temp_video", ".mp4");
  const tempAudioPath = makeTempPath("temp_audio", ".aac");

  try {
    if (typeof input === 'string') {
      const response = await axios({
        url: input,
        method: 'GET',
        responseType: 'stream',
        timeout: 20000,
      });
      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tempVideoPath);
        response.data.on('error', reject);
        response.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } else {
      await fs.promises.writeFile(tempVideoPath, input);
    }

    await runFfmpeg(tempVideoPath, tempAudioPath, options);

    const voiceFinalUrl = await uploadAudioFile(tempAudioPath, api, message);

    // const timeEnd = performance.now();
    // console.log(`Thời gian xử lý âm thanh: ${((timeEnd - timeStart) / 1000).toFixed(2)} s`);

    return voiceFinalUrl;

  } catch (error) {
    throw error;
  } finally {
    await Promise.all([
      deleteFile(tempVideoPath),
      deleteFile(tempAudioPath)
    ]);
  }
}
