import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";

import { buildYoutubePayloadBase, buildYoutubeProcessingCaption, buildYoutubeVideoCaption, cleanupYoutubeFiles, createYoutubeJobDir, ensureNonEmptyFile, ensureUploadResult, runYoutubeDownload, runYoutubeVideoInfo, YOUTUBE_FORMAT_720 } from "../youtube/youtube-core.js";
import { classifyYoutubeError } from "../youtube/youtube-core.js";

const defaultDependencies = {
  sendReaction: async (api, message) => (await import("../../../commands/command-response.js")).sendReactionConfirmReceive(api, message, 5),
  sendProcessing: async (api, message, qualityText) => (await import("../../chat-zalo/chat-style/chat-style.js")).sendMessageProcessingRequest(api, message, { caption: buildYoutubeProcessingCaption(qualityText) }, 10000),
  sendWarning: async (api, message, payload) => (await import("../../chat-zalo/chat-style/chat-style.js")).sendMessageWarningRequest(api, message, payload, 30000),
  getCachedMedia: async (...args) => (await import("../../../utils/link-platform-cache.js")).getCachedMedia(...args),
  setCacheData: async (...args) => (await import("../../../utils/link-platform-cache.js")).setCacheData(...args),
};

export async function runYoutubeAutoDownloadWorkflow(api, message, youtubeUrl, senderId, senderName, dependencies = {}) {
  const jobId = randomUUID();
  const jobDir = dependencies.jobDir || createYoutubeJobDir("autodownload", jobId);
  const state = { stage: "init", files: [] };
  const qualityParam = dependencies.qualityParam || "default";
  const fetchVideoInfo = dependencies.getYoutubeVideoInfo || runYoutubeVideoInfo;
  const downloadMedia = dependencies.downloadYoutubeVideo || runYoutubeDownload;
  const sendReaction = dependencies.sendReaction || defaultDependencies.sendReaction;
  const sendProcessing = dependencies.sendProcessing || defaultDependencies.sendProcessing;
  const sendWarning = dependencies.sendWarning || defaultDependencies.sendWarning;
  const getCached = dependencies.getCachedMedia || defaultDependencies.getCachedMedia;
  const setCached = dependencies.setCacheData || defaultDependencies.setCacheData;
  const getDuration = dependencies.getDurationVideo || (async (videoPath) => {
    const { getDurationVideo } = await import("../api-hoangdev/aio-downlink.js");
    return await getDurationVideo(videoPath);
  });
  await fs.promises.mkdir(jobDir, { recursive: true });
  try {
    await sendReaction(api, message);
    state.stage = "metadata";
      const videoInfo = await fetchVideoInfo(youtubeUrl);
    state.stage = "cache";
    const cached = await getCached("youtube", videoInfo.videoId, "720p", videoInfo.title);
    let mediaUrl = cached?.fileUrl;
    let duration = cached?.duration || null;
    let videoPath = null;
    if (!mediaUrl) {
      state.stage = "processing";
      await sendProcessing(api, message, "720p");
      state.stage = "download";
      videoPath = path.join(jobDir, `youtube_${videoInfo.videoId}.mp4`);
      state.files.push(videoPath);
      await downloadMedia(videoInfo.url, videoPath, YOUTUBE_FORMAT_720);
      ensureNonEmptyFile(videoPath);
      state.stage = "upload";
      mediaUrl = ensureUploadResult(await api.uploadAttachment([videoPath], message.threadId, message.type));
      state.stage = "duration";
      duration = await getDuration(videoPath);
      await setCached("youtube", videoInfo.videoId, { fileUrl: mediaUrl, title: videoInfo.title, duration }, "720p");
    }
    state.stage = "send";
    await api.sendVideo(buildYoutubePayloadBase({
      videoUrl: mediaUrl,
      threadId: message.threadId,
      threadType: message.type,
      thumbnail: videoInfo.thumbnail,
      duration,
      message: {
        text: buildYoutubeVideoCaption({
          senderName: senderName || message.data?.dName,
          title: videoInfo.title,
          channelName: videoInfo.channelName,
          viewCount: videoInfo.viewCount,
          publishedTime: videoInfo.publishedTime,
          qualityText: "720p",
        }),
      },
      ttl: 3600000,
      alreadyUploaded: true,
    }));
    return true;
  } catch (error) {
    console.error(`YouTube autodownload ${error?.stage || state.stage} failed:`, error?.message || error);
    const kind = classifyYoutubeError(error);
    const caption = error?.stage === "upload"
      ? "Tải lên video thất bại. Vui lòng thử lại sau."
      : error?.stage === "send"
        ? "Không thể gửi video sau khi tải lên. Vui lòng thử lại sau."
      : kind === "unavailable"
      ? "Video này hiện không khả dụng. Hãy thử lại với video khác."
      : kind === "auth"
        ? "YouTube cần cookie hoặc đăng nhập để tiếp tục xử lý video này."
        : kind === "runtime"
          ? "Lỗi cấu hình runtime YouTube. Vui lòng kiểm tra Deno và thử lại."
          : kind === "timeout"
            ? "Xử lý YouTube bị quá thời gian cho phép. Vui lòng thử lại sau."
            : "Có lỗi xảy ra khi xử lý video!";
    await sendWarning(api, message, { caption });
    return false;
  } finally {
    await cleanupYoutubeFiles(state.files);
    await cleanupYoutubeFiles([jobDir]);
  }
}
