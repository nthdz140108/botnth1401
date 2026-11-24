import { runYoutubeAutoDownloadWorkflow } from "./youtube-autodownload-workflow.js";
import { normalizeYoutubeUrl } from "../youtube/youtube-service.js";

export async function handleYouTubeAutoDownload(api, message, youtubeUrl, senderId, senderName, dependencies = {}) {
  const normalizedUrl = normalizeYoutubeUrl(youtubeUrl) || youtubeUrl;
  const autoMessage = {
    ...message,
    data: {
      ...message.data,
      uidFrom: senderId ?? message.data?.uidFrom,
      dName: senderName ?? message.data?.dName,
    },
  };

  return await runYoutubeAutoDownloadWorkflow(api, autoMessage, normalizedUrl, senderId, senderName, dependencies);
}
