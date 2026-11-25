import fetch from "node-fetch";
import { getGlobalPrefix } from "../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../chat-zalo/chat-style/chat-style.js";
import { removeMention } from "../../utils/format-util.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getRawMessageText,
} from "../../commands/shared/command-input-utils.js";

const AUDIO_OPTIONS = [
  { index: "1", code: "nnca", title: "Nơi Này Có Anh" },
  { index: "2", code: "pm", title: "Phép Màu" },
  { index: "3", code: "thttt", title: "Tín Hiệu Từ Trái Tim" },
  { index: "4", code: "ccyld", title: "Có Chắc Yêu Là Đây" },
  { index: "5", code: "cgm52", title: "Cô Gái M52" },
  { index: "6", code: "hgedat", title: "Hẹn Gặp Em Dưới Ánh Trăng" },
  { index: "7", code: "mrtt", title: "Mượn Rượu Tỏ Tình" },
  { index: "8", code: "nap", title: "Người Âm Phủ" },
];

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function matchesLovelinkCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "lovelink").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

function resolveAudioSelection(rawAudio) {
  const key = String(rawAudio ?? "").trim().toLowerCase();
  if (!key) return null;
  const byIdxOrCode = AUDIO_OPTIONS.find((item) => item.index === key || item.code === key);
  return byIdxOrCode || { index: "", code: key, title: key };
}

function buildGuide(prefix, aliasCommand) {
  const cmd = `${prefix}${aliasCommand || "lovelink"}`;
  const audioList = AUDIO_OPTIONS.map(
    (a) => `• ${a.index} hoặc ${a.code} — ${a.title}`
  ).join("\n");
  return (
    `❌ Vui lòng nhập đúng định dạng:\n` +
    `${cmd} <Lời nhắn> | <Mã nhạc>\n` +
    `(Hoặc: ${cmd} <Lời nhắn> <Mã nhạc>)\n\n` +
    `🎵 Danh sách mã nhạc:\n${audioList}`
  );
}

export async function handlelovelinkCommand(api, message, aliasCommand = "lovelink") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "lovelink";

  if (!matchesLovelinkCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const body = extractCommandBody(msgCtx, currentPrefix, effectiveAlias);

  let text = "";
  let audioRaw = "";

  if (body.includes("|")) {
    const lastPipe = body.lastIndexOf("|");
    text = body.slice(0, lastPipe).trim();
    audioRaw = body.slice(lastPipe + 1).trim();
  } else {
    const tokens = body.split(/\s+/).filter(Boolean);
    if (tokens.length >= 2) {
      audioRaw = tokens[tokens.length - 1];
      text = tokens.slice(0, -1).join(" ").trim();
    }
  }

  const selectedAudio = resolveAudioSelection(audioRaw);
  if (!text || !selectedAudio) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      buildGuide(currentPrefix, effectiveAlias),
      false,
      60000,
      true
    );
  }

  const apiUrl = `https://api.nemg.me/love?text=${encodeURIComponent(text)}&audio=${encodeURIComponent(selectedAudio.code)}`;

  try {
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = await res.json();

    if (!json?.success || !json?.url) {
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Không tạo được love link với dữ liệu đã nhập.`,
        false,
        60000,
        true
      );
    }

    const msg =
      `💖 LOVE LINK ĐÃ TẠO THÀNH CÔNG\n\n` +
      `➤ Lời nhắn: ${text}\n` +
      `➤ Nhạc nền: ${json.audioName || selectedAudio.title}\n` +
      `➤ Link: ${json.url}`;

    return sendMessageStateQuote(api, msgCtx, msg, true, 3600000, false);
  } catch (e) {
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Lỗi khi tạo Love Link: ${e?.message || "Hết thời gian kết nối"}`,
      true
    );
  }
}
