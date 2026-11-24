import { createCanvas, loadImage } from "canvas";

import { MessageType } from "../../api-zalo/models/Message.js";
import { sendMessageWarning } from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGroupInfoData } from "../../service-debug/info-service/group-info.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { tempDir } from "../../utils/io-json.js";

async function clearImagePath(filePath) {
  if (!filePath) return;
  const fs = await import("node:fs/promises");
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function createKeyListImage(admins, groupName) {
  const sortedAdmins = [...admins].sort((a, b) => {
    if (a.keyType === "gold" && b.keyType !== "gold") return -1;
    if (a.keyType !== "gold" && b.keyType === "gold") return 1;
    return 0;
  }).slice(0, 50);

  const width = 660;
  const itemHeight = 100;
  const headerHeight = 100;
  const height = headerHeight + sortedAdmins.length * itemHeight + 20;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "#004e92");
  gradient.addColorStop(1, "#000428");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.font = "bold 32px Arial";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(groupName, width / 2, headerHeight / 2 - 15);

  ctx.font = "normal 18px Arial";
  ctx.fillStyle = "#cccccc";
  ctx.fillText("Danh sách các key quản trị", width / 2, headerHeight / 2 + 20);

  const avatars = await Promise.all(sortedAdmins.map(async (admin) => {
    try {
      return admin.avatar ? await loadImage(admin.avatar) : null;
    } catch {
      return null;
    }
  }));

  sortedAdmins.forEach((admin, index) => {
    const yPos = headerHeight + index * itemHeight + 10;
    const centerY = yPos + (itemHeight - 10) / 2;
    ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
    ctx.beginPath();
    ctx.roundRect(10, yPos, width - 20, itemHeight - 10, 10);
    ctx.fill();

    const avatarSize = 70;
    const avatarX = 50;
    const avatarY = centerY - avatarSize / 2;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(avatarX, avatarY, avatarSize, avatarSize, 10);
    ctx.clip();
    if (avatars[index]) ctx.drawImage(avatars[index], avatarX, avatarY, avatarSize, avatarSize);
    else {
      ctx.fillStyle = "#555";
      ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    }
    ctx.restore();

    ctx.strokeStyle = admin.keyType === "gold" ? "#FFD700" : "#C0C0C0";
    ctx.lineWidth = admin.keyType === "gold" ? 4 : 3;
    ctx.beginPath();
    ctx.roundRect(avatarX, avatarY, avatarSize, avatarSize, 10);
    ctx.stroke();

    const textX = avatarX + avatarSize + 20;
    ctx.font = "bold 26px Arial";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.fillText(admin.name, textX, centerY - 15);

    ctx.font = "20px Arial";
    ctx.fillStyle = "#cccccc";
    ctx.fillText(admin.role, textX, centerY + 20);
  });

  const fs = await import("node:fs/promises");
  const filePath = `${tempDir}/key_list_${Date.now()}.png`;
  await fs.mkdir(tempDir, { recursive: true });
  await fs.writeFile(filePath, canvas.toBuffer("image/png"));
  return filePath;
}

export async function handleListKeyCommand(api, message) {
  const threadId = message.threadId;

  try {
    const groupInfo = await getGroupInfoData(api, threadId);
    if (!groupInfo) throw new Error("Không thể lấy thông tin nhóm.");

    const isCommunity = groupInfo.groupType === 2;
    const creatorRole = isCommunity ? "Trưởng cộng đồng" : "Trưởng nhóm";
    const adminRole = isCommunity ? "Phó cộng đồng" : "Phó nhóm";
    const adminList = [];

    if (groupInfo.creatorId) {
      try {
        const creatorInfo = await getUserInfoData(api, groupInfo.creatorId);
        if (creatorInfo) adminList.push({ ...creatorInfo, role: creatorRole, keyType: "gold" });
      } catch (error) {
        console.error(`[ListKey] Lỗi lấy info trưởng nhóm ${groupInfo.creatorId}: ${error.message}`);
      }
    }

    const adminIds = (groupInfo.adminIds || []).filter((id) => id !== groupInfo.creatorId);
    for (const id of adminIds) {
      try {
        const info = await getUserInfoData(api, id);
        if (info) adminList.push({ ...info, role: adminRole, keyType: "silver" });
      } catch (error) {
        console.error(`[ListKey] Lỗi lấy info phó nhóm ${id}: ${error.message}`);
      }
    }

    if (adminList.length === 0) {
      await sendMessageWarning(api, message, "Không tìm thấy thông tin Key nào trong nhóm này.");
      return false;
    }

    const imagePath = await createKeyListImage(adminList, groupInfo.name);
    await api.sendMessage({ msg: "", attachments: [imagePath], ttl: 3600000, quote: message }, threadId, MessageType.GroupMessage);
    await clearImagePath(imagePath);
    return true;
  } catch (error) {
    console.error(`[handleListKeyCommand] Lỗi: ${error.message}`);
    await sendMessageWarning(api, message, "Đã xảy ra lỗi khi lấy danh sách Key.");
    return false;
  }
}
