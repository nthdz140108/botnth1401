import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import fetch from "node-fetch";
import { createCanvas } from "canvas";
import { getGlobalPrefix } from "../../service.js";
import {
  sendMessageStateQuote,
  sendMessageFailed,
  sendMessageCompleteRequest,
} from "../../chat-zalo/chat-style/chat-style.js";
import { tempDir } from "../../../utils/io-json.js";
import { deleteFile } from "../../../utils/util.js";
import { removeMention } from "../../../utils/format-util.js";
import { normalizeMessageReference } from "../../../utils/interaction-countdown.js";
import { ensureCanvasFontsRegistered } from "../../../utils/canvas/register-fonts.js";
import { MessageType } from "../../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuotedText,
  getRawMessageText,
} from "../../../commands/shared/command-input-utils.js";
import { searchWebMultiSource } from "./google-search.js";

export const des = {
  name: "googlesearchai",
  aliases: ["ggsai"],
  type: 1,
  permission: "all",
  countdown: 10,
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

function matchesGoogleSearchAiCommand(message, prefix, aliasCommand) {
  const cleaned = removeMention(message) || getRawMessageText(message).trim();
  if (!cleaned) return false;
  const alias = escapeRegExp(String(aliasCommand || "googlesearchai").trim());
  return new RegExp(`^\\s*${escapeRegExp(prefix)}\\s*${alias}(?:[\\s_]+|$)`, "i").test(cleaned);
}

async function safeUndoLoadingMessage(api, loadingMessage, contextMessage) {
  if (!loadingMessage || typeof api?.undoMessage !== "function") return;
  try {
    const normalized = normalizeMessageReference(loadingMessage, contextMessage);
    if (!normalized?.data?.msgId && loadingMessage?.messageID) {
      normalized.data = {
        ...(normalized.data || {}),
        msgId: String(loadingMessage.messageID),
        cliMsgId: String(loadingMessage.cliMsgId || loadingMessage.messageID),
      };
    }
    if (normalized?.data?.msgId || normalized?.data?.cliMsgId) {
      await api.undoMessage(normalized);
    }
  } catch {
    // ignore undo failure on ephemeral loading indicator
  }
}

function wrapTextByWidth(ctx, text, maxWidth) {
  const cleaned = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const words = cleaned.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function drawSnippetImage({ title, snippet, source }, uid) {
  ensureCanvasFontsRegistered();
  await fs.promises.mkdir(tempDir, { recursive: true });

  const width = 820;
  const sidePadding = 48;
  const maxTextWidth = width - sidePadding * 2;

  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext("2d");

  measureCtx.font = "bold 28px BeVietnamPro, sans-serif";
  const titleLines = wrapTextByWidth(measureCtx, title, maxTextWidth).slice(0, 3);

  measureCtx.font = "22px BeVietnamPro, sans-serif";
  const snippetLines = wrapTextByWidth(measureCtx, snippet, maxTextWidth).slice(0, 12);

  const height =
    56 +
    titleLines.length * 38 +
    20 +
    snippetLines.length * 34 +
    (source ? 52 : 24) +
    40;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0, "#FFFFFF");
  bgGrad.addColorStop(1, "#F8FAFC");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#CBD5E1";
  ctx.lineWidth = 3;
  ctx.strokeRect(12, 12, width - 24, height - 24);

  let cursorY = 52;
  ctx.fillStyle = "#0F172A";
  ctx.font = "bold 28px BeVietnamPro, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (const line of titleLines) {
    ctx.fillText(line, sidePadding, cursorY);
    cursorY += 38;
  }

  cursorY += 14;
  ctx.fillStyle = "#1E293B";
  ctx.font = "22px BeVietnamPro, sans-serif";
  for (const line of snippetLines) {
    ctx.fillText(line, sidePadding, cursorY);
    cursorY += 34;
  }

  if (source) {
    cursorY += 16;
    ctx.fillStyle = "#2563EB";
    ctx.font = "bold 17px BeVietnamPro, sans-serif";
    ctx.fillText(`Nguồn: ${String(source).slice(0, 72)}`, sidePadding, cursorY);
  }

  const safeUid = String(uid || "user").replace(/[^a-zA-Z0-9_-]/g, "");
  const filePath = path.join(
    tempDir,
    `search_card_${safeUid}_${crypto.randomUUID()}.png`
  );
  await fs.promises.writeFile(filePath, canvas.toBuffer("image/png"));
  return filePath;
}

async function fetchSerpApiHighlight(queryText) {
  const serpApiKey = String(process.env.SERPAPI_API_KEY || "").trim();
  if (!serpApiKey) return null;

  try {
    const apiUrl = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(queryText)}&hl=vi&gl=vn&api_key=${encodeURIComponent(serpApiKey)}`;
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.error) return null;

    const answerBox = json.answer_box;
    const knowledgeGraph = json.knowledge_graph;
    const firstResult = json.organic_results?.[0];

    if (answerBox && (answerBox.answer || answerBox.snippet)) {
      return {
        title: answerBox.title || queryText,
        snippet: answerBox.answer || answerBox.snippet,
        source: answerBox.displayed_link || answerBox.link || "Google Answer",
        url: answerBox.link || "",
      };
    }
    if (knowledgeGraph?.description) {
      return {
        title: knowledgeGraph.title || queryText,
        snippet: knowledgeGraph.description,
        source: knowledgeGraph.type || "Google Knowledge Graph",
        url: knowledgeGraph.description_link || knowledgeGraph.website || "",
      };
    }
    if (firstResult?.snippet || firstResult?.title) {
      return {
        title: firstResult.title || queryText,
        snippet: firstResult.snippet || "Xem chi tiết tại liên kết nguồn.",
        source: firstResult.displayed_link || firstResult.link || "",
        url: firstResult.link || "",
      };
    }
  } catch {
    // Fall back to keyless multi-source search
  }
  return null;
}

export async function handleGooglesearchaiCommand(api, message, aliasCommand = "googlesearchai") {
  const currentPrefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "googlesearchai";

  if (!matchesGoogleSearchAiCommand(message, currentPrefix, effectiveAlias)) {
    return false;
  }

  const msgCtx = withSafeMessageType(message);
  const queryText =
    extractCommandBody(msgCtx, currentPrefix, effectiveAlias) || getQuotedText(msgCtx);

  if (!queryText) {
    const guide = `❌ Vui lòng nhập từ khóa tìm kiếm.\n👉 Ví dụ: ${currentPrefix}${effectiveAlias} Trí tuệ nhân tạo là gì`;
    return sendMessageStateQuote(api, msgCtx, guide, false, 60000, true);
  }

  const loadingMessage = await sendMessageStateQuote(
    api,
    msgCtx,
    `🔍 Đang tìm kiếm "${queryText}", vui lòng chờ...`,
    true,
    30000,
    false
  );

  let imagePath = null;
  const uid = msgCtx?.data?.uidFrom || msgCtx?.sender?.id || "user";

  try {
    let highlight = await fetchSerpApiHighlight(queryText);

    if (!highlight) {
      const fallbackResults = await searchWebMultiSource(queryText, { maxResults: 3 });
      if (fallbackResults.length > 0) {
        const top = fallbackResults[0];
        let hostname = "";
        try {
          hostname = new URL(top.url).hostname;
        } catch {}
        highlight = {
          title: top.title || queryText,
          snippet: top.snippet || "Xem chi tiết tại liên kết đính kèm.",
          source: hostname || top.url,
          url: top.url,
        };
      }
    }

    if (!highlight) {
      await safeUndoLoadingMessage(api, loadingMessage, msgCtx);
      return sendMessageStateQuote(
        api,
        msgCtx,
        `❌ Không tìm thấy kết quả nào cho từ khóa "${queryText}".`,
        false,
        60000,
        true
      );
    }

    imagePath = await drawSnippetImage(highlight, uid);
    await safeUndoLoadingMessage(api, loadingMessage, msgCtx);

    const caption =
      `🔎 Kết quả tìm kiếm cho "${queryText}"` +
      (highlight.url ? `\n🔗 Nguồn: ${highlight.url}` : "");

    return await sendMessageCompleteRequest(
      api,
      msgCtx,
      { caption, imagePath },
      3600000
    );
  } catch (e) {
    await safeUndoLoadingMessage(api, loadingMessage, msgCtx);
    return sendMessageFailed(
      api,
      msgCtx,
      `❌ Lỗi khi tìm kiếm: ${e?.message || "Không xác định"}`,
      true
    );
  } finally {
    if (imagePath) {
      await deleteFile(imagePath).catch(() => {});
    }
  }
}
