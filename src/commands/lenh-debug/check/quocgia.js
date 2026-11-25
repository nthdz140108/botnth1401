import fetch from "node-fetch";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { removeMention } from "../../../utils/format-util.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getRawMessageText,
} from "../../shared/command-input-utils.js";

export const des = {
  name: "quocgia",
  type: 1,
  permission: "all",
  countdown: 30,
  active: true,
};

const VI_COUNTRY_MAP = Object.freeze({
  "việt nam": "vietnam",
  "viet nam": "vietnam",
  "nhật bản": "japan",
  "nhat ban": "japan",
  "nhật": "japan",
  "hàn quốc": "south korea",
  "han quoc": "south korea",
  "nam hàn": "south korea",
  "triều tiên": "north korea",
  "bắc triều tiên": "north korea",
  "trung quốc": "china",
  "trung quoc": "china",
  "đài loan": "taiwan",
  "dai loan": "taiwan",
  "mỹ": "united states",
  "hoa kỳ": "united states",
  "hoa ky": "united states",
  "hợp chủng quốc hoa kỳ": "united states",
  "anh": "united kingdom",
  "vương quốc anh": "united kingdom",
  "pháp": "france",
  "phap": "france",
  "đức": "germany",
  "duc": "germany",
  "nga": "russia",
  "liên bang nga": "russia",
  "thái lan": "thailand",
  "thai lan": "thailand",
  "úc": "australia",
  "uc": "australia",
  "ấn độ": "india",
  "an do": "india",
  "lào": "laos",
  "lao": "laos",
  "campuchia": "cambodia",
  "miến điện": "myanmar",
  "đông timor": "timor-leste",
  "ý": "italy",
  "italia": "italy",
  "tây ban nha": "spain",
  "tay ban nha": "spain",
  "bồ đào nha": "portugal",
  "bo dao nha": "portugal",
  "hà lan": "netherlands",
  "ha lan": "netherlands",
  "bỉ": "belgium",
  "thụy sĩ": "switzerland",
  "thuy si": "switzerland",
  "thụy điển": "sweden",
  "thuy dien": "sweden",
  "na uy": "norway",
  "đan mạch": "denmark",
  "phần lan": "finland",
  "ba lan": "poland",
  "áo": "austria",
  "hy lạp": "greece",
  "thổ nhĩ kỳ": "turkey",
  "tho nhi ky": "turkey",
  "ai cập": "egypt",
  "nam phi": "south africa",
  "ả rập xê út": "saudi arabia",
  "uae": "united arab emirates",
  "mê-hi-cô": "mexico",
  "bra-xin": "brazil",
  "ác-hen-ti-na": "argentina",
});

const FIELDS = [
  "name",
  "capital",
  "region",
  "subregion",
  "population",
  "languages",
  "currencies",
  "timezones",
  "continents",
  "maps",
  "flags",
].join(",");

function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesCountryCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "quocgia").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

async function fetchCountryData(rawQuery) {
  const normalizedKey = String(rawQuery || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  const mappedQuery = VI_COUNTRY_MAP[normalizedKey] || rawQuery.trim();

  const candidateUrls = [
    `https://restcountries.com/v3.1/name/${encodeURIComponent(mappedQuery)}?fullText=true&fields=${FIELDS}`,
    `https://restcountries.com/v3.1/name/${encodeURIComponent(mappedQuery)}?fields=${FIELDS}`,
    `https://restcountries.com/v3.1/translation/${encodeURIComponent(rawQuery.trim())}?fields=${FIELDS}`,
  ];

  if (/^[a-zA-Z]{2,3}$/.test(rawQuery.trim())) {
    candidateUrls.push(
      `https://restcountries.com/v3.1/alpha/${encodeURIComponent(rawQuery.trim())}?fields=${FIELDS}`
    );
  }

  for (const url of candidateUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) return data[0];
      if (data && typeof data === "object" && data.name) return data;
    } catch {}
  }

  return null;
}

export async function handleQuocgiaCommand(api, message, aliasCommand = "quocgia") {
  const threadId = message.threadId;
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "quocgia";
  const threadType = safeThreadType(
    message,
    threadId && message?.data?.uidFrom && String(threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );

  if (!matchesCountryCommand(message, currentPrefix, effectiveAlias)) {
    return api.sendMessage(
      {
        msg: `❌ Lệnh không hợp lệ! Dùng: ${currentPrefix}${effectiveAlias} <tên quốc gia>`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  const query = extractCommandBody(message, currentPrefix, effectiveAlias);
  if (!query) {
    return api.sendMessage(
      {
        msg: `❌ Thiếu tên quốc gia! Dùng: ${currentPrefix}${effectiveAlias} <tên quốc gia>\n👉 Ví dụ: ${currentPrefix}${effectiveAlias} Nhật Bản`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }

  try {
    const info = await fetchCountryData(query);
    if (!info) {
      return api.sendMessage(
        {
          msg: `❌ Không tìm thấy thông tin cho quốc gia "${query}".`,
          ttl: 60000,
        },
        threadId,
        threadType
      );
    }

    const name = info?.name?.common || query;
    const officialName = info?.name?.official || "N/A";
    const capital =
      Array.isArray(info?.capital) && info.capital[0] ? info.capital[0] : "N/A";
    const region = [info?.region, info?.subregion].filter(Boolean).join(" — ") || "N/A";
    const population =
      typeof info?.population === "number"
        ? info.population.toLocaleString("vi-VN")
        : "N/A";
    const languages = info?.languages
      ? Object.values(info.languages).join(", ")
      : "N/A";
    const currencies = info?.currencies
      ? Object.values(info.currencies)
          .map((c) => (c?.symbol ? `${c.name} (${c.symbol})` : c?.name))
          .filter(Boolean)
          .join(", ")
      : "N/A";
    const timezones = Array.isArray(info?.timezones)
      ? info.timezones.join(", ")
      : "N/A";
    const continents = Array.isArray(info?.continents)
      ? info.continents.join(", ")
      : "N/A";
    const googleMaps = info?.maps?.googleMaps || "N/A";
    const openStreetMaps = info?.maps?.openStreetMaps || "N/A";
    const flagsPNG = info?.flags?.png || null;
    const flagsSVG = info?.flags?.svg || null;

    const lines = [
      `🌎 THÔNG TIN QUỐC GIA`,
      ``,
      `🗺️ Quốc gia: ${name} (${officialName})`,
      `🏰 Thủ đô: ${capital}`,
      `🌍 Khu vực: ${region}`,
      `👥 Dân số: ${population}`,
      `🗣️ Ngôn ngữ: ${languages}`,
      `💱 Tiền tệ: ${currencies}`,
      `⏰ Múi giờ: ${timezones}`,
      `🌐 Lục địa: ${continents}`,
      `📍 Google Maps: ${googleMaps}`,
      `🗾 OpenStreetMap: ${openStreetMaps}`,
      flagsPNG || flagsSVG ? `\n🔱 Quốc kỳ:` : null,
      flagsPNG ? `📸 [PNG] ${flagsPNG}` : null,
      flagsSVG ? `🖼️ [SVG] ${flagsSVG}` : null,
    ].filter(Boolean);

    return api.sendMessage(
      {
        msg: lines.join("\n"),
        ttl: 3600000,
      },
      threadId,
      threadType
    );
  } catch {
    return api.sendMessage(
      {
        msg: `❌ Đã xảy ra lỗi khi tra cứu thông tin quốc gia "${query}". Vui lòng thử lại sau.`,
        ttl: 60000,
      },
      threadId,
      threadType
    );
  }
}
