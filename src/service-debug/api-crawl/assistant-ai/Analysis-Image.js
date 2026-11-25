import {
  sendMessageFailed,
  sendMessageWarningRequest,
  sendMessageStateQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service.js";
import { extractCommandBody, getQuoteData } from "../../../commands/shared/command-input-utils.js";
import {
  analyzeQuotedMediaWithGemini,
  callGeminiAPI,
  extractQuotedMediaUrl,
} from "./gemini.js";

export async function handleImageAnalysis(api, message, aliasCommand = "genminiv1") {
  const prefix = getGlobalPrefix();
  const content = extractCommandBody(message, prefix, aliasCommand);
  const quote = getQuoteData(message);

  if (!content && !quote) {
    return sendMessageWarningRequest(
      api,
      message,
      {
        caption: `Vui lòng nhập câu hỏi hoặc reply vào tin nhắn có hình ảnh / video / âm thanh.\nVí dụ:\n${prefix}${aliasCommand} Đây là gì?`,
      },
      30000
    );
  }

  let userInput = content;
  if (!userInput && quote?.msg) {
    userInput = String(quote.msg).trim();
  }

  const hasMedia = Boolean(extractQuotedMediaUrl(quote));

  try {
    if (hasMedia) {
      const { text } = await analyzeQuotedMediaWithGemini(
        userInput || "Hãy mô tả và phân tích chi tiết nội dung hình ảnh này bằng tiếng Việt.",
        message
      );
      const cleanText = String(text || "").replace(/\*\*/g, "").trim();
      return sendMessageStateQuote(api, message, cleanText, true, 3000000, false);
    }

    const userId = message?.data?.uidFrom || "anon";
    const text = await callGeminiAPI(api, message, userInput || "Xin chào", userId);
    const cleanText = String(text || "").replace(/\*\*/g, "").trim();
    return sendMessageStateQuote(api, message, cleanText, true, 3000000, false);
  } catch (err) {
    const errMsg =
      err?.code === "MISSING_GEMINI_KEY"
        ? "Chưa cấu hình GEMINI_API_KEYS hoặc GEMINI_API_KEY."
        : err?.code === "MEDIA_INVALID"
          ? "Media không hợp lệ hoặc vượt quá 15MB."
          : "Không thể phân tích nội dung qua Gemini API, vui lòng thử lại sau.";
    return sendMessageFailed(api, message, errMsg, true);
  }
}
