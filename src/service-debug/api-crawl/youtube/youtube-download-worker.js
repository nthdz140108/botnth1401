import { parentPort, workerData } from "worker_threads";
import { getYoutubeDlExecutor, getYoutubeDlpOptions } from "./youtube-runtime.js";

const ytdlExec = getYoutubeDlExecutor();

async function downloadVideo(videoUrl, videoPath, format) {
  const timeoutMs = workerData.timeoutMs || 300000;
  let timeoutId;
  let settled = false;

  const settle = (payload) => {
    if (settled) return;
    settled = true;
    if (timeoutId) clearTimeout(timeoutId);
    parentPort.postMessage(payload);
  };

  let subprocess = null;
  const killSubprocess = () => {
    try {
      if (subprocess && typeof subprocess.kill === "function") {
        subprocess.kill("SIGKILL");
      }
    } catch {}
  };

  process.once("exit", killSubprocess);

  try {
    let options;
    if (format === "bestaudio[ext=aac]/bestaudio[ext=m4a]/bestaudio" || format?.includes?.("bestaudio")) {
      options = {
        output: videoPath,
        format: "bestaudio[ext=aac]/bestaudio[ext=m4a]/bestaudio/best",
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        bufferSize: "16K",
        addHeader: ["referer:youtube.com"],
        ...getYoutubeDlpOptions({ env: process.env }),
      };
    } else {
      options = {
        output: videoPath,
        format: format,
        mergeOutputFormat: "mp4",
        noCheckCertificates: true,
        noWarnings: true,
        preferFreeFormats: true,
        bufferSize: "16K",
        addHeader: ["referer:youtube.com"],
        ...getYoutubeDlpOptions({ env: process.env }),
      };
    }

    timeoutId = setTimeout(() => {
      killSubprocess();
      settle({ success: false, error: `download worker timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    subprocess = typeof ytdlExec.exec === "function"
      ? ytdlExec.exec(videoUrl, options, { timeout: timeoutMs, windowsHide: true })
      : ytdlExec(videoUrl, options, { timeout: timeoutMs });
    await subprocess;
    settle({ success: true, videoPath });
    
  } catch (error) {
    killSubprocess();
    settle({
      success: false,
      error: error.message
    });
  } finally {
    process.removeListener("exit", killSubprocess);
  }
}

downloadVideo(workerData.videoUrl, workerData.videoPath, workerData.format);
