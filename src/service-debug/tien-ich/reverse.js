import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../chat-zalo/chat-style/chat-style.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { removeMention } from "../../utils/format-util.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuotedText,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

const VI_GRAPHEME_SEGMENTER = new Intl.Segmenter("vi", { granularity: "grapheme" });

export const des = {
  name: "reverse",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesCommandInvocation(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const aliasTokens = String(aliasCommand || "reverse")
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join("\\s+");
  const pattern = new RegExp(
    `^\\s*${escapeRegExp(prefix)}\\s*${aliasTokens}(?:[\\s_]+|$)`,
    "i"
  );
  return pattern.test(cleaned);
}

function withSafeMessageType(message) {
  const fallbackType =
    message?.threadId &&
    message?.data?.uidFrom &&
    String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage;
  const resolvedType = safeThreadType(message, fallbackType);
  return message?.type === resolvedType ? message : { ...message, type: resolvedType };
}

export function reverseGraphemeText(text) {
  const str = String(text ?? "");
  if (!str) return "";
  return Array.from(VI_GRAPHEME_SEGMENTER.segment(str), (s) => s.segment)
    .reverse()
    .join("");
}

export async function handleReverseCommand(api, message, aliasCommand = "reverse") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "reverse";

  if (!matchesCommandInvocation(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const argText = extractCommandBody(msgCtx, currentPrefix, effectiveAlias);
  const textToReverse = argText || getQuotedText(msgCtx);

  if (!textToReverse) {
    const guide =
      `❌ Vui lòng nhập nội dung hoặc reply tin nhắn muốn đảo ngược.\n\n` +
      `👉 Ví dụ: ${currentPrefix}${effectiveAlias} Xin chào Việt Nam 🇻🇳`;
    return sendMessageStateQuote(api, msgCtx, guide, false, 60000, true);
  }

  try {
    const reversed = reverseGraphemeText(textToReverse);
    const msg =
      `✅ ĐẢO NGƯỢC VĂN BẢN THÀNH CÔNG\n\n` +
      `➤ Gốc: ${textToReverse}\n` +
      `➤ Đảo ngược: ${reversed}`;
    return sendMessageStateQuote(api, msgCtx, msg, true, 3600000, false);
  } catch (error) {
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Không thể đảo ngược văn bản: ${error?.message || "Không xác định"}`,
      true
    );
  }
}
