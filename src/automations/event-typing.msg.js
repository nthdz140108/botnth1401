import { MessageType } from "../api-zalo/index.js";
import { readAdmins } from "../utils/io-json.js";

export async function typingEvents(api, typingData) {
    const threadId = typingData.groupId || null;
    const isPC = typingData.isPC;
    const type = typingData.type === "gtyping" ? MessageType.GroupMessage : MessageType.DirectMessage;
    const userId = String(typingData.userId || "");
    const admins = readAdmins();
    const isAdminLevelHighest = Array.isArray(admins) && admins.map(String).includes(userId);
    if (typingData.type === "gtyping") {
        if (!isAdminLevelHighest) {
            try {
                const userInfo = await api.getGroupMembers([userId + "_0"]);
                const nameUser = userInfo?.profiles?.[userId]?.zaloName || "Người dùng";
                await api.sendMessage(
                    { msg: `${nameUser} đang định nhắn gì đó bằng ${isPC ? "Máy Tính" : "Điện Thoại"}`, ttl: 5000 },
                    threadId || userId,
                    type
                );
            } catch (error) {
                console.error("Lỗi khi lấy thông tin typing:", error);
            }
        }
    }
}