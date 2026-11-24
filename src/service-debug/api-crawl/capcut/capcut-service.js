import axios from "axios";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../../utils/format-util.js";
import {
  checkReplySelectionsMapData,
  findSelectionRecordForMessage,
  getSelectionsMapData,
  setSelectionsMapData,
} from "../index.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { downloadAndSaveVideo, deleteFile } from "../../../utils/util.js";
import { createSearchResultImage } from "../../../utils/canvas/search-canvas.js";
import { canContinueReply } from "../../reply-access.js";
import { createDownloadProgress } from "../../../utils/interaction-countdown.js";

// Author: Thanh Hung
// Description: Code get data youtube by H H H
// Note: This code is not working, let goto https://www.capcut.com/vi-vn/templates and copy new request headers of search capcut

const CONFIG = {
  baseUrl: "https://edit-api-sg.capcut.com",
  searchPath: "/lv/v1/cc_web/replicate/search_templates",
  headers: {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9,vi;q=0.8",
    "app-sdk-version": "48.0.0",
    "appvr": "5.8.0",
    "content-type": "application/json",
    "device-time": "1734146729",
    "lan": "vi-VN",
    "loc": "va",
    "origin": "https://www.capcut.com",
    "pf": "7",
    "priority": "u=1, i",
    "referer": "https://www.capcut.com/",
    "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "sign": "8c69245fb9e23bbe2401518a277ef9d4",
    "sign-ver": "1",
    "user-agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36"
  },
  maxResults: 10,
  timeWaitSelection: 60000,
};

const PLATFORM = "capcut";

export const searchCapcut = async (query, limit = CONFIG.maxResults) => {
  try {
    const data = {
      cc_web_version: 0,
      count: limit,
      cursor: "0",
      enter_from: "workspace",
      query: query,
      scene: 1,
      sdk_version: "86.0.0",
      search_version: 2,
    };

    const response = await axios.post(`${CONFIG.baseUrl}${CONFIG.searchPath}`, data, {
      headers: CONFIG.headers,
      timeout: 10000
    });

    if (!response?.data?.data?.video_templates) {
      throw new Error("Không thể lấy được dữ liệu từ Capcut");
    }

    return response.data.data.video_templates;
  } catch (error) {
    console.error("Lỗi khi tìm kiếm template Capcut:", error.message);
    const unavailableResult = [];
    Object.defineProperty(unavailableResult, "unavailable", {
      value: true,
      enumerable: false,
    });
    return unavailableResult;
  }
};

export async function handleCapcutCommand(api, message, aliasCommand) {
  const content = removeMention(message);
  const senderId = message.data.uidFrom;
  const senderName = message.data.dName;
  const prefix = getGlobalPrefix();
  const commandContent = content.replace(`${prefix}${aliasCommand}`, "").trim();
  const [keyword, numberTemplate] = commandContent.split("&&");
  let imagePath;
  let registered = false;

  try {
    if (!keyword) {
      const object = {
        caption: `Vui lòng nhập từ khóa tìm kiếm\nVí dụ:\n${prefix}${aliasCommand} Template Cần Tìm`,
      };
      return await sendMessageCompleteRequest(api, message, object, 30000);
    }

    let limit = Math.min(20, Math.max(1, parseInt(numberTemplate, 10) || CONFIG.maxResults));
    let searchResults = await searchCapcut(keyword, limit);

    if (searchResults.unavailable) {
      const object = {
        caption: `Dịch vụ tìm kiếm mẫu CapCut hiện đang tạm ngưng hoặc bảo trì, vui lòng thử lại sau.`,
      };
      return await sendMessageWarningRequest(api, message, object, 30000);
    }

    if (searchResults.length === 0) {
      const object = {
        caption: `Không tìm thấy template phù hợp với cụm từ: ${keyword}`,
      };
      return await sendMessageWarningRequest(api, message, object, 30000);
    }

    const templates = searchResults.map(template => ({
      title: template.title,
      artistsNames: template.author?.nickname || "CapCut Creator",
      thumbnailM: template.cover_url,
      view: template.play_amount,
      like: template.like_count,
      usage: template.usage_amount
    }));

    imagePath = await createSearchResultImage(templates);

    const listCaption = `Đây là kết quả tìm kiếm template của bạn.\nReply tin nhắn này HOẶC gửi trực tiếp số thứ tự để chọn template.`;

    const searchResultMessage = await sendMessageCompleteRequest(api, message, {
      caption: listCaption,
      imagePath: imagePath,
    }, CONFIG.timeWaitSelection);

    const quotedMsgId = searchResultMessage?.message?.msgId || searchResultMessage?.attachment?.[0]?.msgId;
    const quotedMsgIdStr = quotedMsgId ? quotedMsgId.toString() : "";

    // Preview temp thuộc sở hữu session; chỉ xóa đúng một lần khi kết thúc.
    await setSelectionsMapData(senderId, {
      quotedMsgId: quotedMsgIdStr,
      collection: searchResults,
      platform: PLATFORM,
      replyAccess: "public",
      api,
      sentMessage: searchResultMessage,
      messageContext: message,
      threadId: message.threadId,
      type: message.type,
      seconds: Math.floor(CONFIG.timeWaitSelection / 1000) || 60,
      ownedTempPaths: imagePath ? [imagePath] : [],
      resendPrompt: async () => sendMessageCompleteRequest(api, message, {
        caption: listCaption,
        imagePath: imagePath,
      }, CONFIG.timeWaitSelection),
      onSelect: async (media, index, modifier, replyMessage, claim) => {
        const claimed = typeof claim === "function" ? await claim() : true;
        if (!claimed) return { ok: false, claimed: false, handled: false };
        try {
          const sent = await handleSendTemplateCapcut(api, replyMessage, media);
          return { ok: sent !== false, claimed: true };
        } catch (error) {
          console.error("Lỗi gửi template CapCut:", error);
          await sendMessageWarningRequest(api, replyMessage, {
            caption: "Đã xảy ra lỗi khi lấy template CapCut. Vui long chon lai.",
          }, 30000);
          return { ok: false, claimed: true };
        }
      },
    });
    registered = true;
  } catch (error) {
    console.error("Lỗi khi xử lý tìm kiếm CapCut:", error);
    const object = {
      caption: `Đã xảy ra lỗi khi tìm kiếm template CapCut, vui lòng thử lại sau.`
    };
    await sendMessageWarningRequest(api, message, object, 30000);
  } finally {
    if (imagePath && !registered) deleteFile(imagePath);
  }
}

export async function handleCapcutReply(api, message) {
  // Adapter mỏng: claim/thu hồi/dọn temp do dispatcher chung xử lý.
  try {
    const record = findSelectionRecordForMessage(message);
    if (!record || record.platform !== PLATFORM) return false;
    if (!canContinueReply(record, message.data.uidFrom, message.threadId)) return false;
    return await checkReplySelectionsMapData(api, message);
  } catch (error) {
    console.error("Lỗi xử lý reply Capcut:", error);
    const object = {
      caption: `Đã xảy ra lỗi khi xử lý tin nhắn của bạn. Vui lòng thử lại sau.`,
    };
    await sendMessageWarningRequest(api, message, object, 30000);
    return true;
  }
}

export async function handleSendTemplateCapcut(api, message, template) {
  const senderName = message.data.dName;
  const templateId = template.id;
  const cachedVideo = await getCachedMedia(PLATFORM, templateId, "template", template.title);
  let videoUrl;
  let progress = null;
  // Operation temp: chỉ xóa sau khi thao tác gửi cuối cùng resolve/reject.
  let tempFilePath = null;

  try {
    if (cachedVideo) {
      videoUrl = cachedVideo.fileUrl;
    } else {
      progress = await createDownloadProgress({
        api,
        message,
        caption: `Chờ bé lấy video một chút, xong bé gọi cho hay!`,
        ttl: 8000,
      });

      tempFilePath = await downloadAndSaveVideo(template.video_url);
      const uploadResult = await api.uploadAttachment([tempFilePath], message.threadId, message.type);
      videoUrl = uploadResult?.[0]?.fileUrl;
      if (!videoUrl) {
        throw new Error("Không thể tải lên video template CapCut");
      }

      setCacheData(PLATFORM, templateId, { fileUrl: videoUrl, title: template.title }, "template");
    }

    await progress?.complete();

    await api.sendVideo({
      videoUrl,
      threadId: message.threadId,
      threadType: message.type,
      thumbnail: template.cover_url,
      localThumbnailSource: tempFilePath || undefined,
      message: {
        text: `[ ${senderName} ]\n` +
          `🎬 Template: ${template.title}\n` +
          `⏱️ Thời Lượng: ${template.duration ? `${(template.duration / 1000).toFixed(0)}s` : "Không rõ"}\n` +
          `👁️ Lượt Xem: ${template.play_amount || 0}\n` +
          `❤️ Lượt Thích: ${template.like_count || 0}\n` +
          `👁️ Lượt Sử Dụng: ${template.usage_amount || 0}\n` +
          `🔗 Link Download Template: ${template.template_url}`,
      },
      ttl: 3600000,
    });

    return true;
  } finally {
    if (tempFilePath) await deleteFile(tempFilePath).catch(() => {});
    await progress?.complete();
  }
}


