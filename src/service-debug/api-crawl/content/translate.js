import { getGlobalPrefix } from "../../service.js";
import { callKiraAiChat, isKiraAiConfigured } from "../assistant-ai/kiraai-client.js";
import {
  extractCommandBody,
  getQuotedText,
  safeThreadType,
} from "../../../commands/shared/command-input-utils.js";

const TRANSLATE_TIMEOUT_MS = 10000;

const LANGUAGE_MAP = new Map([
  ["vi", { code: "vi", label: "Tiếng Việt" }],
  ["vn", { code: "vi", label: "Tiếng Việt" }],
  ["viet", { code: "vi", label: "Tiếng Việt" }],
  ["vietnamese", { code: "vi", label: "Tiếng Việt" }],
  ["tiếng việt", { code: "vi", label: "Tiếng Việt" }],
  ["tieng viet", { code: "vi", label: "Tiếng Việt" }],
  ["en", { code: "en", label: "Tiếng Anh" }],
  ["eng", { code: "en", label: "Tiếng Anh" }],
  ["english", { code: "en", label: "Tiếng Anh" }],
  ["anh", { code: "en", label: "Tiếng Anh" }],
  ["tiếng anh", { code: "en", label: "Tiếng Anh" }],
  ["tieng anh", { code: "en", label: "Tiếng Anh" }],
  ["zh", { code: "zh-CN", label: "Tiếng Trung" }],
  ["zh-cn", { code: "zh-CN", label: "Tiếng Trung" }],
  ["cn", { code: "zh-CN", label: "Tiếng Trung" }],
  ["chinese", { code: "zh-CN", label: "Tiếng Trung" }],
  ["trung", { code: "zh-CN", label: "Tiếng Trung" }],
  ["tiếng trung", { code: "zh-CN", label: "Tiếng Trung" }],
  ["tieng trung", { code: "zh-CN", label: "Tiếng Trung" }],
  ["ja", { code: "ja", label: "Tiếng Nhật" }],
  ["jp", { code: "ja", label: "Tiếng Nhật" }],
  ["japanese", { code: "ja", label: "Tiếng Nhật" }],
  ["nhật", { code: "ja", label: "Tiếng Nhật" }],
  ["nhat", { code: "ja", label: "Tiếng Nhật" }],
  ["tiếng nhật", { code: "ja", label: "Tiếng Nhật" }],
  ["tieng nhat", { code: "ja", label: "Tiếng Nhật" }],
  ["ko", { code: "ko", label: "Tiếng Hàn" }],
  ["kr", { code: "ko", label: "Tiếng Hàn" }],
  ["korean", { code: "ko", label: "Tiếng Hàn" }],
  ["hàn", { code: "ko", label: "Tiếng Hàn" }],
  ["han", { code: "ko", label: "Tiếng Hàn" }],
  ["tiếng hàn", { code: "ko", label: "Tiếng Hàn" }],
  ["tieng han", { code: "ko", label: "Tiếng Hàn" }],
  ["fr", { code: "fr", label: "Tiếng Pháp" }],
  ["french", { code: "fr", label: "Tiếng Pháp" }],
  ["pháp", { code: "fr", label: "Tiếng Pháp" }],
  ["phap", { code: "fr", label: "Tiếng Pháp" }],
  ["tiếng pháp", { code: "fr", label: "Tiếng Pháp" }],
  ["de", { code: "de", label: "Tiếng Đức" }],
  ["german", { code: "de", label: "Tiếng Đức" }],
  ["đức", { code: "de", label: "Tiếng Đức" }],
  ["duc", { code: "de", label: "Tiếng Đức" }],
  ["ru", { code: "ru", label: "Tiếng Nga" }],
  ["russian", { code: "ru", label: "Tiếng Nga" }],
  ["nga", { code: "ru", label: "Tiếng Nga" }],
  ["th", { code: "th", label: "Tiếng Thái" }],
  ["thai", { code: "th", label: "Tiếng Thái" }],
  ["thái", { code: "th", label: "Tiếng Thái" }],
  ["es", { code: "es", label: "Tiếng Tây Ban Nha" }],
  ["spanish", { code: "es", label: "Tiếng Tây Ban Nha" }],
]);

function normalizeTargetLanguage(rawLang) {
  const cleaned = String(rawLang || "").trim().toLowerCase();
  if (!cleaned) {
    return { code: "vi", label: "Tiếng Việt", explicit: false };
  }
  const mapped = LANGUAGE_MAP.get(cleaned);
  if (mapped) {
    return { ...mapped, explicit: true };
  }
  if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(cleaned)) {
    return { code: cleaned, label: rawLang.trim(), explicit: true };
  }
  return { code: "vi", label: rawLang.trim(), explicit: true };
}

function parseTranslationInput(body, quotedText) {
  const trimmedBody = String(body || "").trim();
  const trimmedQuote = String(quotedText || "").trim();

  if (trimmedBody.includes("&&")) {
    const [left, right] = trimmedBody.split("&&");
    const text = (left || "").trim() || trimmedQuote;
    const langInfo = normalizeTargetLanguage(right);
    return { textToTranslate: text, targetLang: langInfo };
  }

  if (trimmedQuote) {
    if (!trimmedBody) {
      return {
        textToTranslate: trimmedQuote,
        targetLang: { code: "vi", label: "Tiếng Việt", explicit: false },
      };
    }
    const lowerBody = trimmedBody.toLowerCase();
    if (LANGUAGE_MAP.has(lowerBody) || /^[a-z]{2}(?:-[a-z]{2})?$/i.test(lowerBody)) {
      return {
        textToTranslate: trimmedQuote,
        targetLang: normalizeTargetLanguage(trimmedBody),
      };
    }
  }

  return {
    textToTranslate: trimmedBody,
    targetLang: { code: "vi", label: "Tiếng Việt", explicit: false },
  };
}

async function translateWithGoogleGtx(text, targetCode) {
  const url =
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto` +
    `&tl=${encodeURIComponent(targetCode)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Google Translate HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data?.[0])) {
    throw new Error("Invalid Google Translate payload");
  }
  const translated = data[0]
    .map((segment) => (Array.isArray(segment) && typeof segment[0] === "string" ? segment[0] : ""))
    .join("")
    .trim();
  if (!translated) {
    throw new Error("Empty Google Translate result");
  }
  const detectedLang = typeof data[2] === "string" ? data[2] : "";
  return { translated, detectedLang };
}

async function translateWithKiraAi(text, targetLabel) {
  const prompt = `Dịch chính xác đoạn văn bản sau sang ${targetLabel}, chỉ trả về đúng nội dung bản dịch, không giải thích gì thêm:\n\n${text}`;
  return callKiraAiChat(prompt, { timeoutMs: TRANSLATE_TIMEOUT_MS });
}

export async function translateCommand(api, message, aliasCommand = "dich") {
  const threadId = message.threadId;
  const threadType = safeThreadType(message);
  const prefix = getGlobalPrefix();

  const body = extractCommandBody(message, prefix, aliasCommand || "dich");
  const quotedText = getQuotedText(message);
  const { textToTranslate, targetLang } = parseTranslationInput(body, quotedText);

  if (!textToTranslate) {
    await api.sendMessage(
      {
        msg:
          `Sử dụng:\n` +
          `• ${prefix}${aliasCommand || "dich"} <nội dung> && <ngôn ngữ đích>\n` +
          `• Hoặc reply vào tin nhắn cần dịch kèm ${prefix}${aliasCommand || "dich"} [vi|en|ja|zh|ko]`,
        quote: message,
        ttl: 60000,
      },
      threadId,
      threadType
    );
    return false;
  }

  try {
    let translatedText = "";
    let finalLabel = targetLang.label;

    if (isKiraAiConfigured()) {
      try {
        translatedText = (await translateWithKiraAi(textToTranslate, finalLabel)).trim();
      } catch {
        // Fallback to Google GTX below
      }
    }

    if (!translatedText) {
      let gtx = await translateWithGoogleGtx(textToTranslate, targetLang.code);
      if (
        !targetLang.explicit &&
        targetLang.code === "vi" &&
        gtx.detectedLang.toLowerCase() === "vi"
      ) {
        gtx = await translateWithGoogleGtx(textToTranslate, "en");
        finalLabel = "Tiếng Anh";
      }
      translatedText = gtx.translated;
    }

    const responseMessage = `Kết quả dịch cho: ${textToTranslate}\n\nBản dịch (${finalLabel}): ${translatedText}`;
    await api.sendMessage({ msg: responseMessage, quote: message }, threadId, threadType);
    return true;
  } catch (error) {
    console.error("translateCommand failed:", error?.message || error);
    await api.sendMessage(
      {
        msg: "Tạm thời không thể dịch nội dung này. Vui lòng thử lại sau.",
        quote: message,
      },
      threadId,
      threadType
    );
    return false;
  }
}
