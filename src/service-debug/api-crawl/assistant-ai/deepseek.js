import { getGlobalPrefix } from "../../service.js";
import { getContent } from "../../../utils/format-util.js";
import {
  sendMessageFailed,
  sendMessageQuery,
  sendMessageStateQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { callKiraAiChat } from "./kiraai-client.js";

const requestQueue = [];
let isProcessing = false;
const DELAY_BETWEEN_REQUESTS = 1000;

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  while (requestQueue.length > 0) {
    const { question, resolve, reject } = requestQueue.shift();

    try {
      const answer = await callKiraAiChat(question);
      resolve(answer);
    } catch (error) {
      reject(error);
    }

    await new Promise((r) => setTimeout(r, DELAY_BETWEEN_REQUESTS));
  }

  isProcessing = false;
}

export async function callDeepSeekAPI(question) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ question, resolve, reject });
    processQueue();
  });
}

export async function askDeepSeekCommand(api, message, aliasCommand) {
  const content = getContent(message);
  const prefix = getGlobalPrefix();

  const question = content.replace(`${prefix}${aliasCommand}`, "").trim();
  if (!question) {
    await sendMessageQuery(
      api,
      message,
      "Vui lòng nhập câu hỏi cần giải đáp! 🤔",
    );
    return;
  }

  try {
    const replyText = await callDeepSeekAPI(question);

    if (!replyText) {
      await sendMessageFailed(
        api,
        message,
        "Xin lỗi, hiện tại tôi không thể trả lời câu hỏi này. Bạn vui lòng thử lại sau nhé!",
        true,
      );
      return;
    }

    await sendMessageStateQuote(api, message, replyText, true, 86400000, false);
  } catch (error) {
    console.error("askDeepSeekCommand: KiraAI request failed:", error?.message || error);
    await sendMessageFailed(
      api,
      message,
      "Xin lỗi, có lỗi xảy ra khi xử lý yêu cầu của bạn. 😢",
      true,
    );
  }
}