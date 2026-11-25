import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import QRCode from "qrcode";
import { createCanvas } from "canvas";
import {
  sendMessageCompleteRequest,
  sendMessageWarningRequest,
} from "../chat-zalo/chat-style/chat-style.js";
import { tempDir } from "../../utils/io-json.js";
import { getGlobalPrefix } from "../service.js";
import { deleteFile } from "../../utils/util.js";
import { ensureCanvasFontsRegistered } from "../../utils/canvas/register-fonts.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import {
  safeThreadType,
  extractCommandBody,
  getQuoteData,
  getQuotedText,
} from "../../commands/shared/command-input-utils.js";

const CONFIG = {
  TIMEOUTS: {
    WARNING: 30000,
    IMAGE: 3600000,
  },
};

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

function drawHeartShape(ctx, cx, cy, size, color, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  const topCurveHeight = size * 0.3;
  ctx.moveTo(cx, cy + topCurveHeight);
  ctx.bezierCurveTo(
    cx,
    cy,
    cx - size / 2,
    cy,
    cx - size / 2,
    cy + topCurveHeight
  );
  ctx.bezierCurveTo(
    cx - size / 2,
    cy + (size + topCurveHeight) / 2,
    cx,
    cy + (size + topCurveHeight) / 1.45,
    cx,
    cy + size
  );
  ctx.bezierCurveTo(
    cx,
    cy + (size + topCurveHeight) / 1.45,
    cx + size / 2,
    cy + (size + topCurveHeight) / 2,
    cx + size / 2,
    cy + topCurveHeight
  );
  ctx.bezierCurveTo(cx + size / 2, cy, cx, cy, cx, cy + topCurveHeight);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function isFinderModule(row, col, size) {
  if (row < 7 && col < 7) return true;
  if (row < 7 && col >= size - 7) return true;
  if (row >= size - 7 && col < 7) return true;
  return false;
}

function drawFinderPattern(ctx, originX, originY, startRow, startCol, qrModules, cellSize) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      if (!qrModules.get(startRow + r, startCol + c)) continue;
      const isCenter3x3 = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      ctx.fillStyle = isCenter3x3 ? "#5C0A26" : "#360516";
      ctx.fillRect(originX + c * cellSize, originY + r * cellSize, cellSize, cellSize);
    }
  }
}

function wrapCaptionLines(ctx, text, maxWidth) {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return [];
  const words = cleaned.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 4);
}

export async function generateQRHeartBuffer(text, caption = "") {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Nội dung QR không hợp lệ");
  }

  ensureCanvasFontsRegistered();

  const qrData = QRCode.create(text.trim(), { errorCorrectionLevel: "H" });
  const moduleCount = qrData.modules.size;
  const quietZone = 4;
  const cellSize = Math.max(11, Math.floor(520 / (moduleCount + quietZone * 2)));
  const qrBoxSize = (moduleCount + quietZone * 2) * cellSize;
  const outerMargin = 54;
  const headerHeight = 82;

  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext("2d");
  measureCtx.font = "bold 24px BeVietnamPro, sans-serif";
  const captionLines = wrapCaptionLines(measureCtx, caption, qrBoxSize - 16);
  const footerHeight = captionLines.length > 0 ? captionLines.length * 34 + 54 : 44;

  const canvasWidth = qrBoxSize + outerMargin * 2;
  const canvasHeight = headerHeight + qrBoxSize + footerHeight;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  const bgGrad = ctx.createLinearGradient(0, 0, canvasWidth, canvasHeight);
  bgGrad.addColorStop(0, "#FFE6EF");
  bgGrad.addColorStop(0.5, "#FFC8DC");
  bgGrad.addColorStop(1, "#FFB3CE");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const decorSpots = [
    [28, 22, 22, 0.28],
    [canvasWidth - 30, 26, 20, 0.25],
    [24, canvasHeight / 2, 18, 0.22],
    [canvasWidth - 24, canvasHeight / 2 + 30, 22, 0.22],
    [34, canvasHeight - 40, 20, 0.26],
    [canvasWidth - 36, canvasHeight - 42, 22, 0.26],
  ];
  for (const [hx, hy, hs, ha] of decorSpots) {
    drawHeartShape(ctx, hx, hy, hs, "#E63971", ha);
  }

  drawHeartShape(ctx, canvasWidth / 2 - 96, 26, 26, "#D81B60", 0.95);
  drawHeartShape(ctx, canvasWidth / 2 + 96, 26, 26, "#D81B60", 0.95);
  ctx.fillStyle = "#880E4F";
  ctx.font = "bold 24px BeVietnamPro, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("QR HEART", canvasWidth / 2, 42);

  const qrBoxX = outerMargin;
  const qrBoxY = headerHeight;

  ctx.save();
  ctx.shadowColor = "rgba(136, 14, 79, 0.16)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.roundRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, 22);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "#FF9EBF";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, 22);
  ctx.stroke();

  const matrixOriginX = qrBoxX + quietZone * cellSize;
  const matrixOriginY = qrBoxY + quietZone * cellSize;

  drawFinderPattern(ctx, matrixOriginX, matrixOriginY, 0, 0, qrData.modules, cellSize);
  drawFinderPattern(
    ctx,
    matrixOriginX + (moduleCount - 7) * cellSize,
    matrixOriginY,
    0,
    moduleCount - 7,
    qrData.modules,
    cellSize
  );
  drawFinderPattern(
    ctx,
    matrixOriginX,
    matrixOriginY + (moduleCount - 7) * cellSize,
    moduleCount - 7,
    0,
    qrData.modules,
    cellSize
  );

  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (isFinderModule(row, col, moduleCount)) continue;
      if (!qrData.modules.get(row, col)) continue;

      const x = matrixOriginX + col * cellSize;
      const y = matrixOriginY + row * cellSize;

      if (row === 6 || col === 6) {
        ctx.fillStyle = "#360516";
        ctx.fillRect(x, y, cellSize, cellSize);
        continue;
      }

      const inset = cellSize * 0.04;
      const dotSize = cellSize - inset * 2;
      ctx.fillStyle = (row + col) % 2 === 0 ? "#4D0820" : "#3B0618";
      ctx.beginPath();
      ctx.roundRect(x + inset, y + inset, dotSize, dotSize, cellSize * 0.22);
      ctx.fill();
    }
  }

  if (moduleCount >= 25) {
    const badgeCells = 3;
    const badgeSize = badgeCells * cellSize;
    const badgeX = matrixOriginX + (moduleCount * cellSize) / 2 - badgeSize / 2;
    const badgeY = matrixOriginY + (moduleCount * cellSize) / 2 - badgeSize / 2;

    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.roundRect(badgeX, badgeY, badgeSize, badgeSize, badgeSize * 0.35);
    ctx.fill();

    ctx.strokeStyle = "#F48FB1";
    ctx.lineWidth = 2;
    ctx.stroke();

    drawHeartShape(
      ctx,
      badgeX + badgeSize / 2,
      badgeY + badgeSize * 0.2,
      badgeSize * 0.6,
      "#D81B60",
      1
    );
  }

  if (captionLines.length > 0) {
    ctx.fillStyle = "#7A0F32";
    ctx.font = "bold 24px BeVietnamPro, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const startCaptionY = qrBoxY + qrBoxSize + 18;
    captionLines.forEach((line, idx) => {
      ctx.fillText(line, canvasWidth / 2, startCaptionY + idx * 34);
    });
  }

  return canvas.toBuffer("image/png");
}

export async function generateQRHeartWithAPI(text, caption = "", outputPath = null) {
  const pngBuffer = await generateQRHeartBuffer(text, caption);
  const qrPath =
    outputPath || path.join(tempDir, `qrheart_${crypto.randomUUID()}.png`);
  await fs.promises.mkdir(path.dirname(qrPath), { recursive: true });
  await fs.promises.writeFile(qrPath, pngBuffer);
  return qrPath;
}

export const generateQRHeartImage = generateQRHeartWithAPI;

function extractQuotedQrInput(message) {
  const quote = getQuoteData(message);
  if (!quote) return "";
  if (quote.attach) {
    try {
      const parsed =
        typeof quote.attach === "string" ? JSON.parse(quote.attach) : quote.attach;
      const candidate = parsed?.href || parsed?.title || parsed?.description || "";
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    } catch {}
  }
  return getQuotedText(message);
}

export async function handleCreateQRHeartCommand(api, message, aliasCommand = "qrheart") {
  const prefix = getGlobalPrefix();
  const effectiveAlias = aliasCommand || "qrheart";
  const msgCtx = withSafeMessageType(message);
  let rawInput = extractCommandBody(msgCtx, prefix, effectiveAlias);
  let qrPath = null;
  let caption = "";

  try {
    if (!rawInput) {
      rawInput = extractQuotedQrInput(msgCtx);
    }

    if (rawInput.includes("|")) {
      const pipeIdx = rawInput.indexOf("|");
      caption = rawInput.slice(pipeIdx + 1).trim();
      rawInput = rawInput.slice(0, pipeIdx).trim();
    }

    if (!rawInput) {
      await sendMessageWarningRequest(
        api,
        msgCtx,
        {
          caption:
            `Vui lòng nhập nội dung cần tạo QR hoặc reply tin nhắn chứa nội dung hợp lệ.\n` +
            `Ví dụ: ${prefix}${effectiveAlias} Anh yêu em | Kỷ niệm`,
        },
        CONFIG.TIMEOUTS.WARNING
      );
      return;
    }

    qrPath = await generateQRHeartImage(rawInput, caption);

    await sendMessageCompleteRequest(
      api,
      msgCtx,
      {
        caption: "💖 Đây là mã QR trái tim của bạn!",
        imagePath: qrPath,
      },
      CONFIG.TIMEOUTS.IMAGE
    );
  } catch (error) {
    await sendMessageWarningRequest(
      api,
      msgCtx,
      {
        caption: `Đã xảy ra lỗi khi tạo mã QR: ${error?.message || "Không xác định"}`,
      },
      CONFIG.TIMEOUTS.WARNING
    );
  } finally {
    if (qrPath) {
      await deleteFile(qrPath).catch(() => {});
    }
  }
}

export default {
  generateQRHeartBuffer,
  generateQRHeartImage,
  generateQRHeartWithAPI,
  handleCreateQRHeartCommand,
};
