import { sendMessageFactory } from "../../../api-zalo/apis/sendMessage.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { fetchJsonWithCache } from "../../../utils/public-api-cache.js";

export const des = {
  name: "checkdomain",
  type: 1,
  permission: "all",
  countdown: 5,
  active: true,
};

export async function handleCheckdomainCommand(api, message) {
  const threadId = message.threadId;
  const uid = message.data.uidFrom;
  const sendMessage = sendMessageFactory(api);
  const content = String(message?.data?.content || "").trim();
  const currentPrefix = getGlobalPrefix();
  if (!content.startsWith(`${currentPrefix}checkdomain`)) return false;

  const domain = content.slice(currentPrefix.length + "checkdomain".length).trim().split(/\s+/)[0]?.replace(/[^a-zA-Z0-9.-]/g, "").toLowerCase() || "";
  if (!domain) {
    return sendMessage({
      msg: `❌ Vui lòng nhập tên miền. Cú pháp: ${currentPrefix}checkdomain <domain>`,
      ttl: 60000,
    }, threadId, threadId !== uid ? 1 : 0);
  }

  const isDotVN = domain.endsWith(".vn");
  const apiUrl = `https://whois.inet.vn/api/whois/domainspecify/${encodeURIComponent(domain)}`;

  try {
    const data = await fetchJsonWithCache(apiUrl, {
      provider: "checkdomain",
      ttlMs: 10 * 60 * 1000,
      timeoutMs: 10000,
      retries: 1,
    });

    if (data?.code === "1" || String(data?.message || "").toLowerCase().includes("does not exist")) {
      const fee = data.fee || "Không rõ";
      const reg = data.reg || "Không rõ";
      const ren = data.ren || "Không rõ";
      const feeMsg =
        `🔍 Thông Tin Tên Miền: ${domain}\n` +
        `⚠️ Tên miền chưa được đăng ký.\n\n` +
        `💰 Phí đăng ký: ${Number(reg) ? Number(reg).toLocaleString() : reg}đ\n` +
        `♻️ Phí gia hạn: ${Number(ren) ? Number(ren).toLocaleString() : ren}đ\n` +
        `🛒 Tổng giá (năm đầu): ${Number(fee) ? Number(fee).toLocaleString() : fee}đ\n` +
        `🔗 Đăng ký tại: https://inet.vn\n\n` +
        `👤 Founder: Thanh Hung`;
      return sendMessage({ msg: feeMsg, ttl: 86400000 }, threadId, threadId !== uid ? 1 : 0);
    }

    if (data?.code !== "0") {
      throw new Error(data?.message || "Không thể lấy thông tin domain.");
    }

    const nameServers = Array.isArray(data.nameServer) ? `[ ${data.nameServer.join(", ")} ]` : "Không rõ";
    const status = Array.isArray(data.status) ? `[ ${data.status.join(", ")} ]` : "Không rõ";
    const msg =
      `🔍 Thông Tin Tên Miền: ${data.domainName || domain}\n` +
      `👤 Người Đăng Ký: ${isDotVN ? (data.registrantName || "Không công khai") : "Không rõ"}\n` +
      `🏢 Đơn Vị Đăng Ký: ${data.registrar || "Không rõ"}\n` +
      `📅 Ngày Đăng Ký: ${data.creationDate || "Không rõ"}\n` +
      `📅 Ngày Hết Hạn: ${data.expirationDate || "Không rõ"}\n` +
      `🔐 DNSSEC: ${data.DNSSEC || "Không rõ"}\n` +
      `🖥️ Tên Máy Chủ: ${nameServers}\n` +
      `⚙️ Trạng Thái: ${status}\n` +
      `✅✅✅`;
    return sendMessage({ msg, ttl: 86400000 }, threadId, threadId !== uid ? 1 : 0);
  } catch (err) {
    console.error(`❌ Lỗi tra cứu tên miền "${domain}":`, err.message);
    return sendMessage({
      msg: `❌ Không thể tra cứu tên miền "${domain}" lúc này. Vui lòng thử lại sau.\n📖 Lý do: ${err.message}`,
      ttl: 60000,
    }, threadId, threadId !== uid ? 1 : 0);
  }
}

