import { LRUCache } from "lru-cache";
import {
  sendMessageCompleteRequest,
  sendMessageFromSQL,
  sendMessageResultRequest,
  sendMessageWarningRequest,
} from "../../service-debug/chat-zalo/chat-style/chat-style.js";
import { getGlobalPrefix } from "../../service-debug/service.js";
import { getDataAllGroup, getGroupAdmins, getGroupInfoData } from "../../service-debug/info-service/group-info.js";
import { getUserInfoData } from "../../service-debug/info-service/user-info.js";
import { removeMention } from "../../utils/format-util.js";
import { handleCommand } from "../command.js";
import { getBotId } from "../../utils/env.js";
import { MessageType } from "../../api-zalo/index.js";
import { readGroupSettings } from "../../utils/io-json.js";
import { extractCleanArgs, safeThreadType } from "../shared/command-input-utils.js";
import {
  startInteractionCountdown,
  completeInteractionCountdown,
  cancelInteractionCountdown,
} from "../../utils/interaction-countdown.js";

const waitingActionJoinGroup = 30000;
const timeOutWaitingActionGroup = 60000;
const requestJoinGroupMap = new LRUCache({ max: 500, ttl: waitingActionJoinGroup * 2 });
const waitingActionGroupMap = new LRUCache({ max: 500, ttl: timeOutWaitingActionGroup * 2 });

export async function handleJoinGroup(api, message, aliasCommand = "join") {
  const prefix = getGlobalPrefix();
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "join";
  const args = extractCleanArgs(message, prefix, safeAlias);
  const linkJoin = args[0];

  if (!linkJoin) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Cú pháp tham gia nhóm thông qua link:\n${prefix}${safeAlias} [link]`,
      },
      false,
      30000
    );
    return;
  }

  let groupInfo = null;
  try {
    groupInfo = await api.getGroupInfoByLink(linkJoin);
  } catch (error) {
    await sendMessageFromSQL(
      api,
      message,
      {
        success: false,
        message: `Link này đếch tồn tại nhóm/cộng đồng nào!`,
      },
      true,
      30000
    );
    return;
  }

  if (!groupInfo) return;

  const typeGroup = groupInfo.type === 2 ? "Cộng đồng" : "Nhóm";

  const msgResponse = await sendMessageCompleteRequest(
    api,
    message,
    {
      caption:
        `Tên ${typeGroup}: ${groupInfo.name}\nMô tả: ${groupInfo.desc || "Không có mô tả"
        }\nTổng số thành viên: ${groupInfo.totalMember}` +
        `\n\nXác nhận tham gia ${typeGroup} bằng cách thả reaction like hoặc heart!`,
    },
    waitingActionJoinGroup
  );

  const msgId = msgResponse?.message?.msgId?.toString() || "";

  requestJoinGroupMap.set(msgId, {
    message,
    timestamp: Date.now(),
    groupInfo,
    linkJoin,
  });

  startInteractionCountdown({
    key: `join_group_${msgId}`,
    api,
    message: msgResponse,
    messageContext: message,
    seconds: Math.floor(waitingActionJoinGroup / 1000) || 30,
    deleteOnExpire: true,
    onExpire: async () => {
      requestJoinGroupMap.delete(msgId);
    },
  });
}

export async function handleReactionConfirmJoinGroup(api, reaction) {
  const msgId = reaction?.data?.content?.rMsg?.[0]?.gMsgID?.toString?.() || reaction?.messageID || "";
  if (!msgId) return false;
  const data = requestJoinGroupMap.get(msgId);
  if (!data) return false;
  const senderId = reaction.data.uidFrom;
  if (senderId !== data.message.data.uidFrom) return false;

  const rType = reaction.data.content.rType;
  if (rType !== 3 && rType !== 5) return false;

  const message = data.message;
  completeInteractionCountdown(`join_group_${msgId}`);
  requestJoinGroupMap.delete(msgId);
  // const msgUndo = {
  //   data: {
  //     quote: {
  //       cliMsgId: reaction.data.content.rMsg[0].cMsgID,
  //       globalMsgId: reaction.data.content.rMsg[0].gMsgID,
  //     },
  //   },
  //   type: message.type,
  //   threadId: reaction.data.idTo,
  // };
  // await api.undoMessage(msgUndo);

  try {
    await api.joinGroup(data.linkJoin);
    await sendMessageFromSQL(
      api,
      message,
      {
        success: true,
        message: `Bố đã tham gia vào nhóm thành công!`,
      },
      true,
      180000
    );
  } catch (error) {
    const errMsg = String(error?.message || error || "");
    if (errMsg.includes("Waiting for approve")) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `Bố đã gửi yêu cầu tham gia nhóm này và đang chờ chủ nhóm phê duyệt!`,
        },
        180000
      );
    } else if (errMsg.includes("đã là thành viên") || errMsg.toLowerCase().includes("already")) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `Bố đã là thành viên của nhóm này!`,
        },
        180000
      );
    } else if (errMsg.includes("chặn tham gia nhóm") || errMsg.toLowerCase().includes("block")) {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `Bố đã bị chặn tham gia nhóm này!`,
        },
        180000
      );
    } else {
      await sendMessageWarningRequest(
        api,
        message,
        {
          caption: `Không thể tham gia nhóm: ${errMsg || "Zalo từ chối hoặc link không hợp lệ"}!`,
        },
        180000
      );
    }
  }
  return true;
}

export async function handleLeaveGroup(api, message) {
  const threadId = message.threadId;
  const prefix = getGlobalPrefix();
  const botId = String(getBotId() || "");
  try {
    const groupInfo = await getGroupInfoData(api, threadId).catch(() => null);
    if (groupInfo && botId && String(groupInfo.creatorId) === botId) {
      const totalMembers =
        Number(groupInfo.totalMember) ||
        (Array.isArray(groupInfo.memVerList) ? groupInfo.memVerList.length : 0);
      if (totalMembers > 1) {
        await sendMessageWarningRequest(
          api,
          message,
          {
            caption:
              `⚠️ Bot đang là Trưởng nhóm (Key Vàng) của nhóm có ${totalMembers} thành viên nên Zalo không cho rời trực tiếp!\n` +
              `👉 Vui lòng chuyển Key Vàng bằng lệnh "${prefix}keygold @thành_viên" trước, hoặc dùng "${prefix}dispersegroup" để giải tán nhóm.`,
          },
          60000
        );
        return;
      }
    }

    await sendMessageResultRequest(api, MessageType.GroupMessage, threadId, "Bai mấy cu, bố đi đây!!!", true, 30000);
    await api.leaveGroup(threadId);
  } catch (error) {
    console.error("Lỗi khi rời nhóm:", error);
    await sendMessageResultRequest(
      api,
      MessageType.GroupMessage,
      threadId,
      `Có lỗi xảy ra, không rời nhóm được: ${error?.message || error}`,
      true,
      30000
    );
  }
}

export async function handleShowGroupsList(api, message, aliasCommand = "listgroups") {
  const prefix = getGlobalPrefix();
  const safeAlias = typeof aliasCommand === "string" && aliasCommand ? aliasCommand : "listgroups";
  const command = extractCleanArgs(message, prefix, safeAlias).join(" ").trim();
  try {
    const groups = (await getDataAllGroup(api)) || [];
    let filteredGroups;
    if (!command) {
      filteredGroups = groups;
    } else {
      filteredGroups = groups.filter((group) =>
        String(group?.name || "").toUpperCase().includes(command.toUpperCase())
      );
    }
    if (!filteredGroups.length) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: command
            ? `Đếch tìm thấy nhóm nào có tên chứa "${command}"!`
            : "Hiện tại bot chưa tham gia nhóm nào!",
        },
        false,
        30000
      );
      return;
    }

    const CHUNK_SIZE = 30;
    const chunks = [];

    for (let i = 0; i < filteredGroups.length; i += CHUNK_SIZE) {
      const chunk = filteredGroups.slice(i, i + CHUNK_SIZE);
      chunks.push(chunk);
    }

    for (const [chunkIndex, groupChunk] of chunks.entries()) {
      let contentMessage =
        chunkIndex === 0
          ? `Danh sách nhóm (Trang ${chunkIndex + 1}/${chunks.length}):\n\n`
          : `(Tiếp theo - Trang ${chunkIndex + 1}/${chunks.length})\n\n`;

      for (const [index, group] of groupChunk.entries()) {
        let owner = null;
        if (group?.creatorId) {
          try {
            owner = await getUserInfoData(api, group.creatorId);
          } catch {
            owner = null;
          }
        }
        const ownerName = owner?.name || "Không xác định";
        const actualIndex = chunkIndex * CHUNK_SIZE + index + 1;
        contentMessage +=
          `${actualIndex}. ${group.name || "Nhóm không tên"} (${group.totalMember ?? 0} thành viên)\n` +
          ` - Trưởng nhóm: ${ownerName}\n\n`;
      }

      contentMessage += `Reply tin nhắn này với "<STT> -> ${prefix}<lệnh>" để thực hiện hành động cho nhóm tương ứng!`;

      const msgResponse = await sendMessageCompleteRequest(
        api,
        message,
        {
          caption: contentMessage,
        },
        timeOutWaitingActionGroup
      );

      const msgId = msgResponse?.message?.msgId?.toString() || msgResponse?.msgId?.toString() || "";
      if (msgId) {
        waitingActionGroupMap.set(msgId, {
          message,
          timestamp: Date.now(),
          groups: filteredGroups,
        });

        startInteractionCountdown({
          key: `remote_group_${msgId}`,
          api,
          message: msgResponse,
          messageContext: message,
          seconds: Math.floor(timeOutWaitingActionGroup / 1000) || 60,
          deleteOnExpire: true,
          onExpire: async () => {
            waitingActionGroupMap.delete(msgId);
          },
        });
      }
    }
  } catch (error) {
    console.error(error);
  }
}

export async function handleActionGroupReply(
  api,
  message,
  groupInfo,
  groupAdmins,
  groupSettings,
  isAdminLevelHighest,
  callerIsBotAdmin,
  callerIsAdminBox,
  handleChat
) {
  const prefix = getGlobalPrefix();
  const senderId = message.data.uidFrom;
  const content = removeMention(message);
  try {
    if (!message.data?.quote || !message.data.quote.globalMsgId || !content)
      return false;

    const quotedMsgId = message.data.quote.globalMsgId.toString();
    if (!waitingActionGroupMap.has(quotedMsgId)) return false;
    const dataReply = waitingActionGroupMap.get(quotedMsgId);
    if (dataReply.message.data.uidFrom !== senderId) return false;

    if (!content.includes("->")) return false;
    const commandParts = content.split("->");
    const index = Number.parseInt(commandParts[0].trim(), 10);
    if (Number.isNaN(index)) {
      const object = {
        caption: `Lựa chọn Không hợp lệ. Vui lòng chọn một số từ danh sách.`,
      };
      await sendMessageWarningRequest(api, message, object, 30000);
      return true;
    }
    const action = commandParts.slice(1).join("->").trim();
    if (action && !action.startsWith(prefix)) {
      return false;
    }

    if (index < 1 || index > dataReply.groups.length) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Số index Không hợp lệ!`,
        },
        false,
        30000
      );
      return false;
    }
    if (!action) {
      await sendMessageFromSQL(
        api,
        message,
        {
          success: false,
          message: `Vui lòng nhập hành động cần thực hiện!`,
        },
        false,
        30000
      );
      return false;
    }

    completeInteractionCountdown(`remote_group_${quotedMsgId}`);
    waitingActionGroupMap.delete(quotedMsgId);
    try {
      await api.deleteMessage({
        type: safeThreadType(message),
        threadId: message.threadId,
        data: {
          cliMsgId: message.data.quote.cliMsgId,
          msgId: message.data.quote.globalMsgId,
          uidFrom: getBotId(),
        },
      }, false);
    } catch (e) {}
    const group = dataReply.groups[index - 1];
    const effectiveGroupSettings =
      groupSettings && Object.keys(groupSettings).length > 0 ? groupSettings : readGroupSettings();
    let targetGroupInfo = groupInfo;
    let targetGroupAdmins = groupAdmins;
    try {
      const fetchedInfo = await getGroupInfoData(api, group.groupId);
      if (fetchedInfo) {
        targetGroupInfo = fetchedInfo;
        const fetchedAdmins = await getGroupAdmins(fetchedInfo);
        if (Array.isArray(fetchedAdmins)) {
          targetGroupAdmins = fetchedAdmins;
        }
      }
    } catch (fetchErr) {
      console.warn(`[remote-action-group] Không thể tải thông tin nhóm ${group.groupId}:`, fetchErr?.message || fetchErr);
    }

    const clonedMessage = {
      ...message,
      threadId: group.groupId,
      type: MessageType.GroupMessage,
      data: {
        ...(message.data || {}),
        content: action,
        mentions: [],
      },
    };
    const numHandleCommand = await handleCommand(
      api,
      clonedMessage,
      targetGroupInfo,
      targetGroupAdmins,
      effectiveGroupSettings,
      isAdminLevelHighest,
      callerIsBotAdmin,
      callerIsAdminBox,
      handleChat ?? true
    );
    if (numHandleCommand === 1 || numHandleCommand === 2 || numHandleCommand === 3 || numHandleCommand === 5) {
      const result = {
        success: true,
        message: `Đã thực hiện hành động "${action}" trong nhóm "${group.name}"!`,
      };
      await sendMessageFromSQL(api, message, result, true, 60000);
    }
    return true;
  } catch (error) {
    console.error(error);
  }
}
