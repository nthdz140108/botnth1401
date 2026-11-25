import { LRUCache } from "lru-cache";
import { getGlobalPrefix } from "../../service.js";
import { getBotId } from "../../../utils/env.js";
import {
  sendMessageComplete,
  sendMessageFailed,
  sendMessageQuery,
  sendMessageStateQuote,
} from "../../chat-zalo/chat-style/chat-style.js";
import {
  callOpenAiCompatibleChat,
  getKiraAiConfig,
  isKiraAiConfigured,
} from "../assistant-ai/kiraai-client.js";
import {
  extractCommandBody,
  getQuotedText,
} from "../../../commands/shared/command-input-utils.js";

const conversationCache = new LRUCache({
  max: 500,
  ttl: 15 * 60 * 1000,
});

const MAX_HISTORY_MESSAGES = 12;

function isDeepSeekAlias(aliasCommand = "") {
  const lower = String(aliasCommand || "").trim().toLowerCase();
  return lower.includes("deepseek") || lower === "deepchat" || lower === "ds";
}

function resolveProviderPlan(aliasCommand = "gpt") {
  const deepseekMode = isDeepSeekAlias(aliasCommand);

  if (deepseekMode) {
    const deepseekKey = String(process.env.DEEPSEEK_API_KEY || "").trim();
    if (deepseekKey) {
      return [
        {
          apiKey: deepseekKey,
          baseUrl: String(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").trim(),
          model: String(process.env.DEEPSEEK_MODEL || "deepseek-chat").trim(),
          providerLabel: "DeepSeek",
        },
      ];
    }

    if (isKiraAiConfigured()) {
      const kiraCfg = getKiraAiConfig();
      const preferredModel = String(process.env.KIRA_DEEPSEEK_MODEL || "deepseek-chat").trim();
      const candidates = [
        {
          apiKey: kiraCfg.apiKey,
          baseUrl: kiraCfg.baseUrl,
          model: preferredModel,
          timeoutMs: kiraCfg.timeoutMs,
          providerLabel: "KiraAI (DeepSeek)",
        },
      ];
      if (kiraCfg.model && kiraCfg.model !== preferredModel) {
        candidates.push({
          apiKey: kiraCfg.apiKey,
          baseUrl: kiraCfg.baseUrl,
          model: kiraCfg.model,
          timeoutMs: kiraCfg.timeoutMs,
          providerLabel: "KiraAI",
        });
      }
      return candidates;
    }

    return [];
  }

  const openAiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (openAiKey) {
    return [
      {
        apiKey: openAiKey,
        baseUrl: String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").trim(),
        model: String(process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
        providerLabel: "OpenAI",
      },
    ];
  }

  if (isKiraAiConfigured()) {
    const kiraCfg = getKiraAiConfig();
    return [
      {
        apiKey: kiraCfg.apiKey,
        baseUrl: kiraCfg.baseUrl,
        model: kiraCfg.model,
        timeoutMs: kiraCfg.timeoutMs,
        providerLabel: "KiraAI",
      },
    ];
  }

  return [];
}

export async function askGPTCommand(api, message, aliasCommand = "gpt") {
  const prefix = getGlobalPrefix();
  const body = extractCommandBody(message, prefix, aliasCommand);
  const quotedText = getQuotedText(message);
  const question = body || quotedText;

  if (!question) {
    await sendMessageQuery(api, message, "Vui lòng nhập câu hỏi cần giải đáp!");
    return;
  }

  const botId = String(api?.getBotId?.() || getBotId() || "default");
  const userId = String(message?.data?.uidFrom || "anon");
  const family = isDeepSeekAlias(aliasCommand) ? "deepseek" : "gpt";
  const sessionKey = `${botId}:${userId}:${family}`;

  if (/^(?:reset|clear|xóa|xoa)$/i.test(body.trim())) {
    conversationCache.delete(sessionKey);
    await sendMessageComplete(api, message, "Đã xóa lịch sử cuộc trò chuyện của bạn!", false);
    return;
  }

  const providers = resolveProviderPlan(aliasCommand);
  if (providers.length === 0) {
    const missingHint = isDeepSeekAlias(aliasCommand)
      ? "Chưa cấu hình DEEPSEEK_API_KEY hoặc KIRA_API_KEY."
      : "Chưa cấu hình OPENAI_API_KEY hoặc KIRA_API_KEY.";
    await sendMessageFailed(api, message, missingHint, true);
    return;
  }

  const history = conversationCache.get(sessionKey) || [];
  const effectivePrompt =
    body && quotedText && body !== quotedText
      ? `Nội dung được trích dẫn:\n"${quotedText}"\n\nYêu cầu: ${body}`
      : question;

  const messages = [
    {
      role: "system",
      content:
        "Bạn là trợ lý AI thông minh, chính xác và thân thiện. Hãy trả lời rõ ràng bằng tiếng Việt trừ khi người dùng yêu cầu ngôn ngữ khác.",
    },
    ...history.slice(-MAX_HISTORY_MESSAGES),
    { role: "user", content: effectivePrompt },
  ];

  let lastError = null;
  for (const candidate of providers) {
    try {
      const replyText = await callOpenAiCompatibleChat({
        messages,
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        model: candidate.model,
        timeoutMs: candidate.timeoutMs || 30000,
        providerLabel: candidate.providerLabel,
      });

      const updatedHistory = [
        ...history,
        { role: "user", content: effectivePrompt },
        { role: "assistant", content: replyText },
      ].slice(-MAX_HISTORY_MESSAGES);
      conversationCache.set(sessionKey, updatedHistory);

      await sendMessageStateQuote(api, message, replyText, true, 15 * 60000, false);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  console.error(`askGPTCommand (${aliasCommand}) failed:`, lastError?.message || lastError);
  await sendMessageFailed(api, message, "Xin lỗi, có lỗi xảy ra khi xử lý yêu cầu của bạn.", true);
}
