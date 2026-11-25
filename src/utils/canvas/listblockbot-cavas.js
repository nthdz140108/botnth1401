import { createCanvas } from "canvas";
import fs from "fs/promises";
import { createCanvasTempPath } from "./temp-path.js";

export async function createBlockedBotListImage(blockedUsers, options = {}) {
  const safeUsers = Array.isArray(blockedUsers) ? blockedUsers : [];
  const limitedBlockedUsers = safeUsers.slice(0, 50);
  const startIndex = Math.max(0, Number(options.startIndex) || 0);
  const page = Number(options.page) || 1;
  const totalPages = Number(options.totalPages) || 1;
  const titleText =
    options.title ||
    (totalPages > 1
      ? `DANH SÁCH BỊ CHẶN BOT (TRANG ${page}/${totalPages})`
      : "DANH SÁCH NGƯỜI DUNG BỊ CHẶN BOT".replace("DUNG", "DÙNG"));

  const width = 660;
  const itemHeight = 80;
  const headerHeight = 70;
  const height = headerHeight + Math.max(1, limitedBlockedUsers.length) * itemHeight + 25;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Nền gradient đen
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(0, 0, 0, 0.85)");
  gradient.addColorStop(1, "rgba(0, 0, 0, 0.96)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Tiêu đề
  ctx.font = "bold 24px Arial";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(titleText, width / 2, headerHeight / 2);

  const moveRight = 30;

  limitedBlockedUsers.forEach((user, index) => {
    const yPos = headerHeight + index * itemHeight + 10;
    const centerY = yPos + (itemHeight - 10) / 2;

    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.beginPath();
    ctx.roundRect(10, yPos, width - 20, itemHeight - 10, 10);
    ctx.fill();

    const numberBoxSize = 32;
    const numberBoxY = centerY - numberBoxSize / 2;
    ctx.fillStyle = "#2ecc71";
    ctx.beginPath();
    ctx.roundRect(20 + moveRight, numberBoxY, numberBoxSize, numberBoxSize, 6);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 16px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${startIndex + index + 1}`, 20 + moveRight + numberBoxSize / 2, numberBoxY + numberBoxSize / 2);

    const avatarSize = 50;
    const avatarX = 65 + moveRight;
    const avatarY = centerY - avatarSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = "#555";
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    ctx.restore();

    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
    ctx.stroke();

    const displayName = String(
      user?.senderName || user?.dName || user?.name || user?.idUserZalo || user?.id || "Không xác định"
    ).trim();
    ctx.font = "bold 20px Arial";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(displayName, avatarX + avatarSize + 20, centerY);
  });

  ctx.font = "bold 16px Arial";
  ctx.fillStyle = "#ffcc00";
  ctx.textAlign = "center";
  ctx.fillText("Tạo bởi: Thanh Hung", width / 2, height - 11);

  const filePath = createCanvasTempPath(`blocked_bot_list_${Date.now()}.png`);
  await fs.writeFile(filePath, canvas.toBuffer());
  return filePath;
}
