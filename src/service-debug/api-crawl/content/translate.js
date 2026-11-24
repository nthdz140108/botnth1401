import { getGlobalPrefix } from "../../service.js";
import { callKiraAiChat } from "../assistant-ai/kiraai-client.js";
import { getContent } from "../../../utils/format-util.js";

const TRANSLATE_TIMEOUT_MS = 12000;

export async function translateCommand(api, message) {
  const content = getContent(message);
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();

  if (!content.startsWith(`${prefix}dich`)) return false;

  const command = content.replace(`${prefix}dich`, "").trim();
  const parts = command.split("&&");
  const textToTranslate = (parts[0] || "").trim();
  const targetLanguage = (parts[1] || "vietnamese").trim();

  if (!textToTranslate) {
    await api.sendMessage(
      {
        msg: `Sử dụng: ${prefix}dich [nội dung cần dịch]&&(ngôn ngữ đích)`,
        quote: message,
      },
      threadId,
      message.type,
    );
    return false;
  }

  try {
    const translatedText = await withTimeout(
      translateWithKiraAi(textToTranslate, targetLanguage),
      TRANSLATE_TIMEOUT_MS,
    );
    const responseMessage = `Kết quả dịch cho: ${textToTranslate}\n\nBản dịch (${targetLanguage}): ${translatedText}`;
    await api.sendMessage({ msg: responseMessage, quote: message }, threadId, message.type);
    return true;
  } catch (error) {
    console.error("translateCommand: KiraAI request failed:", error?.message || error);
    await api.sendMessage(
      {
        msg: "Tạm thời không thể dịch nội dung này. Vui lòng thử lại sau.",
        quote: message,
      },
      threadId,
      message.type,
    );
    return false;
  }
}

async function translateWithKiraAi(text, targetLanguage) {
  const prompt = `Dịch giúp tôi cụm từ "${text}" sang ngôn ngữ ${targetLanguage}, chỉ đưa ra kết quả, không giải thích gì thêm.`;
  return callKiraAiChat(prompt);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Translation provider timeout")), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}