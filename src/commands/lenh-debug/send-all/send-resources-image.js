import fs from "fs";
import path from "path";
import { sendMessageCompleteRequest, sendMessageFailed } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { removeMention } from "../../../utils/format-util.js";

const dataImagePath = path.join(process.cwd(), "assets", "resources", "image");

function ensureImageResourceDir() {
    if (!fs.existsSync(dataImagePath)) {
        fs.mkdirSync(dataImagePath, { recursive: true });
    }
}

export async function handleSendImage(api, message, aliasCommand) {
    ensureImageResourceDir();
    const prefix = getGlobalPrefix();
    const content = removeMention(message);
    const keyword = content.replace(prefix + aliasCommand, "").trim();

    if (!keyword) {
        const files = fs.readdirSync(dataImagePath);
        const fileList = files.map((file, index) => `${index + 1}. ${path.parse(file).name}`).join("\n");
        await sendMessageCompleteRequest(api, message, {
            caption: `Đây là những hình ảnh đã lưu trữ:\n${fileList}`
                + `\n\nDùng lệnh: ${prefix}${aliasCommand} <tên ảnh> để gửi ảnh`
        }, 60000);
        return;
    }

    await sendImage(api, message, keyword);
}

async function sendImage(api, message, keyword) {
    ensureImageResourceDir();
    const files = fs.readdirSync(dataImagePath);
    const imageFile = files.find(file => path.parse(file).name === keyword);
    
    if (!imageFile) {
        await sendMessageFailed(api, message, "Không tìm thấy ảnh với tên này trong thư mục", false);
        return;
    }
    
    const imagePath = path.join(dataImagePath, imageFile);
    const nameLocalImage = keyword;

    try {
        await api.sendMessage(
            {
                msg: `Ảnh: ${nameLocalImage}`,
                attachments: [imagePath],
                ttl: 3600000
            },
            message.threadId,
            message.type
        );

    } catch (error) {
        console.error("Lỗi khi gửi ảnh:", error);
        await sendMessageFailed(api, message, "Có lỗi xảy ra khi gửi ảnh", false);
    }
}