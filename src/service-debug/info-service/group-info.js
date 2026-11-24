import { MessageType } from "../../api-zalo/models/Message.js";
import { createGroupInfoImage, clearImagePath } from "../../utils/canvas/index.js";
import { sendMessageWarning } from "../chat-zalo/chat-style/chat-style.js";
import { getUserInfoData } from "./user-info-data.js";
import { getGroupInfoData } from "./group-info-data.js";

export {
  getDataAllGroup,
  getGroupInfoData,
  getGroupName,
  isHttpNotFound,
  getInFlightGroupRequestCount,
  clearInFlightGroupRequests,
} from "./group-info-data.js";

export async function groupInfoCommand(api, message) {
  const threadId = message.threadId;
  let imagePath = null;

  try {
    const groupInfo = await getGroupInfoData(api, threadId);
    const owner = await getUserInfoData(api, groupInfo.creatorId);
    imagePath = await createGroupInfoImage(groupInfo, owner);
    await api.sendMessage(
      { msg: "", attachments: [imagePath], quote: message, ttl: 600000 },
      threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    await sendMessageWarning(
      api,
      message,
      "Đã xảy ra lỗi khi lấy thông tin nhóm. Vui lòng thử lại sau!"
    );
  } finally {
    if (imagePath) await clearImagePath(imagePath);
  }
}

export async function getGroupAdmins(groupInfo) {
  try {
    const admins = Array.isArray(groupInfo?.adminIds)
      ? [...groupInfo.adminIds]
      : [];
    if (groupInfo?.creatorId && !admins.includes(groupInfo.creatorId)) {
      admins.push(groupInfo.creatorId);
    }
    return admins;
  } catch (error) {
    console.error("Failed to get group admins:", error);
    return [];
  }
}
