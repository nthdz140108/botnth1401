import { MessageMention, Zalo, ZaloApiError } from "../api-zalo/index.js";
import { appContext } from "../api-zalo/context.js";
import { encodeAES, handleZaloResponse, request, makeURL, decodeAES } from "../api-zalo/utils.js";
import { getBotId } from "../utils/env.js";
import { getUserInfoData } from "../service-debug/info-service/user-info.js";
import * as cv from "../utils/canvas/index.js";
import { deleteFile } from "../utils/util.js";
import { getRecentMessage } from "../commands/bot-manager/recent-message.js";


// export async function superCheckBox(api, message, isSelf, botIsAdminBox, isAdminBox) {
//   if (isSelf || isAdminBox || !botIsAdminBox) return false;
//   const threadId = message.threadId;
//   const senderName = message.data.dName;
//   const senderId = message.data.uidFrom;
//   const mentionsCount = message.data?.mentions?.length || 0;
//   const content = message.data.content || "";
//   const isHiddenTag = mentionsCount > 0 && content.trim().length === 0;

//   if (mentionsCount > 15 || isHiddenTag) {
//     const warningMessage = isHiddenTag 
//       ? `${senderName} Tag cái đầu buồi, cútttttttt!`
//       : `${senderName} Tag cái đầu buồi, cútttttttt!`;

//     try {
//       await api.sendMessage(
//         {
//           msg: warningMessage,
//           quote: message,
//           mentions: [MessageMention(senderId, senderName.length, 0)]
//         },
//         threadId,
//         message.type
//       );

//       await new Promise(resolve => setTimeout(resolve, 3000));
//       await api.blockUsers(threadId, [senderId]);
//       return true;
//     } catch (error) {
//       console.error("Không thể chặn người dùng:", error);
//       await api.sendMessage(
//         {
//           msg: `Lỗi: Không thể chặn ${senderName}. Vui lòng thử lại sau.`,
//           quote: message
//         },
//         threadId,
//         message.type
//       );
//       return false;
//     }
//   }

//   return false;
// }

export async function testFutureGroup(api, message, groupInfo) {
  const threadId = message.threadId;
  const content = message.data.content;
  const idBot = getBotId();
  try {
    await handleEncryptedMessage(api, message, threadId);
    await ketbanCommand.sendFriendRequestToGroupMembers(api, groupInfo, idBot, message);
  } catch (error) {
    await api.sendMessage(
      {
        msg: error.message,
        quote: message,
      },
      threadId,
      message.type
    );
  }
}

export async function testFutureUser(api, message) {
  const threadId = message.threadId;
  try {
    await handleEncryptedMessage(api, message, threadId);
    return true;
  } catch (error) {
    await api.sendMessage(
      {
        msg: error.message,
        quote: message,
      },
      threadId,
      message.type
    );
    return false;
  }
}

export async function canvasTest(api, message, senderId, senderName, nameGroup, groupInfo) {
  const threadId = message.threadId;
  const userInfo = await getUserInfoData(api, senderId);
  const userActionName = senderName;
  let imagePath;
  imagePath = await cv.createWelcomeImage(userInfo, nameGroup, groupInfo.type, userActionName, false);
  await api.sendMessage(
    {
      msg: ``,
      attachments: [imagePath],
    },
    threadId,
    message.type
  );
  await deleteFile(imagePath);
  // imagePath = await cv.createKickImage(userInfo, nameGroup, groupInfo.type, userInfo.genderId, userActionName, false);
  // await api.sendMessage(
  //   {
  //     msg: ``,
  //     attachments: [imagePath],
  //   },
  //   threadId,
  //   message.type
  // );
  // await deleteFile(imagePath);
  // imagePath = await cv.createGoodbyeImage(userInfo, nameGroup, groupInfo.type, false);
  // await api.sendMessage(
  //   {
  //     msg: ``,
  //     attachments: [imagePath],
  //   },
  //   threadId,
  //   message.type
  // );
  // await deleteFile(imagePath);
  // imagePath = await cv.createBlockImage(userInfo, nameGroup, groupInfo.type, userInfo.genderId, userActionName, false);
  // await api.sendMessage(
  //   {
  //     msg: ``,
  //     attachments: [imagePath],
  //   },
  //   threadId,
  //   message.type
  // );
  // await deleteFile(imagePath);
  // imagePath = await cv.createBlockSpamImage(userInfo, nameGroup, groupInfo.type, userInfo.genderId);
  // await api.sendMessage(
  //   {
  //     msg: ``,
  //     attachments: [imagePath],
  //   },
  //   threadId,
  //   message.type
  // );
  // await deleteFile(imagePath);
  // imagePath = await cv.createBlockSpamLinkImage(userInfo, nameGroup, groupInfo.type, userInfo.genderId);
  // await api.sendMessage(
  //   {
  //     msg: ``,
  //     attachments: [imagePath],
  //   },
  //   threadId,
  //   message.type
  // );
  // await deleteFile(imagePath);
}

async function handleEncryptedMessage(api, message, threadId) {
  const isPlainText = typeof message.data.content === "string";
  if (!isPlainText) return;
  const contentOriginal = message.data.content;
  const decryptParams = decodeAES(appContext.secretKey, contentOriginal);
  const params = JSON.parse(decryptParams);
  const content = JSON.stringify(params);

  if (content && content !== "null") {
    await api.sendMessage(
      {
        msg: content,
        quote: message,
      },
      threadId,
      message.type
    );
  }
}

export const ketbanCommand = {
  name: "ketban",
  description: "Gửi yêu cầu kết bạn đến tất cả thành viên trong nhóm",
  execute: async function (api, message, groupInfo) {
    const threadId = message.threadId;
    const idBot = String(getBotId() || appContext?.uid || "");

    try {
      const count = await this.sendFriendRequestToGroupMembers(api, groupInfo, idBot, message);
      return count;
    } catch (error) {
      await api.sendMessage(
        {
          msg: `Lỗi khi thực hiện lệnh ketban: ${error.message}`,
          quote: message,
          ttl: 60000,
        },
        threadId,
        message.type ?? 1
      );
      return 0;
    }
  },

  sendFriendRequestToGroupMembers: async function (api, groupInfo, idBot, message) {
    const threadId = message.threadId;
    const msgType = message.type ?? 1;
    const botStr = String(idBot || getBotId() || appContext?.uid || "").trim();

    let resolvedGroup = groupInfo?.gridInfoMap?.[threadId] || groupInfo;
    if (!Array.isArray(resolvedGroup?.memVerList) && typeof api?.getGroupInfo === "function" && threadId) {
      try {
        const fetched = await api.getGroupInfo(threadId);
        resolvedGroup = fetched?.gridInfoMap?.[threadId] || fetched || resolvedGroup;
      } catch {}
    }

    const rawMemberList = Array.isArray(resolvedGroup?.memVerList)
      ? resolvedGroup.memVerList
      : Array.isArray(resolvedGroup?.memberIds)
        ? resolvedGroup.memberIds
        : [];

    const memberIds = [
      ...new Set(
        rawMemberList
          .map((member) => String(member ?? "").trim().replace(/_\d+$/, ""))
          .filter(Boolean)
      ),
    ];

    const friendSet = new Set();
    if (typeof api?.getAllFriends === "function") {
      try {
        const res = await api.getAllFriends(30000, 1);
        const list = Array.isArray(res)
          ? res
          : Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res?.data?.friends)
              ? res.data.friends
              : [];
        for (const f of list) {
          const fid = String(f?.userId || f?.uid || f?.id || "").trim();
          if (fid) friendSet.add(fid);
        }
      } catch {}
    }

    const candidates = memberIds.filter((id) => id !== botStr && !friendSet.has(id));
    const cappedTargets = candidates.slice(0, 20);

    if (cappedTargets.length === 0) {
      await api.sendMessage(
        {
          msg: "Không có thành viên mới nào trong nhóm cần gửi lời mời kết bạn!",
          quote: message,
          ttl: 60000,
        },
        threadId,
        msgType
      );
      return 0;
    }

    let count = 0;
    for (let idx = 0; idx < cappedTargets.length; idx++) {
      const id = cappedTargets[idx];
      try {
        await api.sendFriendRequest(
          id,
          "Xin chào, mình quen biết bạn qua nhóm chung, xin phép được kết bạn nhé!"
        );
        count++;
      } catch {}
      if (idx + 1 < cappedTargets.length) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }

    await api.sendMessage(
      {
        msg:
          `Đã gửi yêu cầu kết bạn đến ${count}/${cappedTargets.length} thành viên` +
          (candidates.length > 20 ? ` (giới hạn an toàn 20 người/lần, còn ${candidates.length - 20} thành viên).` : "."),
        quote: message,
        ttl: 60000,
      },
      threadId,
      msgType
    );

    return count;
  },
};

export const ketbanTagCommand = {
  name: "kb",
  description: "Gửi yêu cầu kết bạn đến những người được tag trong tin nhắn",
  execute: async function (api, message, groupInfo) {
    const threadId = message.threadId;
    const idBot = String(getBotId() || appContext?.uid || "");

    try {
      const count = await this.sendFriendRequestToTaggedUsers(api, message, idBot);
      return count;
    } catch (error) {
      await api.sendMessage(
        {
          msg: `Lỗi khi thực hiện lệnh kb: ${error.message}`,
          quote: message,
          ttl: 60000,
        },
        threadId,
        message.type ?? 1
      );
      return 0;
    }
  },

  sendFriendRequestToTaggedUsers: async function (api, message, idBot) {
    const threadId = message.threadId;
    const msgType = message.type ?? 1;
    const rawMentions = message?.data?.mentions;
    const mentions = Array.isArray(rawMentions)
      ? rawMentions
      : rawMentions && typeof rawMentions === "object"
        ? Object.values(rawMentions)
        : [];
    const rawContent = typeof message?.data?.content === "string" ? message.data.content : "";
    const botStr = String(idBot || getBotId() || appContext?.uid || "").trim();

    if (!mentions.length) {
      await api.sendMessage(
        {
          msg: "Vui lòng @tag ít nhất một người để gửi yêu cầu kết bạn!",
          quote: message,
          ttl: 60000,
        },
        threadId,
        msgType
      );
      return 0;
    }

    let count = 0;
    const validMentions = mentions
      .filter((m) => m && m.uid && String(m.uid).trim() !== botStr)
      .slice(0, 20);

    for (let idx = 0; idx < validMentions.length; idx++) {
      const mention = validMentions[idx];
      const userId = String(mention.uid).trim();

      let userName = "";
      if (
        typeof mention.pos === "number" &&
        typeof mention.len === "number" &&
        mention.pos >= 0 &&
        mention.pos + mention.len <= rawContent.length
      ) {
        userName = rawContent.slice(mention.pos, mention.pos + mention.len).replace(/^@+/, "").trim();
      }
      if (!userName) {
        userName = mention.dName || mention.name || "";
      }
      if (!userName) {
        const info = await getUserInfoData(api, userId).catch(() => null);
        userName = info?.name || "bạn";
      }

      try {
        await api.sendFriendRequest(userId, `Xin chào ${userName}, mình muốn kết bạn với bạn!`);
        count++;
      } catch {}

      if (idx + 1 < validMentions.length) {
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
    }

    await api.sendMessage(
      {
        msg: `Đã gửi yêu cầu kết bạn đến ${count}/${validMentions.length} người được tag.`,
        quote: message,
        ttl: 60000,
      },
      threadId,
      msgType
    );

    return count;
  },
};