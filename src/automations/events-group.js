import { GroupEventType, MessageType } from "../api-zalo/models/index.js";
import { getUserInfoData } from "../service-debug/info-service/user-info.js";
import { readGroupSettings } from "../utils/io-json.js";
import { getBotId } from "../utils/env.js";
import { isAdmin } from "../utils/role-policy.js";
import { getGroupAdmins, getGroupInfoData } from "../service-debug/info-service/group-info.js";
import * as cv from "../utils/canvas/index.js";
import { antiJoinLeave } from "../service-debug/anti-service/anti-join-leave.js";
import { antiKickBlock } from "../service-debug/anti-service/anti-kick-all.js";
import { handleMemberJoin } from "../commands/bot-manager/group-manage.js";
import { handleTargetOnJoin } from "../commands/bot-manager/nqduan-bridge.js";
import { getGroupEventActorId, getGroupEventMembers } from "./group-event-utils.js";
import { trackLocmemGroupAction, getLocmemStore } from "../service-debug/locmem/index.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";

const blockedMembers = new Map();
const BLOCK_CHECK_TIMEOUT = 300;

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

export async function groupEvents(api, event, context = {}) {
  const runtimeContext = context?.runtimeContext || getRuntimeContext();
  try {
    trackLocmemGroupAction(api, event, runtimeContext);
  } catch (err) {
    console.error("[locmem] trackLocmemGroupAction error:", err);
  }

  try {
    const threadId = String(event.threadId || event.data?.groupId || "");
    const type = event.type;
    const isJoinEvent = type === GroupEventType.JOIN || type === GroupEventType.ADD_MEMBER;
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
    const type = event.type;
    const updateMembers = getGroupEventMembers(event);
    const groupName = event.data.groupName;
    const threadId = event.threadId;
    const groupType = event.data.groupType;
    const idAction = getGroupEventActorId(event);
    let groupInfo, groupAdmins, botIsAdminBox = false;
    const groupSettings = readGroupSettings();
    const threadSettings = groupSettings[threadId] || {};

    const idBot = getBotId();
    if (!idBot) {
      return;
    }

    if (updateMembers.length > 0) {
      groupInfo = await getGroupInfoData(api, threadId);
      const effectiveGroupName = groupName || groupInfo?.name || "Nhóm";
      groupAdmins = await getGroupAdmins(groupInfo);
      botIsAdminBox = groupAdmins.includes(idBot.toString());
      const userActionInfo = idAction ? await getUserInfoData(api, idAction) : null;
      const userActionName = userActionInfo?.name || "Không xác định";

      if (type === GroupEventType.REMOVE_MEMBER && updateMembers.length > 1) {
        for (const user of updateMembers) {
          const userId = user.id;
          const isAdminBox = isAdmin(userId, threadId);
          const isSelf = userId === idBot;

          if (idBot !== idAction && idAction) {
            const isMassKick = await antiKickBlock(
              api,
              event,
              isAdminBox,
              groupSettings,
              botIsAdminBox,
              idBot === idAction,
              idAction,
              GroupEventType.REMOVE_MEMBER
            );
            if (isMassKick) {
              return;
            }
            if (!blockedMembers.has(userId)) {
              await new Promise((resolve) => setTimeout(resolve, BLOCK_CHECK_TIMEOUT));
              if (!blockedMembers.has(userId)) {
                const userInfo = await getUserInfoData(api, userId);
                let imagePath = null;
                try {
                  imagePath = await cv.createKickImage(
                    userInfo,
                    effectiveGroupName,
                    groupType,
                    userInfo?.genderId,
                    userActionName,
                    botIsAdminBox
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
        }
      } else if (type === GroupEventType.JOIN && updateMembers.length > 1) {
        await handleMemberJoin(api, event);

        for (const user of updateMembers) {
          const userId = String(user.id);
          const isAdminBox = isAdmin(userId, threadId);
          const isSelf = userId === idBot;

          const isBlocked = await antiJoinLeave(
            api,
            event,
            isAdminBox,
            groupSettings,
            botIsAdminBox,
            isSelf,
            userId
          );

          if (!isBlocked && threadSettings.welcomeGroup) {
            const userInfo = await getUserInfoData(api, userId);
            let imagePath = null;
            try {
              imagePath = await cv.createWelcomeImage(
                userInfo,
                effectiveGroupName,
                groupType,
                userActionName
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
      } else {
        const user = updateMembers[0];
        const userId = String(user.id);
        const userInfo = await getUserInfoData(api, userId);
        const isAdminBox = isAdmin(userId, threadId);
        let imagePath;
        let messageText = "";

        switch (type) {
          case GroupEventType.JOIN_REQUEST:
            if (threadSettings.memberApprove) {
              await api.handleGroupPendingMembers(threadId, true);
            }
            break;

          case GroupEventType.JOIN:
            await handleMemberJoin(api, event);

            groupInfo = await getGroupInfoData(api, threadId);
            groupAdmins = await getGroupAdmins(groupInfo);
            botIsAdminBox = groupAdmins.includes(idBot.toString());
            const isSelf = userId === idBot;

            const isBlocked = await antiJoinLeave(
              api,
              event,
              isAdminBox,
              groupSettings,
              botIsAdminBox,
              isSelf,
              userId
            );

            if (!isBlocked && await handleTargetOnJoin(api, event)) {
              return;
            }

            if (!isBlocked && threadSettings.welcomeGroup) {
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
            break;

          case GroupEventType.LEAVE:
            groupInfo = await getGroupInfoData(api, threadId);
            groupAdmins = await getGroupAdmins(groupInfo);
            botIsAdminBox = groupAdmins.includes(idBot.toString());
            if (idBot !== idAction && threadSettings.byeGroup) {
              try {
                imagePath = await cv.createGoodbyeImage(userInfo, effectiveGroupName, groupType, botIsAdminBox);
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
            break;

          case GroupEventType.REMOVE_MEMBER:
            groupInfo = await getGroupInfoData(api, threadId);
            groupAdmins = await getGroupAdmins(groupInfo);
            botIsAdminBox = groupAdmins.includes(idBot.toString());
            if (idBot !== idAction && idAction) {
              const isMassKick = await antiKickBlock(
                api,
                event,
                isAdminBox,
                groupSettings,
                botIsAdminBox,
                idBot === idAction,
                idAction,
                GroupEventType.REMOVE_MEMBER
              );
              if (isMassKick) {
                return;
              }
              if (!blockedMembers.has(userId)) {
                await new Promise((resolve) => setTimeout(resolve, BLOCK_CHECK_TIMEOUT));
                if (!blockedMembers.has(userId)) {
                  const shouldNotifyKick = threadSettings.enableKickImage === true;
                  if (shouldNotifyKick) {
                    try {
                      imagePath = await cv.createKickImage(
                        userInfo,
                        effectiveGroupName,
                        groupType,
                        userInfo?.genderId,
                        userActionName,
                        botIsAdminBox
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
            }
            break;

          case GroupEventType.BLOCK_MEMBER:
            groupInfo = await getGroupInfoData(api, threadId);
            groupAdmins = await getGroupAdmins(groupInfo);
            botIsAdminBox = groupAdmins.includes(idBot.toString());
            if (idBot !== idAction && idAction) {
              const isMassBlock = await antiKickBlock(
                api,
                event,
                isAdminBox,
                groupSettings,
                botIsAdminBox,
                idBot === idAction,
                idAction,
                GroupEventType.BLOCK_MEMBER
              );
              if (isMassBlock) {
                return;
              }
              blockedMembers.set(userId, Date.now());
              const shouldNotifyBlock = threadSettings.enableBlockImage === true;
              if (shouldNotifyBlock) {
                try {
                  imagePath = await cv.createBlockImage(
                    userInfo,
                    effectiveGroupName,
                    groupType,
                    userInfo?.genderId,
                    userActionName,
                    botIsAdminBox
                  );
                } catch (err) {
                  console.error("Loi tao anh block:", err.message);
                }
              }
              setTimeout(() => {
                blockedMembers.delete(userId);
              }, 1000);
              if (shouldNotifyBlock) {
                if (imagePath) {
                  await sendGroupMessage(api, threadId, imagePath, "");
                  await cv.clearImagePath(imagePath).catch(() => {});
                } else {
                  await sendGroupMessage(api, threadId, "", `🚨 ${userInfo?.name || userId} vừa bị block khỏi nhóm.`);
                }
              }
            }
            break;

          default:
            return;
        }
      }
    } else {
      switch (type) {
        case GroupEventType.JOIN_REQUEST:
          if (threadSettings.memberApprove) {
            await api.handleGroupPendingMembers(threadId, true);
          }
          break;
      }
    }
  } catch (error) {
    console.error("Loi xu ly su kien nhom:", error.message);
  }
}
