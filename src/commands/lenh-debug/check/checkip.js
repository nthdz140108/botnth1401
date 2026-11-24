import { getGlobalPrefix } from "../../../service-debug/service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
} from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { nameServer } from "../../../utils/server-config.js";
import { fetchJsonWithCache } from "../../../utils/public-api-cache.js";

export const des = {
  name: "checkip",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

const getCleanNameServer = () => {
  const lines = String(nameServer || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const tagLine = lines.find((line) => line.startsWith("@"));
  const boldLine = lines.find((line) => /\*\*(.*?)\*\*/.test(line) || /__(.*?)__/.test(line));
  return [tagLine, boldLine].filter(Boolean).join(" ");
};

export async function handleCheckipCommand(api, message) {
  const threadId = message.threadId;
  const uid = message.data.uidFrom;
  const content = String(message?.data?.content || "").trim();
  const currentPrefix = getGlobalPrefix();
  if (!content.startsWith(`${currentPrefix}checkip`)) return false;

  const args = content.slice(currentPrefix.length + "checkip".length).trim().split(/\s+/).filter(Boolean);
  if (args.length !== 1) {
    return sendMessageStateQuote(api, message, `${getCleanNameServer()}❌ Sai cú pháp! Dùng: ${currentPrefix}checkip <ip>`, true, 60000, false);
  }

  const ip = args[0];
  const apiUrl = `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
  try {
    const json = await fetchJsonWithCache(apiUrl, {
      provider: "checkip",
      ttlMs: 10 * 60 * 1000,
      timeoutMs: 10000,
      retries: 1,
    });

    if (!json?.ip) {
      return sendMessageStateQuote(api, message, `${getCleanNameServer()}❌ Không tìm thấy thông tin cho IP: ${ip}`, true, 60000, false);
    }

    const [lat = "N/A", lon = "N/A"] = String(json.loc || "").split(",");
    const msg = `📍 Thông tin IP\n\n🔢 IP: ${json.ip}\n🌍 Quốc gia: ${json.country || "N/A"}\n📌 Khu vực: ${json.region || "N/A"}\n🏙️ Thành phố: ${json.city || "N/A"}\n🏢 Nhà mạng: ${json.org || "N/A"}\n📮 Mã bưu điện: ${json.postal || "N/A"}\n🕒 Múi giờ: ${json.timezone || "N/A"}\n\n🧭 Tọa độ:\n➤ Vĩ độ: ${lat}\n➤ Kinh độ: ${lon}\n\n🛠️ Create By: Thanh Hung`;
    return sendMessageStateQuote(api, message, `${getCleanNameServer()}${msg}`, true, 1800000, false);
  } catch (e) {
    console.error("Lỗi API checkip:", e);
    return sendMessageFailed(api, message, `${getCleanNameServer()}❌ Lỗi khi truy vấn IP: ${e.message}`, true);
  }
}

