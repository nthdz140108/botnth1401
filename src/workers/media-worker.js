import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getFfmpegExecutableSync, getFfprobeExecutableSync } from "../utils/runtime-dependencies.js";

const execFileAsync = promisify(execFile);

export async function processMediaTask(type, payload = {}) {
  const ffmpeg = getFfmpegExecutableSync();

  if (type === "extractFrame") {
    const { videoPath, outputPath, timestampSeconds = 0 } = payload;
    if (!ffmpeg) throw new Error("FFmpeg not available");
    await execFileAsync(ffmpeg, [
      "-ss",
      String(timestampSeconds),
      "-i",
      videoPath,
      "-vframes",
      "1",
      "-y",
      outputPath,
    ]);
    return { outputPath };
  }

  if (type === "convertWebp") {
    const { inputPath, outputPath } = payload;
    if (!ffmpeg) throw new Error("FFmpeg not available");
    await execFileAsync(ffmpeg, [
      "-i",
      inputPath,
      "-vf",
      "select=eq(n\\,0)",
      "-vframes",
      "1",
      "-y",
      outputPath,
    ]);
    return { outputPath };
  }

  if (type === "probeDuration") {
    const { videoPath } = payload;
    const ffprobe = getFfprobeExecutableSync();
    if (!videoPath || !ffprobe) {
      return { duration: 0, videoPath };
    }
    try {
      const { stdout } = await execFileAsync(ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        videoPath,
      ]);
      const parsed = parseFloat(String(stdout || "").trim());
      return { duration: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0, videoPath };
    } catch {
      return { duration: 0, videoPath };
    }
  }

  throw new Error(`Unknown media worker task type: ${type}`);
}

// Support execution as standalone child process via IPC
if (process.send) {
  process.on("disconnect", () => {
    process.exit(0);
  });
  process.on("message", async (msg) => {
    const { taskId, type } = msg || {};
    const payload = msg?.payload ?? msg?.data ?? {};
    try {
      const result = await processMediaTask(type, payload);
      process.send({ taskId, success: true, result });
    } catch (err) {
      process.send({ taskId, success: false, error: err?.message || String(err) });
    }
  });
}
