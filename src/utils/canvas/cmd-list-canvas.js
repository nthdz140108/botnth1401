import { createCanvas } from "canvas";
import fs from "fs/promises";
import { createCanvasTempPath } from "./temp-path.js";

const COLS = 4;
const ROWS = 4;
const COMMANDS_PER_PAGE = COLS * ROWS;

const W = 1080;
const M = 28;
const HEAD_H = 130;
const FOOT_H = 56;
const COLS_GAP = 14;
const ROWS_GAP = 14;

const CARD_W = (W - M * 2 - COLS_GAP * (COLS - 1)) / COLS;
const CARD_H = 178;
const GRID_H = CARD_H * ROWS + ROWS_GAP * (ROWS - 1);
const H = M + HEAD_H + 20 + GRID_H + FOOT_H + M;

const FONT_TITLE = "bold 36px Arial";
const FONT_SUB = "600 18px Arial";
const FONT_META = "14px Arial";
const FONT_NAME = "bold 18px Arial";
const FONT_DESC = "14px Arial";
const FONT_DESC_2 = "14px Arial";
const FONT_BADGE = "bold 11px Arial";
const FONT_ICON = "32px Arial";
const FONT_FOOT = "14px Arial";

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.closePath();
}

function ellipsize(ctx, text, maxWidth) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  if (ctx.measureText(s).width <= maxWidth) return s;
  let trimmed = s;
  while (trimmed && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed ? `${trimmed}…` : "";
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const words = raw.split(/\s+/);
  const lines = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = words[i];
    if (lines.length === maxLines - 1) {
      break;
    }
    if (ctx.measureText(line).width > maxWidth) {
      while (line && ctx.measureText(`${line}…`).width > maxWidth) {
        line = line.slice(0, -1);
      }
    }
  }
  if (line && lines.length < maxLines) {
    if (ctx.measureText(line).width > maxWidth) {
      while (line && ctx.measureText(`${line}…`).width > maxWidth) {
        line = line.slice(0, -1);
      }
      line = `${line}…`;
    }
    lines.push(line);
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
  }
  if (lines.length === maxLines) {
    let last = lines[maxLines - 1] || "";
    if (ctx.measureText(`${last}…`).width <= maxWidth) {
      lines[maxLines - 1] = `${last}…`;
    } else {
      while (last && ctx.measureText(`…`).width + ctx.measureText(last).width > maxWidth) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = `${last}…`;
    }
  }
  return lines;
}

function drawBackground(ctx) {
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#f8fafc");
  grad.addColorStop(0.5, "#eef4ff");
  grad.addColorStop(1, "#fef6f3");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  const accent = ctx.createRadialGradient(W * 0.15, H * 0.1, 0, W * 0.15, H * 0.1, 360);
  accent.addColorStop(0, "rgba(99, 102, 241, 0.18)");
  accent.addColorStop(1, "rgba(99, 102, 241, 0)");
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, H);

  const accent2 = ctx.createRadialGradient(W * 0.9, H * 0.95, 0, W * 0.9, H * 0.95, 420);
  accent2.addColorStop(0, "rgba(244, 114, 182, 0.16)");
  accent2.addColorStop(1, "rgba(244, 114, 182, 0)");
  ctx.fillStyle = accent2;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function drawHeader(ctx, { title, botName, totalCommands, page, totalPages, isAdminList }) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  ctx.font = FONT_TITLE;
  const grad = ctx.createLinearGradient(M, 0, M + 460, 0);
  grad.addColorStop(0, isAdminList ? "#b91c1c" : "#1d4ed8");
  grad.addColorStop(1, isAdminList ? "#7c3aed" : "#0ea5e9");
  ctx.fillStyle = grad;
  ctx.fillText(title, M, M + 36);

  ctx.font = FONT_SUB;
  ctx.fillStyle = "#1f2937";
  ctx.fillText(`Bot: ${botName || "MyBot"}`, M, M + 68);

  ctx.font = FONT_META;
  ctx.fillStyle = "#475569";
  const listKind = isAdminList ? "Admin" : "Thành viên";
  ctx.fillText(
    `Tổng: ${totalCommands} lệnh ${listKind}   •   Trang ${page}/${totalPages}`,
    M,
    M + 94
  );

  const tag = isAdminList ? "QUYỀN ADMIN" : "QUYỀN ALL";
  roundedRect(ctx, W - M - 130, M + 60, 130, 26, 13);
  ctx.fillStyle = isAdminList ? "rgba(239, 68, 68, 0.12)" : "rgba(59, 130, 246, 0.12)";
  ctx.fill();
  ctx.fillStyle = isAdminList ? "#b91c1c" : "#1d4ed8";
  ctx.font = "bold 14px Arial";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tag, W - M - 65, M + 73);

  ctx.restore();
}

function drawCard(ctx, x, y, w, h, item, isAdminList) {
  roundedRect(ctx, x, y, w, h, 14);
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
  ctx.fill();
  ctx.strokeStyle = "rgba(15, 23, 42, 0.08)";
  ctx.lineWidth = 1;
  ctx.stroke();

  const innerPad = 14;
  const iconBox = 40;
  const iconX = x + innerPad;
  const iconY = y + innerPad;
  roundedRect(ctx, iconX, iconY, iconBox, iconBox, 10);
  const iconGrad = ctx.createLinearGradient(iconX, iconY, iconX + iconBox, iconY + iconBox);
  iconGrad.addColorStop(0, isAdminList ? "#fecaca" : "#dbeafe");
  iconGrad.addColorStop(1, isAdminList ? "#fda4af" : "#a5b4fc");
  ctx.fillStyle = iconGrad;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  roundedRect(ctx, iconX, iconY, iconBox, iconBox, 10);
  ctx.clip();
  ctx.font = FONT_ICON;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#0f172a";
  ctx.fillText(item.icon || "•", iconX + iconBox / 2, iconY + iconBox / 2 + 2);
  ctx.restore();

  const textX = iconX + iconBox + 10;
  const textMaxW = w - (textX - x) - innerPad;

  ctx.font = FONT_NAME;
  ctx.fillStyle = "#0f172a";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(ellipsize(ctx, item.name, textMaxW), textX, y + 32);

  ctx.font = FONT_DESC;
  ctx.fillStyle = "#475569";
  const descMaxW = w - innerPad * 2;
  const lines = wrapText(ctx, item.description || "", descMaxW, 3);
  let lineY = y + 60;
  for (const line of lines) {
    ctx.fillText(line, x + innerPad, lineY);
    lineY += 18;
  }

  const badgeText = isAdminList ? "ADMIN" : "ALL";
  const badgeColor = isAdminList ? "#b91c1c" : "#1d4ed8";
  const badgeBg = isAdminList ? "rgba(239, 68, 68, 0.12)" : "rgba(59, 130, 246, 0.12)";
  ctx.font = FONT_BADGE;
  const badgeW = 50;
  const badgeH = 18;
  const badgeX = x + w - innerPad - badgeW;
  const badgeY = y + h - innerPad - badgeH;
  roundedRect(ctx, badgeX, badgeY, badgeW, badgeH, 9);
  ctx.fillStyle = badgeBg;
  ctx.fill();
  ctx.fillStyle = badgeColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(badgeText, badgeX + badgeW / 2, badgeY + badgeH / 2 + 1);

  ctx.font = FONT_DESC_2;
  ctx.fillStyle = "#64748b";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`CD ${item.countdown ?? 0}s`, x + innerPad, y + h - innerPad);
}

function drawFooter(ctx, prefixStr, isAdminList) {
  const y = H - M - FOOT_H + 18;
  ctx.save();
  ctx.font = FONT_FOOT;
  ctx.fillStyle = "#475569";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(
    `Dùng ${prefixStr}cmd ${isAdminList ? "admin " : ""}[trang] để chuyển trang   •   ${prefixStr}cmd map ${isAdminList ? "admin " : ""}để xem tất cả`,
    M,
    y + 18
  );
  ctx.restore();
}

function normalizeItems(commands) {
  return (commands || []).map((cmd) => ({
    name: String(cmd?.name ?? ""),
    description: String(cmd?.description ?? ""),
    permission: cmd?.permission ?? "all",
    countdown: Number(cmd?.countdown ?? 0),
    icon: String(cmd?.icon ?? "🔖"),
  }));
}

export const CMD_LIST_PAGE_SIZE = COMMANDS_PER_PAGE;

export async function renderCommandListImage({
  pageCommands = [],
  page,
  totalPages,
  totalCommands,
  isAdminList = false,
  botName = "",
  prefix = "!",
} = {}) {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  drawBackground(ctx);
  drawHeader(ctx, {
    title: isAdminList ? "DANH SÁCH LỆNH ADMIN" : "DANH SÁCH LỆNH",
    botName,
    totalCommands,
    page,
    totalPages,
    isAdminList,
  });

  const items = normalizeItems(pageCommands).slice(0, COMMANDS_PER_PAGE);
  const startX = M;
  const startY = M + HEAD_H + 12;

  for (let i = 0; i < items.length; i++) {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const x = startX + col * (CARD_W + COLS_GAP);
    const y = startY + row * (CARD_H + ROWS_GAP);
    drawCard(ctx, x, y, CARD_W, CARD_H, items[i], isAdminList);
  }

  if (items.length === 0) {
    ctx.save();
    ctx.font = "16px Arial";
    ctx.fillStyle = "#64748b";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Chưa có lệnh nào trong trang này.", W / 2, startY + GRID_H / 2);
    ctx.restore();
  }

  drawFooter(ctx, prefix, isAdminList);

  const filePath = createCanvasTempPath(`cmd_list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
  await fs.writeFile(filePath, canvas.toBuffer("image/png"));
  return filePath;
}