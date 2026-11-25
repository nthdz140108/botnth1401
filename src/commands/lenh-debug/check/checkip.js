import net from "node:net";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { fetchJsonWithCache } from "../../../utils/public-api-cache.js";
import { removeMention } from "../../../utils/format-util.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCleanArgs,
  getRawMessageText,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "checkip",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

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

function matchesCheckIpCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "checkip").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

export async function handleCheckipCommand(api, message, aliasCommand = "checkip") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "checkip";

  if (!matchesCheckIpCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const args = extractCleanArgs(msgCtx, currentPrefix, effectiveAlias);

  if (args.length !== 1) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Sai cú pháp! Dùng: ${currentPrefix}${effectiveAlias} <địa_chỉ_IP>`,
      false,
      60000,
      true
    );
  }

  const ip = args[0].trim();
  const ipVersion = net.isIP(ip);
  if (ipVersion === 0) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ "${ip}" không phải là địa chỉ IPv4 hoặc IPv6 hợp lệ!`,
      false,
      60000,
      true
    );
  }

  const apiUrl = `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
  try {
    const json = await fetchJsonWithCache(apiUrl, {
      provider: "checkip",
      ttlMs: 10 * 60 * 1000,
      timeoutMs: 10000,
      retries: 1,
    });

    if (!json?.ip) {
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Không tìm thấy thông tin cho IP: ${ip}`,
        false,
        60000,
        true
      );
    }

    if (json.bogon === true) {
      const bogonMsg =
        `📍 THÔNG TIN ĐỊA CHỈ IP\n\n` +
        `🔢 IP: ${json.ip} (IPv${ipVersion})\n` +
        `🔒 Phân loại: Địa chỉ IP nội bộ / dải riêng tư hoặc dự phòng (Bogon / Private / Loopback)\n` +
        `ℹ️ Địa chỉ này không định tuyến trực tiếp trên mạng Internet công cộng nên không gắn vị trí địa lý hay nhà mạng ISP.`;
      return sendMessageStateQuote(api, msgCtx, bogonMsg, true, 1800000, false);
    }

    const [lat = "N/A", lon = "N/A"] = String(json.loc || "").split(",");
    const msg =
      `📍 THÔNG TIN ĐỊA CHỈ IP\n\n` +
      `🔢 IP: ${json.ip} (IPv${ipVersion})\n` +
      (json.hostname ? `🌐 Hostname: ${json.hostname}\n` : "") +
      `🌍 Quốc gia: ${json.country || "N/A"}\n` +
      `📌 Khu vực: ${json.region || "N/A"}\n` +
      `🏙️ Thành phố: ${json.city || "N/A"}\n` +
      `🏢 Nhà mạng / ASN: ${json.org || "N/A"}\n` +
      `📮 Mã bưu điện: ${json.postal || "N/A"}\n` +
      `🕒 Múi giờ: ${json.timezone || "N/A"}\n\n` +
      `🧭 Tọa độ:\n➤ Vĩ độ: ${lat || "N/A"}\n➤ Kinh độ: ${lon || "N/A"}`;

    return sendMessageStateQuote(api, msgCtx, msg, true, 1800000, false);
  } catch (e) {
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Lỗi khi truy vấn IP: ${e?.message || "Không xác định"}`,
      true
    );
  }
}
