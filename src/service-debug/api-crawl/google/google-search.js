import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { callGeminiGenerate } from "../assistant-ai/gemini.js";
import { callKiraAiChat, isKiraAiConfigured } from "../assistant-ai/kiraai-client.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuotedText,
} from "../../../commands/shared/command-input-utils.js";

const SEARCH_TIMEOUT_MS = 8000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cleanText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unwrapDuckDuckGoHref(rawHref) {
  const href = String(rawHref ?? "").trim();
  if (!href) return "";
  try {
    const full = href.startsWith("//")
      ? `https:${href}`
      : href.startsWith("/")
        ? `https://duckduckgo.com${href}`
        : href;
    const parsed = new URL(full);
    const uddg = parsed.searchParams.get("uddg");
    if (uddg && /^https?:\/\//i.test(uddg)) {
      return uddg;
    }
    if (/^https?:\/\//i.test(full) && !parsed.hostname.endsWith("duckduckgo.com")) {
      return full;
    }
  } catch {}
  return /^https?:\/\//i.test(href) ? href : "";
}

async function searchGoogleCustomSearchApi(query, maxResults) {
  const apiKey = String(process.env.GOOGLE_SEARCH_API_KEY || "").trim();
  const cseId = String(process.env.GOOGLE_SEARCH_CSE_ID || "").trim();
  if (!apiKey || !cseId) return [];

  const num = Math.min(10, Math.max(1, maxResults));
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cseId)}&q=${encodeURIComponent(query)}&num=${num}&hl=vi`;
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json();
  if (!Array.isArray(data?.items)) return [];

  return data.items
    .map((item) => ({
      title: cleanText(item?.title),
      snippet: cleanText(item?.snippet),
      url: String(item?.link || "").trim(),
    }))
    .filter((r) => r.title && /^https?:\/\//i.test(r.url));
}

async function searchSerpApi(query, maxResults) {
  const serpKey = String(process.env.SERPAPI_API_KEY || "").trim();
  if (!serpKey) return [];

  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&hl=vi&gl=vn&api_key=${encodeURIComponent(serpKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) return [];
  const data = await res.json();
  if (data?.error) return [];

  const items = [];
  if (data?.answer_box && (data.answer_box.answer || data.answer_box.snippet)) {
    items.push({
      title: cleanText(data.answer_box.title || query),
      snippet: cleanText(data.answer_box.answer || data.answer_box.snippet),
      url: String(data.answer_box.link || "https://www.google.com").trim(),
    });
  }
  if (data?.knowledge_graph?.description) {
    items.push({
      title: cleanText(data.knowledge_graph.title || query),
      snippet: cleanText(data.knowledge_graph.description),
      url: String(
        data.knowledge_graph.description_link ||
          data.knowledge_graph.website ||
          "https://www.google.com"
      ).trim(),
    });
  }
  for (const org of data?.organic_results || []) {
    if (!org?.title || !org?.link) continue;
    items.push({
      title: cleanText(org.title),
      snippet: cleanText(org.snippet || ""),
      url: String(org.link).trim(),
    });
  }

  return items.slice(0, maxResults);
}

async function searchDuckDuckGoHtml(query, maxResults) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=vn-vi`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];

  const html = await res.text();
  const $ = cheerio.load(html);
  const results = [];

  $(".result, .web-result").each((_, el) => {
    if (results.length >= maxResults) return false;
    const anchor = $(el).find("a.result__a").first();
    const title = cleanText(anchor.text());
    const resolvedUrl = unwrapDuckDuckGoHref(anchor.attr("href"));
    const snippet = cleanText(
      $(el).find(".result__snippet").first().text() ||
        $(el).find(".result__extras__url").first().text()
    );
    if (title && resolvedUrl && !resolvedUrl.includes("duckduckgo.com/y.js")) {
      results.push({ title, snippet, url: resolvedUrl });
    }
  });

  return results;
}

async function searchDuckDuckGoInstant(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const items = [];

  if (data?.AbstractText && data?.AbstractURL) {
    items.push({
      title: cleanText(data.Heading || query),
      snippet: cleanText(data.AbstractText),
      url: String(data.AbstractURL).trim(),
    });
  }

  if (Array.isArray(data?.RelatedTopics)) {
    for (const topic of data.RelatedTopics.slice(0, 3)) {
      if (topic?.Text && topic?.FirstURL) {
        items.push({
          title: cleanText(topic.Text.split(" - ")[0] || query),
          snippet: cleanText(topic.Text),
          url: String(topic.FirstURL).trim(),
        });
      }
    }
  }
  return items;
}

async function searchWikipedia(query, lang = "vi", limit = 4) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=1&format=json&srlimit=${limit}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "MyBotSearch/3.0 (https://vi.wikipedia.org)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const list = data?.query?.search;
  if (!Array.isArray(list)) return [];

  return list
    .map((item) => {
      const title = cleanText(item?.title);
      const snippet = cleanText(item?.snippet);
      const wikiUrl = title
        ? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`
        : "";
      return { title: `${title} (${lang.toUpperCase()} Wiki)`, snippet, url: wikiUrl };
    })
    .filter((r) => r.title && r.url);
}

export async function searchWebMultiSource(query, { maxResults = 6 } = {}) {
  const cleanQuery = String(query ?? "").trim();
  if (!cleanQuery) return [];

  const cap = Math.max(1, Math.min(15, Number(maxResults) || 6));

  try {
    const cseResults = await searchGoogleCustomSearchApi(cleanQuery, cap);
    if (cseResults.length > 0) return cseResults.slice(0, cap);
  } catch {}

  try {
    const serpResults = await searchSerpApi(cleanQuery, cap);
    if (serpResults.length > 0) return serpResults.slice(0, cap);
  } catch {}

  const [ddgHtmlSettled, ddgInstantSettled, viWikiSettled, enWikiSettled] =
    await Promise.allSettled([
      searchDuckDuckGoHtml(cleanQuery, cap),
      searchDuckDuckGoInstant(cleanQuery),
      searchWikipedia(cleanQuery, "vi", 4),
      searchWikipedia(cleanQuery, "en", 2),
    ]);

  const combined = [
    ...(ddgInstantSettled.status === "fulfilled" ? ddgInstantSettled.value : []),
    ...(ddgHtmlSettled.status === "fulfilled" ? ddgHtmlSettled.value : []),
    ...(viWikiSettled.status === "fulfilled" ? viWikiSettled.value : []),
    ...(enWikiSettled.status === "fulfilled" ? enWikiSettled.value : []),
  ];

  const seenUrls = new Set();
  const deduped = [];
  for (const item of combined) {
    if (!item?.title || !item?.url || !/^https?:\/\//i.test(item.url)) continue;
    const normKey = item.url.replace(/\/+$/, "").toLowerCase();
    if (seenUrls.has(normKey)) continue;
    seenUrls.add(normKey);
    deduped.push({
      title: item.title,
      snippet: item.snippet || "Xem chi tiết tại liên kết nguồn.",
      url: item.url,
    });
    if (deduped.length >= cap) break;
  }

  return deduped;
}

function extractGeminiText(response) {
  if (!response) return "";
  if (typeof response === "string") return response.trim();
  if (typeof response.text === "string") return response.text.trim();
  if (typeof response.text === "function") {
    try {
      return String(response.text() || "").trim();
    } catch {}
  }
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => p?.text || "")
      .join("")
      .trim();
  }
  return "";
}

async function synthesizeAiSearchAnswer(query, results) {
  const sourceContext = results
    .map(
      (r, idx) =>
        `[${idx + 1}] Tiêu đề: ${r.title}\nTóm tắt: ${r.snippet}\nURL: ${r.url}`
    )
    .join("\n\n");

  const prompt =
    `Bạn là trợ lý tìm kiếm AI tiếng Việt chính xác, khách quan.\n` +
    `Dựa trên các kết quả tìm kiếm web dưới đây cho truy vấn "${query}", hãy tổng hợp câu trả lời ngắn gọn, mạch lạc bằng tiếng Việt (khoảng 4-8 câu) và trích dẫn số thứ tự nguồn dạng [1], [2]. Không bịa đặt thông tin ngoài nguồn.\n\n` +
    `NGUỒN DỮ LIỆU:\n${sourceContext}`;

  const hasGemini = Boolean(
    String(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || "").trim()
  );

  if (hasGemini) {
    try {
      const geminiRes = await Promise.race([
        callGeminiGenerate(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Gemini synthesis timeout")), 12000)
        ),
      ]);
      const text = extractGeminiText(geminiRes);
      if (text) return text;
    } catch {}
  }

  if (isKiraAiConfigured()) {
    try {
      const kiraText = await callKiraAiChat(prompt, { timeoutMs: 12000 });
      if (kiraText && kiraText.trim()) return kiraText.trim();
    } catch {}
  }

  const summaryPoints = results
    .slice(0, 4)
    .map((r, idx) => `• [${idx + 1}] ${r.title}: ${r.snippet}`)
    .join("\n");
  return `Tổng hợp nhanh thông tin tìm được cho "${query}":\n${summaryPoints}`;
}

export async function handleGoogleCommand(api, message, aliasCommand = "google") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "google";
  const threadType = safeThreadType(
    message,
    message?.threadId &&
      message?.data?.uidFrom &&
      String(message.threadId) === String(message.data.uidFrom)
      ? MessageType.DirectMessage
      : MessageType.GroupMessage
  );
  const msgCtx = message?.type === threadType ? message : { ...message, type: threadType };

  const keyword =
    extractCommandBody(msgCtx, prefix, effectiveAlias) || getQuotedText(msgCtx);

  try {
    if (!keyword) {
      return await sendMessageWarningRequest(
        api,
        msgCtx,
        {
          caption: `Vui lòng nhập từ khóa tìm kiếm!\nVí dụ: ${prefix}${effectiveAlias} Node.js là gì`,
        },
        30000
      );
    }

    const normalizedAlias = String(effectiveAlias).trim().toLowerCase();
    const isAiSearch =
      normalizedAlias === "google-search-ai" || normalizedAlias === "aisearch";

    const results = await searchWebMultiSource(keyword, {
      maxResults: isAiSearch ? 6 : 8,
    });

    if (results.length === 0) {
      return await sendMessageWarningRequest(
        api,
        msgCtx,
        { caption: `Không tìm thấy kết quả phù hợp cho từ khóa: "${keyword}"` },
        30000
      );
    }

    if (isAiSearch) {
      const answer = await synthesizeAiSearchAnswer(keyword, results);
      const citations = results
        .map((r, idx) => `[${idx + 1}] ${r.title}\n🔗 ${r.url}`)
        .join("\n\n");
      const responseText =
        `🤖 TỔNG HỢP TÌM KIẾM AI — "${keyword}"\n\n` +
        `${answer}\n\n` +
        `📚 Nguồn trích dẫn:\n${citations}`;

      return await sendMessageCompleteRequest(
        api,
        msgCtx,
        { caption: responseText },
        300000
      );
    }

    const formattedItems = results
      .map(
        (r, idx) =>
          `${idx + 1}. ${r.title}\n` +
          (r.snippet ? `📝 ${r.snippet}\n` : "") +
          `🔗 ${r.url}`
      )
      .join("\n\n");

    const responseText = `🔎 Kết quả tìm kiếm cho "${keyword}":\n\n${formattedItems}`;
    await sendMessageCompleteRequest(api, msgCtx, { caption: responseText }, 180000);
  } catch (error) {
    await sendMessageWarningRequest(
      api,
      msgCtx,
      { caption: `Đã xảy ra lỗi khi tìm kiếm: ${error?.message || "Vui lòng thử lại sau!"}` },
      30000
    );
  }
}
