import {
  sendMessageFailed,
  sendMessageWarningRequest,
  sendMessageCompleteRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service.js";
import { removeMention } from "../../../utils/format-util.js";
import {
  analyzeQuotedMediaWithGemini,
  callGeminiAPI,
  extractQuotedMediaUrl,
} from "./gemini.js";

export async function handleImageAnalysis(api, message, aliasCommand) {
  const prefix = getGlobalPrefix();
  const content = removeMention(message).replace(`${prefix}${aliasCommand}`, "").trim();
  const quote = message.data?.quote;

  if (!content && !quote) {
    return sendMessageWarningRequest(api, message, {
      caption: `Vui lòng nhập câu hỏi hoặc reply vào tin nhắn có hình ảnh / video / âm thanh.\nVí dụ:\n${prefix}${aliasCommand} Đây là gì?`,
    }, 30000);
  }

  let userInput = content;
  if (!userInput && quote?.msg) {
    userInput = String(quote.msg).trim();
  }

  const hasMedia = Boolean(extractQuotedMediaUrl(quote));

  try {
    if (hasMedia) {
      const { text } = await analyzeQuotedMediaWithGemini(
        userInput || "Hãy phân tích chi tiết nội dung hình ảnh này.",
        message
      );
      return sendMessageCompleteRequest(api, message, { caption: text || "" }, 3000000);
    }

    const userId = message?.data?.uidFrom || "anon";
    const text = await callGeminiAPI(api, message, userInput || "Xin chào", userId);
    return sendMessageCompleteRequest(api, message, { caption: text || "" }, 3000000);
  } catch (err) {
    const errMsg = err?.code === "MISSING_GEMINI_KEY"
      ? "GEMINI_API_KEYS chưa được cấu hình."
      : err?.code === "MEDIA_INVALID"
        ? "Media không hợp lệ hoặc quá 15MB."
        : "Không thể phân tích nội dung qua Gemini API, vui lòng thử lại sau.";
    return sendMessageFailed(api, message, errMsg, true);
  }
}
