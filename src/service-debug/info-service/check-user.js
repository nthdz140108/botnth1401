// Tên file: check-user.js

import crypto from "node:crypto";
import { createCanvas, loadImage } from "canvas";
import fs from "fs";
import path from "path";
import * as cv from "../../utils/canvas/index.js";
import { ensureCanvasFontsRegistered } from "../../utils/canvas/register-fonts.js";
import { tempDir } from "../../utils/io-json.js";
import { getUserInfoData } from "./user-info.js";
import { extractCleanArgs, resolveTargetUsers, safeThreadType } from "../../commands/shared/command-input-utils.js";
import { getGlobalPrefix } from "../service.js";

export async function handleCheckCommand(api, message, aliasCommand) {
    const threadId = message.threadId;
    const prefix = getGlobalPrefix();
    const threadType = safeThreadType(message);
    let imagePath = null;

    try {
        const cleanArgs = extractCleanArgs(message, prefix, aliasCommand || "check");
        const resolvedTargets = resolveTargetUsers(message, cleanArgs);
        const targetUserId = resolvedTargets[0] || message.data?.uidFrom;

        if (!targetUserId) {
            await sendErrorMessage(
                api,
                message,
                threadId,
                `❌ Không xác định được người dùng cần kiểm tra.`
            );
            return;
        }

        const userInfo = await getUserInfoData(api, targetUserId);
        if (!userInfo) {
            await sendErrorMessage(api, message, threadId, "❌ Không thể lấy thông tin người dùng này.");
            return;
        }

        const percent = Math.floor(Math.random() * 151); // Random 0 -> 150%
        const checkTitle = userInfo.genderId === 0 ? "Gay" : "Less";
        const description = getCheckDescription(percent, checkTitle);
        const fullTitle = `Kết Quả Check ${checkTitle.charAt(0).toUpperCase() + checkTitle.slice(1)}`;

        imagePath = await createCheckImage(userInfo, fullTitle, percent, description);
        await api.sendMessage({ msg: "", attachments: [imagePath], ttl: 3600000 }, threadId, threadType);

    } catch (error) {
        console.error("Lỗi khi thực hiện lệnh check:", error);
        await sendErrorMessage(
            api,
            message,
            threadId,
            "❌ Đã xảy ra lỗi khi check. Vui lòng thử lại sau."
        );
    } finally {
        if (imagePath) {
            try {
                await fs.promises.unlink(imagePath);
            } catch {}
        }
    }
}

function getCheckDescription(percent, title) {
    const term = title.toLowerCase();
    if (percent === 0) return `Hoàn toàn bình thường. Chúc mừng bạn!`;
    if (percent <= 10) return `Chỉ ${percent}%. Chắc là chút nhầm lẫn thôi.`;
    if (percent <= 20) return `Dưới 20%... Có chút dấu hiệu lạ...`;
    if (percent <= 30) return `Hmm, ${percent}% rồi. Cần xem xét lại bản thân.`;
    if (percent <= 40) return `Con số này bắt đầu đáng nghi ngại.`;
    if (percent <= 50) return `Đạt mốc 50%. Nửa này nửa kia rồi!`;
    if (percent <= 60) return `Trên 50%. Thiên hướng ${term} bắt đầu rõ rệt.`;
    if (percent <= 70) return `Đã 70%! Xác định rồi đấy!`;
    if (percent <= 80) return `${percent}%... Không thể chối cãi!`;
    if (percent <= 90) return `Gần 90%! Đích thị là ${term} chính hiệu!`;
    if (percent < 100) return `Trên 90%! Chỉ chờ ngày công khai thôi.`;
    if (percent === 100) return `100% ${term}. Chuẩn không cần chỉnh!`;
    if (percent <= 120) return `Vượt 100%. Bạn là ${term} siêu cấp!`;
    if (percent < 150) return `Bạn có ${percent}% ${term}. Đã vượt ngưỡng bình thường!`;
    if (percent === 150) return `150%! ĐỈNH CỦA CHÓP! VUA CỦA ${title.toUpperCase()}!`;
    return "Không xác định";
}

function drawRainbowBadge(ctx, x, y, width = 34, height = 22) {
    const stripes = ["#E40303", "#FF8C00", "#FFED00", "#008026", "#24408E", "#732982"];
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, width, height, 4);
    } else {
        ctx.rect(x, y, width, height);
    }
    ctx.clip();
    const stripeHeight = height / stripes.length;
    stripes.forEach((color, idx) => {
        ctx.fillStyle = color;
        ctx.fillRect(x, y + idx * stripeHeight, width, Math.ceil(stripeHeight));
    });
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
        ctx.roundRect(x, y, width, height, 4);
    } else {
        ctx.rect(x, y, width, height);
    }
    ctx.stroke();
    ctx.restore();
}

function drawCircleDotBadge(ctx, cx, cy, radius, fillColor) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = fillColor;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#FFFFFF";
    ctx.stroke();
    ctx.restore();
}

async function createCheckImage(userInfo, checkTitle, percent, description) {
    ensureCanvasFontsRegistered();
    const width = 1000;
    const height = 450;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const isValidUrl = (url) => typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));

    if (userInfo.cover && isValidUrl(userInfo.cover)) {
        try {
            const cover = await loadImage(userInfo.cover);
            ctx.drawImage(cover, 0, 0, width, height);
            ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
            ctx.fillRect(0, 0, width, height);
        } catch {
            const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
            bgGrad.addColorStop(0, "#4a00e0");
            bgGrad.addColorStop(1, "#8e2de2");
            ctx.fillStyle = bgGrad;
            ctx.fillRect(0, 0, width, height);
        }
    } else {
        const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
        bgGrad.addColorStop(0, "#4a00e0");
        bgGrad.addColorStop(1, "#8e2de2");
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);
    }

    const avatarX = 200;
    const avatarY = height / 2;
    const avatarSize = 180;
    const borderWidth = 10;

    if (userInfo.avatar && isValidUrl(userInfo.avatar)) {
        try {
            const avatar = await loadImage(userInfo.avatar);
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX, avatarY, avatarSize / 2 + borderWidth, 0, Math.PI * 2, true);
            ctx.fillStyle = "#FFC300";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(avatarX, avatarY, avatarSize / 2, 0, Math.PI * 2, true);
            ctx.clip();
            ctx.drawImage(avatar, avatarX - avatarSize / 2, avatarY - avatarSize / 2, avatarSize, avatarSize);
            ctx.restore();
        } catch (error) {
            console.error("Lỗi load avatar for check:", error);
        }
    }

    ctx.font = "bold 40px BeVietnamPro";
    const textGrad = ctx.createLinearGradient(0, 0, width, 0);
    textGrad.addColorStop(0, "#FFFF00");
    textGrad.addColorStop(1, "#00FF00");
    ctx.fillStyle = textGrad;
    ctx.textAlign = "center";
    ctx.fillText(checkTitle, width / 2, 70);

    const infoX = 420;
    let currentY = 150;
    ctx.textAlign = "left";

    // 1. Tên (vector badge + text)
    drawCircleDotBadge(ctx, infoX + 12, currentY - 9, 9, "#38bdf8");
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillStyle = "#33FF33";
    const nameLabel = "Tên: ";
    const nameTextX = infoX + 32;
    ctx.fillText(nameLabel, nameTextX, currentY);
    const nameLabelWidth = ctx.measureText(nameLabel).width;

    ctx.fillStyle = "#FFFFFF";
    const [nameLine1] = cv.hanldeNameUser(userInfo.name || "Người dùng");
    ctx.fillText(nameLine1, nameTextX + nameLabelWidth, currentY);
    currentY += 70;

    // 2. Mức độ (vector rainbow flag badge + text)
    drawRainbowBadge(ctx, infoX, currentY - 21, 32, 22);
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillStyle = "#33FF33";
    const percentLabel = "Mức độ: ";
    const percentTextX = infoX + 42;
    ctx.fillText(percentLabel, percentTextX, currentY);
    const percentLabelWidth = ctx.measureText(percentLabel).width;

    ctx.fillStyle = "#FFD700";
    ctx.font = "bold 52px BeVietnamPro";
    ctx.fillText(`${percent}%`, percentTextX + percentLabelWidth + 5, currentY + 8);
    currentY += 70;

    // 3. Nhận xét (vector badge + text)
    drawCircleDotBadge(ctx, infoX + 12, currentY - 9, 9, "#f472b6");
    ctx.font = "bold 28px BeVietnamPro";
    ctx.fillStyle = "#33FF33";
    ctx.fillText("Nhận xét:", infoX + 32, currentY);
    currentY += 45;

    ctx.font = "italic 26px BeVietnamPro";
    ctx.fillStyle = "#FFFFFF";
    const { lines } = cv.handleNameLong(description, 35);
    for (const line of lines) {
        ctx.fillText(line, infoX, currentY);
        currentY += 35;
        if (currentY > height - 20) break;
    }

    const saveDir = tempDir || path.resolve(process.cwd(), "assets", "temp");
    await fs.promises.mkdir(saveDir, { recursive: true });
    const filePath = path.join(saveDir, `user_check_${crypto.randomUUID()}.png`);

    const out = fs.createWriteStream(filePath);
    const stream = canvas.createPNGStream();
    stream.pipe(out);
    return new Promise((resolve, reject) => {
        out.on("finish", () => resolve(filePath));
        out.on("error", reject);
    });
}

async function sendErrorMessage(api, message, threadId, errorMsg) {
    await api.sendMessage({ msg: errorMsg, quote: message, ttl: 30000 }, threadId, safeThreadType(message));
}