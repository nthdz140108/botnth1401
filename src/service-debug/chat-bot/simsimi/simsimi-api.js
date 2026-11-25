import axios from "axios";
import { getGlobalPrefix } from "../../service.js";
import {
  extractCommandBody,
  safeThreadType,
} from "../../../commands/shared/command-input-utils.js";

const SIMSIMI_API_URL = "https://wsapi.simsimi.com/190410/talk";

function getSimsimiApiKey() {
  return String(process.env.SIMSIMI_API_KEY || "").trim();
}

export async function chatWithSimsimi(api, message, aliasCommand = "simsimi") {
  const prefix = getGlobalPrefix();
  const threadId = message.threadId;
  const threadType = safeThreadType(message);

  let chatMessage = extractCommandBody(message, prefix, aliasCommand || "simsimi");
  chatMessage = chatMessage.replace(/^(?:simsimi|sim|chat)\b\s*/i, "").trim();

  if (!chatMessage) {
    await api.sendMessage(
      {
        msg: `Vui lòng nhập nội dung để trò chuyện. Ví dụ: ${prefix}${aliasCommand || "simsimi"} Xin chào`,
        quote: message,
        ttl: 60000,
      },
      threadId,
      threadType
    );
    return;
  }

  const apiKey = getSimsimiApiKey();
  if (!apiKey) {
    await api.sendMessage(
      {
        msg: "Chưa cấu hình SIMSIMI_API_KEY để sử dụng tính năng SimSimi.",
        quote: message,
        ttl: 60000,
      },
      threadId,
      threadType
    );
    return;
  }

  try {
    const simsimiReply = await getSimsimiReply(chatMessage, apiKey);
    await sendSimsimiReply(api, message, threadId, threadType, simsimiReply);
  } catch (error) {
    console.error("Lỗi khi gọi API Simsimi:", error.response ? error.response.data : error.message);
    await sendErrorMessage(api, message, threadId, threadType);
  }
}

async function getSimsimiReply(chatMessage, apiKey) {
  const response = await axios.post(
    SIMSIMI_API_URL,
    {
      utext: chatMessage,
      lang: "vn",
      atext_bad_prob_max: 0.7,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      timeout: 12000,
    }
  );

  const simsimiReply = response.data?.atext;
  if (!simsimiReply) {
    throw new Error("Không nhận được phản hồi từ Simsimi");
  }

  return simsimiReply;
}

async function sendSimsimiReply(api, message, threadId, threadType, simsimiReply) {
  const simReply = `Sim: ${simsimiReply}`;
  await api.sendMessage({ msg: simReply, quote: message, ttl: 180000 }, threadId, threadType);
}

async function sendErrorMessage(api, message, threadId, threadType) {
  await api.sendMessage(
    { msg: "Xin lỗi, tôi không thể trả lời lúc này. Vui lòng thử lại sau.", quote: message },
    threadId,
    threadType
  );
}
