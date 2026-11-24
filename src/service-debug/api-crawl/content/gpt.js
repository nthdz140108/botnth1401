import { getGlobalPrefix } from "../../service.js";
import { getContent } from "../../../utils/format-util.js";
import {
  sendMessageFailed,
  sendMessageQuery,
  sendMessageStateQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import { callKiraAiChat } from "../assistant-ai/kiraai-client.js";

export async function askGPTCommand(api, message, aliasCommand) {
  const content = getContent(message);
  const prefix = getGlobalPrefix();
  const question = content.replace(`${prefix}${aliasCommand}`, "").trim();

  if (!question) {
    await sendMessageQuery(api, message, "Vui lòng nhập câu hỏi cần giải đáp!");
    return;
  }

  try {
    const replyText = await callKiraAiChat(question);
    if (!replyText) throw new Error("Empty response from KiraAI");
    await sendMessageStateQuote(api, message, replyText, true, 15 * 60000, false);
  } catch (error) {
    console.error("askGPTCommand: KiraAI request failed:", error?.message || error);
    await sendMessageFailed(api, message, "Xin lỗi, có lỗi xảy ra khi xử lý yêu cầu của bạn.");
  }
}