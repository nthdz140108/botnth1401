import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import sharp from "sharp";
import { createCanvas, loadImage, registerFont } from "canvas";

import { getGlobalPrefix } from "../service.js";
import { getProjectRoot } from "../../utils/env.js";
import { tempDir } from "../../utils/io-json.js";
import { downloadFile } from "../../utils/util.js";
import {
  sendMessageWarningRequest,
  sendMessageStateQuote,
} from "../chat-zalo/chat-style/chat-style.js";
import {
  ensureCanvasFontsRegistered,
} from "../../utils/canvas/register-fonts.js";
import {
  extractCommandBody,
  getQuoteData,
  safeThreadType,
} from "../../commands/shared/command-input-utils.js";
import { MessageType } from "../../api-zalo/models/index.js";

export const des = {
  name: "cccd",
  type: 1,
  permission: "all",
  countdown: 30,
  active: true,
};

const CARD_WIDTH = 1580;
const CARD_HEIGHT = 1000;
const WATERMARK_TEXT = "MẪU MINH HỌA GIẢI TRÍ";

const ASSETS_PATH = path.join(getProjectRoot(), "assets", "cccd");
const TEMPLATE_FRONT = path.join(ASSETS_PATH, "cccd_mat_truoc.png");
const DEFAULT_AVATAR = path.join(ASSETS_PATH, "avatar.png");

const CUSTOM_FONT_SPECS = [
  { file: "Roboto-Regular.ttf", family: "Roboto", weight: "normal" },
  { file: "Roboto-Bold.ttf", family: "Roboto", weight: "bold" },
  { file: "OCR-B 10 BT.ttf", family: "OCR-B", weight: "normal" },
  { file: "Kanit-Regular.ttf", family: "Kanit", weight: "normal" },
  { file: "Kanit-Thin.ttf", family: "Kanit Thin", weight: "normal" },
  { file: "Kanit-Light.ttf", family: "Kanit Light", weight: "normal" },
  { file: "Kanit-Medium.ttf", family: "Kanit Medium", weight: "normal" },
  { file: "Kanit-SemiBold.ttf", family: "Kanit SemiBold", weight: "normal" },
  { file: "Kanit-Bold.ttf", family: "Kanit Bold", weight: "bold" },
  { file: "Kanit-ExtraBold.ttf", family: "Kanit ExtraBold", weight: "bold" },
  { file: "Kanit-Black.ttf", family: "Kanit Black", weight: "bold" },
];

let cccdFontsInitialized = false;
let hasCustomRoboto = false;
let hasCustomKanitSemiBold = false;

function initCccdFonts() {
  if (cccdFontsInitialized) return;
  ensureCanvasFontsRegistered();

  for (const spec of CUSTOM_FONT_SPECS) {
    const fontPath = path.join(ASSETS_PATH, spec.file);
    if (!fs.existsSync(fontPath)) continue;
    try {
      registerFont(fontPath, { family: spec.family, weight: spec.weight });
      if (spec.family === "Roboto") hasCustomRoboto = true;
      if (spec.family === "Kanit SemiBold") hasCustomKanitSemiBold = true;
    } catch {
      // Ignore duplicate or platform font warnings
    }
  }
  cccdFontsInitialized = true;
}

const TEXT_COLOR_FRONT = "#1f2937";
const AVATAR_POS = [42, 330];
const AVATAR_SIZE = [373, 514];
const QR_POS = [1250, 78];
const QR_SIZE = [222, 222];

function buildFieldLayout() {
  const boldPrimary = hasCustomRoboto
    ? '"Roboto", "BeVietnamPro", "Arial", sans-serif'
    : '"BeVietnamPro", "Arial", sans-serif';
  const semiSecondary = hasCustomKanitSemiBold
    ? '"Kanit SemiBold", "BeVietnamPro", "Arial", sans-serif'
    : '"BeVietnamPro", "NotoSans", "Arial", sans-serif';

  return {
    socccd: { pos: [635, 400], font: `bold 58px ${boldPrimary}`, size: 58, color: "#b91c1c" },
    hovaten: { pos: [455, 533], font: `bold 44px ${boldPrimary}`, size: 44 },
    ngaysinh: { pos: [870, 595], font: `bold 36px ${boldPrimary}`, size: 36 },
    gioitinh: { pos: [735, 659], font: `bold 38px ${boldPrimary}`, size: 38 },
    quoctich: { pos: [1250, 655], font: `bold 38px ${boldPrimary}`, size: 38 },
    quequan: { pos: [455, 770], font: `bold 38px ${semiSecondary}`, size: 38, wrap: 40 },
    ngayhethan: { pos: [235, 865], font: `bold 28px ${semiSecondary}`, size: 28, color: "#1e3a8a" },
    thuongtru: { pos: [455, 875], font: `bold 38px ${semiSecondary}`, size: 38, wrap: 40 },
  };
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawStylizedCardTemplate(ctx, width, height) {
  const bgGradient = ctx.createLinearGradient(0, 0, width, height);
  bgGradient.addColorStop(0, "#eff6ff");
  bgGradient.addColorStop(0.5, "#dbeafe");
  bgGradient.addColorStop(1, "#e0f2fe");

  drawRoundedRect(ctx, 8, 8, width - 16, height - 16, 36);
  ctx.fillStyle = bgGradient;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#93c5fd";
  ctx.stroke();

  // Decorative guilloche wave lines
  ctx.save();
  ctx.strokeStyle = "rgba(59, 130, 246, 0.10)";
  ctx.lineWidth = 2;
  for (let row = 180; row < height - 40; row += 28) {
    ctx.beginPath();
    for (let x = 24; x <= width - 24; x += 20) {
      const y = row + Math.sin((x + row) * 0.015) * 10;
      if (x === 24) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Header band
  const headerGrad = ctx.createLinearGradient(0, 0, width, 0);
  headerGrad.addColorStop(0, "#1d4ed8");
  headerGrad.addColorStop(1, "#0284c7");
  ctx.save();
  drawRoundedRect(ctx, 20, 20, width - 40, 285, 26);
  ctx.fillStyle = "rgba(255, 255, 255, 0.72)";
  ctx.fill();
  ctx.restore();

  // Stylized decorative star emblem
  ctx.save();
  const cx = 195;
  const cy = 160;
  ctx.beginPath();
  ctx.arc(cx, cy, 88, 0, Math.PI * 2);
  ctx.fillStyle = "#fef3c7";
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#f59e0b";
  ctx.stroke();

  ctx.fillStyle = "#ef4444";
  ctx.beginPath();
  for (let i = 0; i < 5; i += 1) {
    const outerAngle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const innerAngle = outerAngle + Math.PI / 5;
    const ox = cx + Math.cos(outerAngle) * 50;
    const oy = cy + Math.sin(outerAngle) * 50;
    const ix = cx + Math.cos(innerAngle) * 20;
    const iy = cy + Math.sin(innerAngle) * 20;
    if (i === 0) ctx.moveTo(ox, oy);
    else ctx.lineTo(ox, oy);
    ctx.lineTo(ix, iy);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Header titles
  ctx.fillStyle = "#1e3a8a";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = 'bold 34px "BeVietnamPro", "Arial", sans-serif';
  ctx.fillText("THẺ ĐỊNH DANH CÁ NHÂN MINH HỌA", 760, 58);
  ctx.font = 'bold 24px "BeVietnamPro", "Arial", sans-serif';
  ctx.fillStyle = "#0369a1";
  ctx.fillText("ILLUSTRATIVE PERSONAL PROFILE CARD", 760, 104);

  ctx.fillStyle = "#b91c1c";
  ctx.font = 'bold 46px "BeVietnamPro", "Arial", sans-serif';
  ctx.fillText("THẺ CĂN CƯỚC MINH HỌA", 760, 170);

  // Badge pill in header
  ctx.save();
  drawRoundedRect(ctx, 560, 235, 400, 44, 22);
  ctx.fillStyle = "#fee2e2";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ef4444";
  ctx.stroke();
  ctx.fillStyle = "#b91c1c";
  ctx.font = 'bold 22px "BeVietnamPro", "Arial", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(WATERMARK_TEXT, 760, 257);
  ctx.restore();

  // Avatar frame
  ctx.save();
  drawRoundedRect(ctx, AVATAR_POS[0] - 6, AVATAR_POS[1] - 6, AVATAR_SIZE[0] + 12, AVATAR_SIZE[1] + 12, 16);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#60a5fa";
  ctx.stroke();
  ctx.restore();

  // QR frame
  ctx.save();
  drawRoundedRect(ctx, QR_POS[0] - 8, QR_POS[1] - 8, QR_SIZE[0] + 16, QR_SIZE[1] + 16, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#93c5fd";
  ctx.stroke();
  ctx.restore();

  // Field labels aligned with DULIEDATAZPXDEV positions
  ctx.fillStyle = "#334155";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const labelFont = 'bold 26px "BeVietnamPro", "Arial", sans-serif';
  ctx.font = labelFont;
  ctx.fillText("Số / No.:", 455, 416);
  ctx.fillText("Họ và tên / Full name:", 455, 492);
  ctx.fillText("Ngày sinh / Date of birth:", 455, 603);
  ctx.fillText("Giới tính / Sex:", 455, 667);
  ctx.fillText("Quốc tịch / Nationality:", 945, 663);
  ctx.fillText("Quê quán / Place of origin:", 455, 732);
  ctx.fillText("Nơi thường trú / Place of residence:", 455, 838);

  ctx.font = 'bold 22px "BeVietnamPro", "Arial", sans-serif';
  ctx.fillText("Có giá trị đến:", 42, 868);
}

function drawTemplateWatermarkOverlay(ctx, width, height) {
  // Prominent diagonal watermark + footer disclaimer
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-Math.PI / 7);
  ctx.font = 'bold 74px "BeVietnamPro", "Arial", sans-serif';
  ctx.fillStyle = "rgba(220, 38, 38, 0.14)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(WATERMARK_TEXT, 0, -90);
  ctx.fillText(WATERMARK_TEXT, 0, 110);
  ctx.restore();

  ctx.save();
  ctx.fillStyle = "rgba(185, 28, 28, 0.85)";
  ctx.font = 'bold 22px "BeVietnamPro", "Arial", sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(`* ${WATERMARK_TEXT} - KHÔNG CÓ GIÁ TRỊ PHÁP LÝ`, width - 36, height - 22);
  ctx.restore();
}

function drawFallbackAvatar(ctx) {
  const [x, y] = AVATAR_POS;
  const [w, h] = AVATAR_SIZE;
  ctx.save();
  ctx.fillStyle = "#cbd5e1";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#64748b";
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h * 0.36, w * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h * 0.95, w * 0.44, Math.PI, 0);
  ctx.fill();
  ctx.restore();
}

function extractQuoteImageUrl(quote) {
  if (!quote || typeof quote !== "object") return null;
  let parsed = null;
  if (quote.attach) {
    if (typeof quote.attach === "object") {
      parsed = quote.attach;
    } else if (typeof quote.attach === "string") {
      try {
        parsed = JSON.parse(quote.attach);
      } catch {
        parsed = null;
      }
    }
  }
  const raw =
    parsed?.hdUrl ||
    parsed?.oriUrl ||
    parsed?.href ||
    parsed?.normalUrl ||
    parsed?.thumb ||
    parsed?.thumbUrl ||
    quote.hdUrl ||
    quote.href ||
    quote.thumb ||
    null;

  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.replace(/\\\//g, "/").trim();
}

export async function handleCccdCommand(api, message, aliasCommand = "fakecccd") {
  const prefix = getGlobalPrefix();
  const cmdName = aliasCommand || "fakecccd";
  const threadType = safeThreadType(message, MessageType.GroupMessage);

  const quote = getQuoteData(message);
  const avatarUrl = extractQuoteImageUrl(quote);

  if (!avatarUrl) {
    await sendMessageWarningRequest(
      api,
      message,
      {
        caption: `❌ Bạn cần reply (trả lời) vào một ảnh để dùng làm ảnh chân dung.`,
      },
      30000,
    );
    return true;
  }

  const argsText = extractCommandBody(message, prefix, cmdName);
  const parts = argsText
    ? argsText.split("|").map((p) => p.trim())
    : [];

  if (parts.length !== 8 || parts.some((p) => !p)) {
    const guide = [
      `❌ Thông tin không đủ hoặc sai định dạng (${parts.length}/8 trường).`,
      `Vui lòng cung cấp đủ 8 trường theo cú pháp:`,
      `${prefix}${cmdName} [Họ và Tên] | [Ngày sinh] | [Giới tính] | [Quốc tịch] | [Quê quán] | [Nơi thường trú] | [Số CCCD] | [Ngày hết hạn]`,
      ``,
      `Ví dụ:`,
      `${prefix}${cmdName} NGUYỄN VĂN A | 01/01/1995 | Nam | Việt Nam | Quận Ba Đình, Hà Nội | Quận Cầu Giấy, Hà Nội | 001095012345 | 01/01/2035`,
    ].join("\n");
    await sendMessageWarningRequest(api, message, { caption: guide }, 60000);
    return true;
  }

  const data = {
    hovaten: parts[0],
    ngaysinh: parts[1],
    gioitinh: parts[2],
    quoctich: parts[3],
    quequan: parts[4],
    thuongtru: parts[5],
    socccd: parts[6],
    ngayhethan: parts[7],
  };

  if (!isValidDate(data.ngaysinh)) {
    await sendMessageWarningRequest(
      api,
      message,
      { caption: "❌ Ngày sinh không hợp lệ (ví dụ ngày không tồn tại trên lịch). Vui lòng nhập đúng định dạng DD/MM/YYYY." },
      30000,
    );
    return true;
  }

  if (!isValidDate(data.ngayhethan)) {
    await sendMessageWarningRequest(
      api,
      message,
      { caption: "❌ Ngày hết hạn không hợp lệ (ví dụ ngày không tồn tại trên lịch). Vui lòng nhập đúng định dạng DD/MM/YYYY." },
      30000,
    );
    return true;
  }

  await sendMessageStateQuote(
    api,
    message,
    "Đang xử lý ảnh minh họa, vui lòng chờ trong giây lát...",
    true,
    15000,
    true,
  );

  let tempAvatarPath = null;
  let tempOutputPath = null;

  try {
    ensureDirectoryExists(tempDir);
    const id = randomUUID();
    tempAvatarPath = path.join(tempDir, `cccd_avatar_${id}.img`);
    await downloadFile(avatarUrl, tempAvatarPath);

    // Chuẩn hóa sang PNG bằng sharp để hỗ trợ cả ảnh .jxl / .webp của Zalo
    const pngAvatarBuffer = await sharp(tempAvatarPath)
      .resize(AVATAR_SIZE[0], AVATAR_SIZE[1], { fit: "cover", position: "centre" })
      .png()
      .toBuffer()
      .catch(() => null);

    data.avatarBuffer = pngAvatarBuffer;
    data.avatar = tempAvatarPath;

    const generatedImageBuffer = await createCccdFront(data);

    tempOutputPath = path.join(tempDir, `cccd_out_${id}.png`);
    fs.writeFileSync(tempOutputPath, generatedImageBuffer);

    await api.sendMessage(
      {
        msg: "",
        attachments: [tempOutputPath],
        quote: message,
        ttl: 1800000,
      },
      message.threadId,
      threadType,
    );
  } catch (error) {
    console.error("[cccd] Lỗi khi tạo ảnh:", error);
    await sendMessageWarningRequest(
      api,
      message,
      { caption: `❌ Đã xảy ra lỗi khi tạo ảnh: ${error.message}` },
      30000,
    );
  } finally {
    if (tempAvatarPath && fs.existsSync(tempAvatarPath)) {
      try {
        fs.unlinkSync(tempAvatarPath);
      } catch {}
    }
    if (tempOutputPath && fs.existsSync(tempOutputPath)) {
      try {
        fs.unlinkSync(tempOutputPath);
      } catch {}
    }
  }

  return true;
}

async function createCccdFront(data) {
  initCccdFonts();

  const useCustomTemplate = fs.existsSync(TEMPLATE_FRONT);
  let canvas;
  let ctx;

  if (useCustomTemplate) {
    const template = await loadImage(TEMPLATE_FRONT);
    canvas = createCanvas(template.width, template.height);
    ctx = canvas.getContext("2d");
    ctx.drawImage(template, 0, 0);
  } else {
    canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    ctx = canvas.getContext("2d");
    drawStylizedCardTemplate(ctx, CARD_WIDTH, CARD_HEIGHT);
  }

  // Vẽ avatar
  let drewAvatar = false;
  if (data.avatarBuffer) {
    try {
      const avatarImg = await loadImage(data.avatarBuffer);
      ctx.drawImage(avatarImg, AVATAR_POS[0], AVATAR_POS[1], AVATAR_SIZE[0], AVATAR_SIZE[1]);
      drewAvatar = true;
    } catch {}
  }
  if (!drewAvatar && data.avatar && fs.existsSync(data.avatar)) {
    try {
      const avatarImg = await loadImage(data.avatar);
      ctx.drawImage(avatarImg, AVATAR_POS[0], AVATAR_POS[1], AVATAR_SIZE[0], AVATAR_SIZE[1]);
      drewAvatar = true;
    } catch {}
  }
  if (!drewAvatar && fs.existsSync(DEFAULT_AVATAR)) {
    try {
      const avatarImg = await loadImage(DEFAULT_AVATAR);
      ctx.drawImage(avatarImg, AVATAR_POS[0], AVATAR_POS[1], AVATAR_SIZE[0], AVATAR_SIZE[1]);
      drewAvatar = true;
    } catch {}
  }
  if (!drewAvatar) {
    drawFallbackAvatar(ctx);
  }

  // Tạo mã QR offline bằng thư viện qrcode
  try {
    const qrPayload = `${data.socccd}|${randomUUID().slice(0, 8)}|${data.hovaten}|${data.ngaysinh.replace(/\//g, "")}|${data.gioitinh}|${data.thuongtru}|${data.ngayhethan.replace(/\//g, "")}`;
    const qrBuffer = await QRCode.toBuffer(qrPayload, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: QR_SIZE[0],
      color: {
        dark: "#111827",
        light: "#00000000",
      },
    });
    const qrImage = await loadImage(qrBuffer);
    ctx.drawImage(qrImage, QR_POS[0], QR_POS[1], QR_SIZE[0], QR_SIZE[1]);
  } catch (qrError) {
    console.error("[cccd] Không thể tạo QR offline:", qrError.message);
  }

  // Vẽ thông tin chữ
  const fieldLayout = buildFieldLayout();
  for (const [key, config] of Object.entries(fieldLayout)) {
    const text = String(data[key] || "");
    ctx.font = config.font;
    ctx.fillStyle = config.color || TEXT_COLOR_FRONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    if (config.wrap) {
      const lines = wrapTextByChars(text, config.wrap);
      let yPos = config.pos[1];
      for (const line of lines) {
        ctx.fillText(line, config.pos[0], yPos);
        yPos += config.size + 8;
      }
    } else {
      ctx.fillText(text, config.pos[0], config.pos[1]);
    }
  }

  if (!useCustomTemplate) {
    drawTemplateWatermarkOverlay(ctx, canvas.width, canvas.height);
  }

  return canvas.toBuffer("image/png");
}

export function isValidDate(dateStr) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dateStr || "").trim());
  if (!match) return false;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);

  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

function ensureDirectoryExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function wrapTextByChars(text, maxChars) {
  const lines = [];
  const words = String(text || "").split(/\s+/).filter(Boolean);
  let currentLine = "";
  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if ((currentLine + " " + word).length <= maxChars) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine.trim());
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine.trim());
  return lines;
}
