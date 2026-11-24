import fs from "fs";
import path from "path";
import { sendMessageCompleteRequest, sendMessageFailed } from "../../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getCachedMedia, setCacheData } from "../../../utils/link-platform-cache.js";
import { getGlobalPrefix } from "../../../service-debug/service.js";
import { removeMention } from "../../../utils/format-util.js";

const dataFilePath = path.join(process.cwd(), "assets", "resources", "file");

function ensureFileResourceDir() {
    if (!fs.existsSync(dataFilePath)) {
        fs.mkdirSync(dataFilePath, { recursive: true });
    }
}

export async function handleSendFile(api, message, aliasCommand) {
    ensureFileResourceDir();
    const prefix = getGlobalPrefix();
    const content = removeMention(message);
    const keyword = content.replace(prefix + aliasCommand, "").trim();

    if (!keyword) {
        const files = fs.readdirSync(dataFilePath);
        const fileList = files.map((file, index) => `${index + 1}. ${path.parse(file).name}`).join("\n");
        await sendMessageCompleteRequest(api, message, {
            caption: `🔍 Danh sách file có thể chia sẻ:\nLưu ý đây là những src sưu tầm từ mọi nguồn, 1 số được update lại:\n${fileList}`
                + `\n\nDùng lệnh: ${prefix}${aliasCommand} <index or tên file> để gửi file\nFile sẽ được gửi lên group`
        }, 100000
        );
        return;
    }

    await sendFile(api, message, keyword);
}

async function sendFile(api, message, keyword) {
    ensureFileResourceDir();
    const files = fs.readdirSync(dataFilePath);
    
    // Kiểm tra xem keyword là số hay tên file
    let resourceFile;
    if (/^\d+$/.test(keyword)) {
        const index = parseInt(keyword) - 1;
        if (index >= 0 && index < files.length) {
            resourceFile = files[index];
        }
    } else {
        resourceFile = files.find(file => path.parse(file).name === keyword);
    }
    
    if (!resourceFile) {
        await sendMessageFailed(api, message, "Không tìm thấy file với số thứ tự hoặc tên này", false);
        return;
    }
    
    const filePath = path.join(dataFilePath, resourceFile);
    const nameLocalFile = path.parse(resourceFile).name;

    try {
        await api.sendMessage(
            {
                msg: `File: ${nameLocalFile}`,
                attachments: [filePath],
                ttl: 3600000
            },
            message.threadId,
            message.type
        );

    } catch (error) {
        console.error("Lỗi khi gửi file:", error);
        await sendMessageFailed(api, message, "Có lỗi xảy ra khi gửi file", false);
    }
} 