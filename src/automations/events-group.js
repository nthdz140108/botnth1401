import { GroupEventType, MessageType } from "../api-zalo/models/index.js";
import { getUserInfoData } from "../service-debug/info-service/user-info.js";
import { readGroupSettings, isMainBotAdmin } from "../utils/io-json.js";
import { getBotId } from "../utils/env.js";
import { isAdmin } from "../utils/role-policy.js";
import { getGroupAdmins, getGroupInfoData } from "../service-debug/info-service/group-info.js";
import * as cv from "../utils/canvas/index.js";
import { antiJoinLeave } from "../service-debug/anti-service/anti-join-leave.js";
import { antiKickBlock } from "../service-debug/anti-service/anti-kick-all.js";
import { handleMemberJoin, isUserTagged } from "../commands/bot-manager/group-manage.js";
import { handleTargetOnJoin } from "../commands/bot-manager/nqduan-bridge.js";
import { getGroupEventActorId, getGroupEventMembers } from "./group-event-utils.js";
import { trackLocmemGroupAction, getLocmemStore } from "../service-debug/locmem/index.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";

const blockedMembers = new Map();
const BLOCK_CHECK_TIMEOUT = 300;
const BLOCK_MARK_TTL_MS = 2500;

function makeBlockedMemberKey(threadId, userId) {
  return `${String(threadId || "")}:${String(userId || "")}`;
}

function markMemberRecentlyBlocked(threadId, userId) {
  if (userId === undefined || userId === null || userId === "") return;
  const scopedKey = makeBlockedMemberKey(threadId, userId);
  const rawKey = String(userId);
  const now = Date.now();
  blockedMembers.set(scopedKey, now);
  blockedMembers.set(rawKey, now);
  const timer = setTimeout(() => {
    blockedMembers.delete(scopedKey);
    blockedMembers.delete(rawKey);
  }, BLOCK_MARK_TTL_MS);
  timer.unref?.();
}

function isMemberRecentlyBlocked(threadId, userId) {
  if (userId === undefined || userId === null || userId === "") return false;
  return (
    blockedMembers.has(makeBlockedMemberKey(threadId, userId)) ||
    blockedMembers.has(String(userId))
  );
}

function isEventType(type, enumKey) {
  return Boolean(
    GroupEventType &&
    Object.prototype.hasOwnProperty.call(GroupEventType, enumKey) &&
    GroupEventType[enumKey] !== undefined &&
    type === GroupEventType[enumKey]
  );
}

function isUpdateGroupAdminEvent(type) {
  return (
    isEventType(type, "UPDATE") ||
    isEventType(type, "UPDATE_SETTING") ||
    isEventType(type, "NEW_LINK") ||
    isEventType(type, "ADD_ADMIN") ||
    isEventType(type, "REMOVE_ADMIN") ||
    isEventType(type, "UPDATE_BOARD") ||
    isEventType(type, "NEW_PIN_TOPIC") ||
    isEventType(type, "UPDATE_TOPIC") ||
    isEventType(type, "UNPIN_TOPIC") ||
    isEventType(type, "REMOVE_TOPIC") ||
    isEventType(type, "REORDER_PIN_TOPIC")
  );
}

async function sendGroupMessage(api, threadId, imagePath, messageText) {
  const message = messageText ? messageText : "";
  try {
    await api.sendMessage(
      {
        msg: message,
        attachments: imagePath ? [imagePath] : [],
        ttl: 3600000,
      },
      threadId,
      MessageType.GroupMessage
    );
  } catch (error) {
    console.error("Loi gui tin nhan nhom:", error.message);
  }
}

async function handleUpdateGroupAdminEvent(api, event, threadId, threadSettings, idAction) {
  if (threadSettings?.updateGroup !== true) {
    return;
  }

  const type = event.type;
  const data = event.data || {};
  let actorName = data.actorName || data.dName || "";
  if (!actorName && idAction) {
    const actorInfo = await getUserInfoData(api, idAction).catch(() => null);
    const fetchedName = actorInfo?.name || actorInfo?.dName || "";
    if (fetchedName && fetchedName !== "Không xác định") {
      actorName = fetchedName;
    }
  }
  if (!actorName) {
    actorName = idAction ? `UID ${idAction}` : "Quản trị viên";
  }

  const resolveAffectedMembersText = async () => {
    const rawMembers = Array.isArray(data.updateMembers) ? data.updateMembers : [];
    const names = [];
    for (const member of rawMembers) {
      if (!member) continue;
      const mId = typeof member === "object"
        ? String(member.id ?? member.uid ?? member.userId ?? "")
        : String(member);
      let mName = typeof member === "object" ? (member.dName || member.name || member.zaloName || "") : "";
      if (!mName && mId) {
        const info = await getUserInfoData(api, mId).catch(() => null);
        const fetched = info?.name || info?.dName || "";
        if (fetched && fetched !== "Không xác định") {
          mName = fetched;
        }
      }
      if (mName || mId) {
        names.push(mName || `UID ${mId}`);
      }
    }
    return names.length > 0 ? names.join(", ") : "thành viên";
  };

  let notificationText = "";

  if (isEventType(type, "ADD_ADMIN")) {
    const targetNames = await resolveAffectedMembersText();
    notificationText = `📢 [CẬP NHẬT NHÓM]\n👑 ${actorName} vừa bổ nhiệm ${targetNames} làm Phó nhóm.`;
  } else if (isEventType(type, "REMOVE_ADMIN")) {
    const targetNames = await resolveAffectedMembersText();
    notificationText = `📢 [CẬP NHẬT NHÓM]\n🔑 ${actorName} vừa miễn nhiệm quyền Phó nhóm của ${targetNames}.`;
  } else if (isEventType(type, "UPDATE")) {
    const hasNewAvatar = Boolean(data.fullAvt || data.avt);
    const updatedName = typeof data.groupName === "string" ? data.groupName.trim() : "";
    if (hasNewAvatar && !updatedName) {
      notificationText = `📢 [CẬP NHẬT NHÓM]\n🖼️ ${actorName} vừa thay đổi ảnh đại diện nhóm.`;
    } else if (updatedName) {
      notificationText = `📢 [CẬP NHẬT NHÓM]\n✏️ ${actorName} vừa cập nhật thông tin nhóm "${updatedName}".`;
    } else {
      notificationText = `📢 [CẬP NHẬT NHÓM]\n✏️ ${actorName} vừa cập nhật thông tin nhóm.`;
    }
  } else if (isEventType(type, "UPDATE_SETTING")) {
    const setting = data.groupSetting || data.setting || null;
    const details = [];
    if (setting && typeof setting === "object") {
      if (setting.lockSendMsg !== undefined) {
        details.push(setting.lockSendMsg ? "🔒 Khóa gửi tin nhắn (chỉ QTV)" : "🔓 Mở chat cho tất cả thành viên");
      }
      if (setting.joinAppr !== undefined) {
        details.push(setting.joinAppr ? "🛡️ Bật phê duyệt thành viên mới" : "✅ Tắt phê duyệt thành viên mới");
      }
      if (setting.lockCreatePost !== undefined) {
        details.push(setting.lockCreatePost ? "📝 Khóa tạo ghi chú / nhắc hẹn" : "📝 Mở tạo ghi chú / nhắc hẹn");
      }
      if (setting.lockCreatePoll !== undefined) {
        details.push(setting.lockCreatePoll ? "📊 Khóa tạo bình chọn" : "📊 Mở tạo bình chọn");
      }
      if (setting.lockViewMember !== undefined) {
        details.push(setting.lockViewMember ? "👀 Ẩn danh sách thành viên" : "👀 Hiển thị danh sách thành viên");
      }
    }
    notificationText = details.length > 0
      ? `📢 [CẬP NHẬT NHÓM]\n⚙️ ${actorName} vừa thay đổi cài đặt nhóm:\n• ${details.join("\n• ")}`
      : `📢 [CẬP NHẬT NHÓM]\n⚙️ ${actorName} vừa thay đổi cài đặt nhóm.`;
  } else if (isEventType(type, "NEW_LINK")) {
    notificationText = `📢 [CẬP NHẬT NHÓM]\n🔗 ${actorName} vừa tạo mới / đổi link tham gia nhóm.`;
  } else if (isEventType(type, "NEW_PIN_TOPIC")) {
    notificationText = `📢 [CẬP NHẬT NHÓM]\n📌 ${actorName} vừa ghim một nội dung mới lên bảng thông báo nhóm.`;
  } else if (isEventType(type, "UNPIN_TOPIC")) {
    notificationText = `📢 [CẬP NHẬT NHÓM]\n📌 ${actorName} vừa bỏ ghim thông báo trong nhóm.`;
  } else if (isEventType(type, "REORDER_PIN_TOPIC")) {
    notificationText = `📢 [CẬP NHẬT NHÓM]\n📌 ${actorName} vừa sắp xếp lại thứ tự ghim trong nhóm.`;
  } else if (isEventType(type, "REMOVE_TOPIC")) {
    notificationText = `📢 [CẬP NHẬT NHÓM]\n🗑️ ${actorName} vừa xóa một mục trên bảng thông báo nhóm.`;
  } else if (isEventType(type, "UPDATE_BOARD") || isEventType(type, "UPDATE_TOPIC")) {
    notificationText = `📢 [CẬP NHẬT NHÓM]\n📋 ${actorName} vừa cập nhật bảng thông báo / bình chọn trong nhóm.`;
  }

  if (notificationText) {
    await sendGroupMessage(api, threadId, "", notificationText);
  }
}

export async function groupEvents(api, event, context = {}) {
  const runtimeContext = context?.runtimeContext || getRuntimeContext();
  try {
    trackLocmemGroupAction(api, event, runtimeContext);
  } catch (err) {
    console.error("[locmem] trackLocmemGroupAction error:", err);
  }

  try {
    const threadId = String(event?.threadId || event?.data?.groupId || "");
    const type = event?.type;
    const isJoinEvent = isEventType(type, "JOIN") || isEventType(type, "ADD_MEMBER");
    if (threadId && isJoinEvent) {
      const store = getLocmemStore(runtimeContext);
      const updateMembers = getGroupEventMembers(event);
      for (const m of updateMembers) {
        const mId = typeof m === "object" ? (m.id || m.uid || m.memberId) : String(m);
        if (mId) {
          store.resetMemberOnJoin(threadId, mId);
        }
      }
    }
  } catch (joinResetErr) {
    console.warn("[locmem] resetMemberOnJoin error:", joinResetErr.message);
  }

  try {
    const type = event?.type;
    const data = event?.data || {};
    const updateMembers = getGroupEventMembers(event);
    const groupName = data.groupName;
    const threadId = event?.threadId || data.groupId;
    const groupType = data.groupType;
    const idAction = getGroupEventActorId(event);
    const groupSettings = readGroupSettings();
    const threadSettings = groupSettings[threadId] || {};

    const rawBotId = api?.getBotId?.() || api?.getOwnId?.() || getBotId();
    if (!rawBotId || !threadId) {
      return;
    }
    const idBot = String(rawBotId);

    if (isEventType(type, "JOIN_REQUEST")) {
      if (threadSettings.memberApprove) {
        await api.handleGroupPendingMembers(threadId, true);
      }
      return;
    }

    if (isUpdateGroupAdminEvent(type)) {
      await handleUpdateGroupAdminEvent(api, event, threadId, threadSettings, idAction);
      return;
    }

    if (updateMembers.length === 0) {
      return;
    }

    const groupInfo = (await getGroupInfoData(api, threadId).catch(() => null)) || {};
    const effectiveGroupName = groupName || groupInfo?.name || "Nhóm";
    const rawAdmins = await getGroupAdmins(groupInfo).catch(() => []);
    const groupAdmins = Array.isArray(rawAdmins) ? rawAdmins.map(String) : [];
    const botIsAdminBox = groupAdmins.includes(idBot);
    const actorIsProtected = Boolean(
      idAction &&
      (isMainBotAdmin(idAction) || String(idAction) === String(groupInfo?.creatorId || ""))
    );
    const userActionInfo = idAction ? await getUserInfoData(api, idAction).catch(() => null) : null;
    const userActionName = userActionInfo?.name || data.actorName || "Không xác định";

    if (isEventType(type, "JOIN")) {
      const nonBlockedJoinedUsers = [];

      for (const user of updateMembers) {
        const userId = String(user.id);
        const isUserAdminBox = groupAdmins.includes(userId) || isAdmin(userId, threadId);
        const isSelf = userId === idBot;
        const singleMemberEvent = {
          ...event,
          data: {
            ...data,
            updateMembers: [user],
          },
        };

        const wasTaggedInTaget = botIsAdminBox && (await isUserTagged(userId, threadId).catch(() => false));
        const blockedByTaget = Boolean(await handleMemberJoin(api, singleMemberEvent)) || wasTaggedInTaget;
        const blockedByAntiJoin = !blockedByTaget && Boolean(
          await antiJoinLeave(
            api,
            singleMemberEvent,
            isUserAdminBox,
            groupSettings,
            botIsAdminBox,
            isSelf,
            userId
          )
        );
        const blockedByTarget = !blockedByTaget && !blockedByAntiJoin && Boolean(
          await handleTargetOnJoin(api, singleMemberEvent)
        );

        if (blockedByTaget || blockedByAntiJoin || blockedByTarget) {
          markMemberRecentlyBlocked(threadId, userId);
          continue;
        }

        let userInfo = null;
        if (threadSettings.welcomeGroup || threadSettings.prWelcome === true) {
          userInfo = await getUserInfoData(api, userId).catch(() => null);
        }

        const resolvedJoinName = (userInfo?.name && userInfo.name !== "Không xác định")
          ? userInfo.name
          : (user?.dName || user?.name || "thành viên mới");
        nonBlockedJoinedUsers.push({
          userId,
          name: resolvedJoinName,
        });

        if (threadSettings.welcomeGroup) {
          let imagePath = null;
          try {
            imagePath = await cv.createWelcomeImage(
              userInfo,
              effectiveGroupName,
              groupType,
              userActionName,
              botIsAdminBox
            );
          } catch (err) {
            console.error("Loi tao anh welcome:", err.message);
          }
          if (imagePath) {
            await sendGroupMessage(api, threadId, imagePath, "");
            await cv.clearImagePath(imagePath).catch(() => {});
          } else {
            await sendGroupMessage(api, threadId, "", `👋 Chào mừng ${userInfo?.name || "thành viên mới"} đã tham gia nhóm!`);
          }
        }
      }

      if (nonBlockedJoinedUsers.length > 0 && threadSettings.prWelcome === true) {
        const rawPrText = typeof threadSettings.prWelcomeText === "string" && threadSettings.prWelcomeText.trim()
          ? threadSettings.prWelcomeText.trim()
          : "Chào mừng thành viên mới đến với nhóm! 🎉";
        const joinedNames = nonBlockedJoinedUsers.map((u) => u.name).join(", ");
        const formattedPrText = rawPrText
          .replace(/\{name\}/gi, joinedNames)
          .replace(/\{group\}/gi, effectiveGroupName);
        await sendGroupMessage(api, threadId, "", formattedPrText);
      }
      return;
    }

    if (isEventType(type, "LEAVE")) {
      for (const user of updateMembers) {
        const userId = String(user.id);
        const isUserAdminBox = groupAdmins.includes(userId) || isAdmin(userId, threadId);
        const isSelf = userId === idBot;
        const singleMemberEvent = {
          ...event,
          data: {
            ...data,
            updateMembers: [user],
          },
        };

        const blockedByAntiJoinLeave = Boolean(
          await antiJoinLeave(
            api,
            singleMemberEvent,
            isUserAdminBox,
            groupSettings,
            botIsAdminBox,
            isSelf,
            userId
          )
        );
        if (blockedByAntiJoinLeave) {
          markMemberRecentlyBlocked(threadId, userId);
          continue;
        }

        const wasAutoBlocked =
          isMemberRecentlyBlocked(threadId, userId) ||
          (botIsAdminBox && (await isUserTagged(userId, threadId).catch(() => false)));
        if (wasAutoBlocked) {
          continue;
        }

        if (idBot !== String(idAction || "") && !isSelf && threadSettings.byeGroup) {
          const userInfo = await getUserInfoData(api, userId).catch(() => null);
          let imagePath = null;
          try {
            imagePath = await cv.createGoodbyeImage(userInfo, effectiveGroupName, groupType, isUserAdminBox);
          } catch (err) {
            console.error("Loi tao anh goodbye:", err.message);
          }
          if (imagePath) {
            await sendGroupMessage(api, threadId, imagePath, "");
            await cv.clearImagePath(imagePath).catch(() => {});
          } else {
            await sendGroupMessage(api, threadId, "", `👋 ${userInfo?.name || "Thành viên"} vừa rời khỏi nhóm.`);
          }
        }
      }
      return;
    }

    if (isEventType(type, "BLOCK_MEMBER")) {
      if (idBot !== String(idAction || "") && idAction) {
        for (const user of updateMembers) {
          markMemberRecentlyBlocked(threadId, user.id);
        }

        for (const user of updateMembers) {
          const isMassBlock = await antiKickBlock(
            api,
            event,
            actorIsProtected,
            groupSettings,
            botIsAdminBox,
            idBot === String(idAction),
            idAction,
            GroupEventType.BLOCK_MEMBER
          );
          if (isMassBlock) {
            return;
          }
        }

        if (threadSettings.enableBlockImage === true) {
          for (const user of updateMembers) {
            const userId = String(user.id);
            const isUserAdminBox = groupAdmins.includes(userId) || isAdmin(userId, threadId);
            const userInfo = await getUserInfoData(api, userId).catch(() => null);
            let imagePath = null;
            try {
              imagePath = await cv.createBlockImage(
                userInfo,
                effectiveGroupName,
                groupType,
                userInfo?.genderId,
                userActionName,
                isUserAdminBox
              );
            } catch (err) {
              console.error("Loi tao anh block:", err.message);
            }
            if (imagePath) {
              await sendGroupMessage(api, threadId, imagePath, "");
              await cv.clearImagePath(imagePath).catch(() => {});
            } else {
              await sendGroupMessage(api, threadId, "", `🚨 ${userInfo?.name || userId} vừa bị block khỏi nhóm.`);
            }
          }
        }
      }
      return;
    }

    if (isEventType(type, "REMOVE_MEMBER")) {
      if (idBot !== String(idAction || "") && idAction) {
        for (const user of updateMembers) {
          const isMassKick = await antiKickBlock(
            api,
            event,
            actorIsProtected,
            groupSettings,
            botIsAdminBox,
            idBot === String(idAction),
            idAction,
            GroupEventType.REMOVE_MEMBER
          );
          if (isMassKick) {
            return;
          }
        }

        if (threadSettings.enableKickImage === true) {
          for (const user of updateMembers) {
            const userId = String(user.id);
            if (isMemberRecentlyBlocked(threadId, userId)) {
              continue;
            }
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, BLOCK_CHECK_TIMEOUT);
              timer.unref?.();
            });
            if (isMemberRecentlyBlocked(threadId, userId)) {
              continue;
            }

            const isUserAdminBox = groupAdmins.includes(userId) || isAdmin(userId, threadId);
            const userInfo = await getUserInfoData(api, userId).catch(() => null);
            let imagePath = null;
            try {
              imagePath = await cv.createKickImage(
                userInfo,
                effectiveGroupName,
                groupType,
                userInfo?.genderId,
                userActionName,
                isUserAdminBox
              );
            } catch (err) {
              console.error("Loi tao anh kick:", err.message);
            }
            if (imagePath) {
              await sendGroupMessage(api, threadId, imagePath, "");
              await cv.clearImagePath(imagePath).catch(() => {});
            } else {
              await sendGroupMessage(api, threadId, "", `🚨 ${userInfo?.name || userId} vừa bị kick khỏi nhóm.`);
            }
          }
        }
      }
      return;
    }
  } catch (error) {
    console.error("Loi xu ly su kien nhom:", error.message);
  }
}
