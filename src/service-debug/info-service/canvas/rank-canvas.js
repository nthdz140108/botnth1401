// rank-canvas.js
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import { loadImageBuffer } from "../../../utils/util.js";
import { getUserInfoData } from "../user-info-data.js";

export async function createRankImage(rankData, title, api, width = 800) {
  const ctxTemp = createCanvas(999, 999).getContext("2d");

  const space = 90;
  let yTemp = 60;

  ctxTemp.font = "bold 28px Tahoma";

  for (const user of rankData) {
    const userText = `${user.UserName}: ${
      title === "🏆 Bảng xếp hạng tin nhắn hôm nay:"
        ? user.messageCountToday
        : user.Rank
    } tin nhắn`;
    const lineWidth = space + ctxTemp.measureText(userText).width;
    if (lineWidth > width) {
      yTemp += 70;
    }
    yTemp += 70;
  }

  yTemp += 60;

  const height = yTemp > 430 ? yTemp : 430;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Background
  const backgroundGradient = ctx.createLinearGradient(0, 0, 0, height);
  backgroundGradient.addColorStop(0, "#0A0A0A");
  backgroundGradient.addColorStop(1, "#121212");
  ctx.fillStyle = backgroundGradient;
  ctx.fillRect(0, 0, width, height);

  let y = 60;

  ctx.textAlign = "left";
  ctx.font = "bold 28px Tahoma";
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(title, 20, y);

  y += 50;

  ctx.textAlign = "left";
  ctx.font = "bold 24px Tahoma";
  ctx.fillStyle = "#D0D0D0";

  for (const [index, user] of rankData.entries()) {
    try {
      let avatarImg = null;
      if (api && user.UID) {
        try {
          const userInfo = await getUserInfoData(api, user.UID);
          if (userInfo && userInfo.avatar) {
            const buffer = await loadImageBuffer(userInfo.avatar);
            if (buffer) {
              avatarImg = await loadImage(buffer);
            }
          }
        } catch {}
      }

      // Draw circular avatar or fallback letter
      const avSize = 48;
      const avX = 20;
      const avY = y - 24;

      ctx.save();
      ctx.beginPath();
      ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      if (avatarImg) {
        ctx.drawImage(avatarImg, avX, avY, avSize, avSize);
      } else {
        ctx.fillStyle = "#3b82f6";
        ctx.fillRect(avX, avY, avSize, avSize);
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 22px Tahoma";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const char = String(user.UserName || "?").trim().charAt(0).toUpperCase() || "?";
        ctx.fillText(char, avX + avSize / 2, avY + avSize / 2 + 1);
      }
      ctx.restore();

      ctx.beginPath();
      ctx.arc(avX + avSize / 2, avY + avSize / 2, avSize / 2, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.font = "bold 24px Tahoma";
      ctx.fillStyle = index === 0 ? "#fbbf24" : index === 1 ? "#94a3b8" : index === 2 ? "#d97706" : "#e2e8f0";

      const userText = `${index + 1}. ${user.UserName}: ${
        title === "🏆 Bảng xếp hạng tin nhắn hôm nay:"
          ? user.messageCountToday
          : user.Rank
      } tin nhắn`;
      ctx.fillText(userText, space, y + 10);
      y += 70;
    } catch (error) {
      console.error("Lỗi khi tải hoặc vẽ ảnh đại diện rank:", error);
    }
  }

  const filePath = path.resolve(`./assets/temp/rank_${Date.now()}.png`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const out = fs.createWriteStream(filePath);
  const stream = canvas.createPNGStream();
  stream.pipe(out);
  return new Promise((resolve, reject) => {
    out.on("finish", () => resolve(filePath));
    out.on("error", reject);
  });
}