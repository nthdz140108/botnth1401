import fs from "node:fs";
import fetch from "node-fetch";
import { LRUCache } from "lru-cache";
import { createCanvas } from "canvas";
import * as cv from "../../utils/canvas/index.js";
import { ensureCanvasFontsRegistered } from "../../utils/canvas/register-fonts.js";
import { sendMessageTag, sendMessageStateQuote } from "../chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../service.js";
import { getBotId } from "../../utils/env.js";
import { withTempFile } from "../../utils/temp-lease-manager.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { safeThreadType, extractCommandBody } from "../../commands/shared/command-input-utils.js";

const PNJ_GOLD_API_BASE = "https://edge-api.pnj.io/ecom-frontend/v1/get-gold-price";
const TTL_MESSAGE = 10 * 60 * 1000;
const goldPriceCache = new LRUCache({ max: 32, ttl: 5 * 60 * 1000 });

export const GOLD_FILTERS = Object.freeze({
  all: { zone: "00", label: "GIÁ VÀNG TOÀN QUỐC / TP.HCM", filter: null },
  hcm: { zone: "00", label: "GIÁ VÀNG TP.HCM", filter: null },
  tphcm: { zone: "00", label: "GIÁ VÀNG TP.HCM", filter: null },
  sg: { zone: "00", label: "GIÁ VÀNG TP.HCM", filter: null },
  hn: { zone: "11", label: "GIÁ VÀNG HÀ NỘI", filter: null },
  hanoi: { zone: "11", label: "GIÁ VÀNG HÀ NỘI", filter: null },
  dn: { zone: "14", label: "GIÁ VÀNG ĐÀ NẴNG", filter: null },
  danang: { zone: "14", label: "GIÁ VÀNG ĐÀ NẴNG", filter: null },
  mt: { zone: "07", label: "GIÁ VÀNG MIỀN TÂY", filter: null },
  mientay: { zone: "07", label: "GIÁ VÀNG MIỀN TÂY", filter: null },
  cantho: { zone: "07", label: "GIÁ VÀNG CẦN THƠ / MIỀN TÂY", filter: null },
  tn: { zone: "21", label: "GIÁ VÀNG TÂY NGUYÊN", filter: null },
  taynguyen: { zone: "21", label: "GIÁ VÀNG TÂY NGUYÊN", filter: null },
  dnb: { zone: "13", label: "GIÁ VÀNG ĐÔNG NAM BỘ", filter: null },
  sjc: { zone: "00", label: "GIÁ VÀNG SJC", filter: /sjc/i },
  pnj: { zone: "00", label: "GIÁ VÀNG PNJ & NHẪN 24K", filter: /pnj|nhẫn|24k|999|18k|14k|10k/i },
  "24k": { zone: "00", label: "GIÁ VÀNG 24K / 999.9", filter: /24k|999/i },
  "18k": { zone: "00", label: "GIÁ VÀNG 18K / 750", filter: /18k|750/i },
});

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

function formatPriceValue(raw) {
  if (raw === undefined || raw === null || raw === "") return "N/A";
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw.toLocaleString("vi-VN");
  }
  const str = String(raw).trim();
  const cleanDigits = str.replace(/[.,\s]/g, "");
  if (/^\d+$/.test(cleanDigits)) {
    const num = Number(cleanDigits);
    if (Number.isFinite(num) && num > 0) {
      return num.toLocaleString("vi-VN");
    }
  }
  return str || "N/A";
}

function extractRowsFromPnjPayload(payload) {
  if (!payload || typeof payload !== "object") return { rows: [], updatedAt: "" };
  const candidateArrays = [
    payload.data,
    payload.items,
    payload.prices,
    payload.result?.data,
    payload.result,
  ];
  const rawList = candidateArrays.find((arr) => Array.isArray(arr) && arr.length > 0) || [];

  let updatedAt = String(
    payload.updateDate ||
      payload.updatedAt ||
      payload.updated_at ||
      payload.chinhanh ||
      ""
  ).trim();

  const rows = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object") continue;
    const name = String(
      item.tensp ?? item.name ?? item.title ?? item.type ?? item.loai ?? item.masp ?? ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!name) continue;

    const buyRaw =
      item.giamua ?? item.gia_mua ?? item.buy ?? item.buyPrice ?? item.buyingPrice;
    const sellRaw =
      item.giaban ?? item.gia_ban ?? item.sell ?? item.sellPrice ?? item.sellingPrice;

    if (!updatedAt) {
      updatedAt = String(
        item.updated_at ?? item.updateDate ?? item.createDate ?? item.ngaycapnhat ?? ""
      ).trim();
    }

    rows.push({
      code: String(item.masp ?? item.code ?? "").trim(),
      name,
      buy: formatPriceValue(buyRaw),
      sell: formatPriceValue(sellRaw),
    });
  }

  return { rows, updatedAt };
}

export async function fetchGoldPrice(zone = "00") {
  const safeZone = String(zone || "00").trim();
  const cacheKey = `pnj_zone_${safeZone}`;
  const cached = goldPriceCache.get(cacheKey);
  if (cached) return cached;

  const url = `${PNJ_GOLD_API_BASE}?zone=${encodeURIComponent(safeZone)}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    throw new Error(`PNJ API trả mã lỗi HTTP ${res.status}`);
  }

  const payload = await res.json();
  const { rows, updatedAt } = extractRowsFromPnjPayload(payload);
  if (!rows.length) {
    throw new Error("Không tìm thấy dữ liệu giá vàng từ hệ thống PNJ");
  }

  const result = {
    rows,
    updatedAt:
      updatedAt ||
      new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
  };
  goldPriceCache.set(cacheKey, result);
  return result;
}

export async function createGoldImage(goldTypeName, pricesInput, targetPath = null, meta = {}) {
  ensureCanvasFontsRegistered();

  const prices = Array.isArray(pricesInput)
    ? pricesInput
    : Array.isArray(pricesInput?.rows)
      ? pricesInput.rows
      : [];
  const updatedAt =
    meta.updatedAt ||
    pricesInput?.updatedAt ||
    new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

  const canvasWidth = 1140;
  const rowH = 54;
  const headerH = 110;
  const footerH = 44;
  const padding = 24;

  const tempCanvas = createCanvas(10, 10);
  const tempCtx = tempCanvas.getContext("2d");
  tempCtx.font = "bold 20px BeVietnamPro, sans-serif";

  let maxTextWidth = 500;
  for (const p of prices) {
    const w = tempCtx.measureText(String(p.name || "")).width + padding * 2;
    if (w > maxTextWidth) maxTextWidth = w;
  }

  const col1Width = Math.max(500, Math.min(maxTextWidth, canvasWidth - 420));
  const remaining = canvasWidth - col1Width;
  const col2Width = Math.floor(remaining / 2);
  const col3Width = remaining - col2Width;

  const columns = [
    { name: "Loại vàng", width: col1Width },
    { name: "Mua vào (nghìn đ/chỉ)", width: col2Width },
    { name: "Bán ra (nghìn đ/chỉ)", width: col3Width },
  ];

  const canvasHeight = headerH + rowH * (prices.length + 1) + footerH;
  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight);
  gradient.addColorStop(0, "#0F172A");
  gradient.addColorStop(0.5, "#1E293B");
  gradient.addColorStop(1, "#0B1120");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  ctx.font = "bold 34px BeVietnamPro, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = cv.getRandomGradient ? cv.getRandomGradient(ctx, canvasWidth) : "#FACC15";
  ctx.fillText(`BẢNG ${String(goldTypeName || "GIÁ VÀNG").toUpperCase()}`, canvasWidth / 2, 48);

  ctx.font = "16px BeVietnamPro, sans-serif";
  ctx.fillStyle = "#CBD5E1";
  ctx.fillText(`Cập nhật: ${updatedAt}  •  Nguồn: PNJ Live`, canvasWidth / 2, 84);

  const xPos = [0];
  for (let i = 0; i < columns.length; i++) {
    xPos.push(xPos[i] + columns[i].width);
  }

  ctx.fillStyle = "rgba(250, 204, 21, 0.16)";
  ctx.fillRect(0, headerH, canvasWidth, rowH);
  ctx.font = "bold 20px BeVietnamPro, sans-serif";
  ctx.textAlign = "center";
  columns.forEach((col, i) => {
    ctx.fillStyle = "#FEF08A";
    ctx.fillText(col.name, xPos[i] + col.width / 2, headerH + 34);
  });

  ctx.font = "bold 20px BeVietnamPro, sans-serif";
  prices.forEach((p, rowIdx) => {
    const y = headerH + rowH * (rowIdx + 1);
    ctx.fillStyle = rowIdx % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.08)";
    ctx.fillRect(0, y, canvasWidth, rowH);

    ctx.fillStyle = "#FDE047";
    ctx.textAlign = "left";
    ctx.fillText(String(p.name || ""), xPos[0] + 18, y + 34);

    ctx.fillStyle = "#86EFAC";
    ctx.textAlign = "center";
    ctx.fillText(String(p.buy || "N/A"), xPos[1] + columns[1].width / 2, y + 34);

    ctx.fillStyle = "#FCA5A5";
    ctx.fillText(String(p.sell || "N/A"), xPos[2] + columns[2].width / 2, y + 34);
  });

  const tableBottom = headerH + rowH * (prices.length + 1);
  ctx.strokeStyle = "rgba(148, 163, 184, 0.25)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i <= prices.length + 1; i++) {
    const y = headerH + rowH * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();
  }
  for (let i = 1; i < xPos.length - 1; i++) {
    ctx.beginPath();
    ctx.moveTo(xPos[i], headerH);
    ctx.lineTo(xPos[i], tableBottom);
    ctx.stroke();
  }

  ctx.font = "14px BeVietnamPro, sans-serif";
  ctx.fillStyle = "#94A3B8";
  ctx.textAlign = "center";
  ctx.fillText(
    "Gợi ý lọc nhanh: sjc | pnj | hcm | hn | dn | mt | tn",
    canvasWidth / 2,
    tableBottom + 27
  );

  const buffer = canvas.toBuffer("image/png");
  if (targetPath) {
    await fs.promises.writeFile(targetPath, buffer);
    return targetPath;
  }
  return buffer;
}

function getGoldHelpMenu(prefix, aliasCommand) {
  return (
    `💰 TRA CỨU GIÁ VÀNG TRỰC TUYẾN\n\n` +
    `• ${prefix}${aliasCommand} — Bảng tổng hợp toàn quốc\n` +
    `• ${prefix}${aliasCommand} sjc — Giá vàng miếng SJC\n` +
    `• ${prefix}${aliasCommand} pnj — Vàng PNJ / Nhẫn 24K / Trang sức\n` +
    `• ${prefix}${aliasCommand} hcm | hn | dn | mt | tn — Giá theo khu vực`
  );
}

export async function handleCheckGiaVangCommand(api, message, aliasCommand = "checkgiavang") {
  const prefix = getGlobalPrefix(getBotId());
  const effectiveAlias = aliasCommand || "checkgiavang";
  const msgCtx = withSafeMessageType(message);
  const rawArg = extractCommandBody(msgCtx, prefix, effectiveAlias).toLowerCase();
  const filterKey = rawArg.split(/\s+/)[0] || "all";

  if (filterKey === "help" || filterKey === "menu" || filterKey === "?") {
    return sendMessageStateQuote(
      api,
      msgCtx,
      getGoldHelpMenu(prefix, effectiveAlias),
      true,
      120000,
      true
    );
  }

  const preset = GOLD_FILTERS[filterKey];
  if (!preset) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Bộ lọc "${rawArg}" không được hỗ trợ.\n\n${getGoldHelpMenu(prefix, effectiveAlias)}`,
      false,
      120000,
      true
    );
  }

  try {
    const { rows, updatedAt } = await fetchGoldPrice(preset.zone);
    const filteredRows = preset.filter
      ? rows.filter((item) => preset.filter.test(`${item.code} ${item.name}`))
      : rows;
    const displayRows = filteredRows.length > 0 ? filteredRows : rows;

    await withTempFile(
      ".png",
      async (imagePath) => {
        await createGoldImage(preset.label, displayRows, imagePath, { updatedAt });
        await sendMessageTag(
          api,
          msgCtx,
          {
            caption: `💰 ${preset.label} (Cập nhật: ${updatedAt})`,
            imagePath,
          },
          TTL_MESSAGE
        );
      },
      { prefix: `gold_${filterKey}` }
    );
  } catch (err) {
    return sendMessageStateQuote(
      api,
      msgCtx,
      `❌ Không thể lấy dữ liệu ${preset.label}: ${err?.message || "Lỗi kết nối"}`,
      false,
      120000,
      true
    );
  }
}
