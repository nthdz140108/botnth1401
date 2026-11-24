import { getOwnId } from "./apis/getOwnId.js";
import { Listener } from "./apis/listen.js";
import { login, getServerInfo } from "./apis/login.js";
import { appContext } from "./context.js";
import { ZaloApiError } from "./Errors/ZaloApiError.js";
import { logger, makeURL } from "./utils.js";
import { addReactionFactory } from "./apis/addReaction.js";
import { addUserToGroupFactory } from "./apis/addUserToGroup.js";
import { changeGroupAvatarFactory } from "./apis/changeGroupAvatar.js";
import { changeGroupNameFactory } from "./apis/changeGroupName.js";
import { createGroupFactory } from "./apis/createGroup.js";
import { findUserFactory } from "./apis/findUser.js";
import { getGroupInfoFactory } from "./apis/getGroupInfo.js";
import { getGroupInfoV2Factory } from "./apis/getGroupInfoV2.js";
import { getStickersFactory } from "./apis/getStickers.js";
import { getStickersDetailFactory } from "./apis/getStickersDetail.js";
import { removeUserFromGroupFactory } from "./apis/removeUserFromGroup.js";
import { sendStickerFactory } from "./apis/sendSticker.js";
import { undoMessageFactory } from "./apis/undoMessage.js";
import { uploadAttachmentFactory } from "./apis/uploadAttachment.js";
import { checkUpdate } from "./update.js";
import { sendMessageFactory } from "./apis/sendMessage.js";
import { getCookieFactory } from "./apis/getCookie.js";
import { removeMessageFactory } from "./apis/deleteMessage.js";
import { zDeleteMessageFactory } from "./apis/zDeleteMessage.js";
import { getUserInfoFactory } from "./apis/getUserInfo.js";
import { sendVideoFactory } from "./apis/sendVideo.js";
import { getAllFriendsFactory } from "./apis/fetchAllFriend.js";
import { getAllGroupsFactory } from "./apis/fetchAllGroups.js";
import { changeGroupSettingFactory } from "./apis/changeGroupSetting.js";
import { blockUsersInGroupFactory } from "./apis/blockUsersInGroup.js";
import { addGroupAdminsFactory } from "./apis/addGroupAdmins.js";
import { removeGroupAdminsFactory } from "./apis/removeGroupAdmins.js";
import { getQRLinkFactory } from "./apis/getQRZalo.js";
import { sendBusinessCardFactory } from "./apis/sendBusinessCard.js";
import { sendFriendRequestFactory } from "./apis/sendFriendRequest.js";
import { getGroupMembersJoinRequestFactory } from "./apis/getGroupMembersJoinRequest.js";
import { handleGroupPendingMembersFactory } from "./apis/handleGroupPendingMembers.js";
import { changeGroupOwnerFactory } from "./apis/changeGroupOwner.js";
import { leaveGroupFactory } from "./apis/leaveGroup.js";
import { sendCustomStickerFactory } from "./apis/sendCustomerSticker.js";
import { changeGroupLinkFactory } from "./apis/changeGroupLink.js";
import { sendToDoFactory } from "./apis/sendToDo.js";
import { getRecentMessageFactory } from "./apis/getRecentMessage.js";
import { parseLinkFactory } from "./apis/parseLink.js";
import { sendLinkFactory } from "./apis/sendLink.js";
import { sendVoiceFactory } from "./apis/sendVoice.js";
import { sendMessagePrivateFactory } from "./apis/sendMessagePrivate.js";
import { joinGroupByLinkFactory } from "./apis/joinGroupByLink.js";
import { getInfoGroupByLinkFactory } from "./apis/getGroupInfoByLink.js";
import { sendBankCardFactory } from "./apis/sendBankCard.js";
import { sendGifFactory } from "./apis/sendGif.js";
import { getGroupMembersFactory } from "./apis/getGroupMembers.js";
import { checkImageFactory } from "./apis/checkImage.js";
import { sendImageFactory } from "./apis/sendImage.js";
import { sendFileFactory } from "./apis/sendFile.js";
import { uploadThumbnailFactory } from "./apis/uploadThumbnail.js";
import { sendMessageForwardFactory } from "./apis/sendMessageForward.js";
import { zSendLocalImageFactory } from "./apis/zSendLocalImage.js";
import { zSendMultiLocalImageFactory } from "./apis/zSendLocalImages.js";
import { sendCallVoiceFactory } from "./apis/sendCallVoice.js";
import { acceptGroupInviteFactory } from "./apis/acceptGroupInvite.js";
import { fetchAccountInfoFactory } from "./apis/account-info.js";
import { acceptFriendRequestFactory } from "./apis/acpFriendRequest.js";
import { addFriendFactory } from "./apis/addFriend.js";
import { blockUserFactory } from "./apis/blockUser.js";
import { changeAccountAvatarFactory } from "./apis/changeAccountAvatar.js";
import { changeAccountSettingFactory } from "./apis/changeAccountSettings.js";
import { changeFriendAliasFactory } from "./apis/changeFriendAlias.js";
import { deleteAvatarFactory } from "./apis/deleteavatar.js";
import { deleteGroupInviteBoxFactory } from "./apis/deleteGroupInviteBox.js";
import { disperseGroupFactory } from "./apis/disperseGroup.js";
import { getAvatarListFactory } from "./apis/getavatarlist.js";
import { getBlockedGroupMembersFactory } from "./apis/getBlockMemberList.js";
import { getFriendRequestsFactory } from "./apis/getFriendRequests.js";
import { getFriendRequestStatusFactory } from "./apis/getFriendRequestStatus.js";
import { getGroupBlockedMemberFactory } from "./apis/getGroupBlockedMember.js";
import { getGroupInviteBoxListFactory } from "./apis/getGroupInviteBoxList.js";
import { getPendingFriendRequestsFactory } from "./apis/getPendingFriendRequests.js";
import { getSettingsFactory } from "./apis/getSettings.js";
import { rejectFriendRequestFactory } from "./apis/rejectFriendRequest.js";
import { removeFriendFactory } from "./apis/removeFriend.js";
import { removeFriendAliasFactory } from "./apis/removeFriendAlias.js";
import { removeGroupBlockedMemberFactory } from "./apis/removeGroupBlockedMember.js";
import { updateLangFactory } from "./apis/setlangaccount.js";
import { setMuteFactory } from "./apis/setmute.js";
import { setMuteGroupFactory } from "./apis/setMuteGroup.js";
import { reuseAvatarFactory } from "./apis/setoldavatar.js";
import { setPinnedConversationsFactory } from "./apis/setPinnedConversations.js";
import { unblockUserFactory } from "./apis/unblockUser.js";
import { undoFriendRequestFactory } from "./apis/undoFriendRequests.js";
import { updateProfileFactory } from "./apis/updateProfile.js";
import { updateSettingsFactory } from "./apis/updateSettings.js";
import { getBotName } from "../utils/env.js";
import { API_TYPE, API_VERSION } from "./constants.js";
import { wrapWithLimiter } from "./transport-limiter.js";

const ZALOME_HOST_SUFFIX = ".zalo.me";
const CORE_SERVICE_KEYS = Object.freeze(["chat", "group", "file", "profile", "reaction"]);

function validateEndpoint(urlStr, label, expectedProtocol = "https:") {
  if (typeof urlStr !== "string" || !urlStr.trim()) {
    throw new Error(`Missing ${label} endpoint URL`);
  }
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid ${label} endpoint URL: ${urlStr}`);
  }
  if (parsed.protocol !== expectedProtocol) {
    throw new Error(`Invalid protocol ${parsed.protocol} for ${label} endpoint (expected ${expectedProtocol}): ${urlStr}`);
  }
  const hostname = parsed.hostname;
  if (!hostname.endsWith(ZALOME_HOST_SUFFIX)) {
    throw new Error(`Invalid ${label} endpoint host (must be *.zalo.me): ${urlStr}`);
  }
  return urlStr;
}

function normalizeServiceMap(zpwServiceMap) {
  if (!zpwServiceMap || typeof zpwServiceMap !== "object" || Array.isArray(zpwServiceMap)) {
    throw new Error("Login response missing service map");
  }

  return Object.fromEntries(
    Object.entries(zpwServiceMap).map(([key, entry]) => {
      if (typeof entry === "string") return [key, [entry]];
      if (Array.isArray(entry)) return [key, [...entry]];
      return [key, entry];
    })
  );
}

function validateServiceMap(zpwServiceMap) {
  if (!zpwServiceMap || typeof zpwServiceMap !== "object" || Array.isArray(zpwServiceMap)) {
    throw new Error("Login response missing service map");
  }
  for (const key of CORE_SERVICE_KEYS) {
    const entry = zpwServiceMap[key];
    if (!Array.isArray(entry) || !entry[0]) {
      throw new Error(`Login response missing required endpoint: ${key}`);
    }
    validateEndpoint(entry[0], key);
  }
  return zpwServiceMap;
}

function createLoginSession(loginData, serverInfo, timestamp = Date.now()) {
  const loginInfo = loginData?.data;
  if (!loginInfo || !serverInfo) {
    throw new Error("Login failed: cookie is expired or invalid");
  }
  if (!loginInfo.uid) {
    throw new Error("Login response invalid: missing uid. Cookie may have expired.");
  }
  if (!loginInfo.zpw_enk) {
    throw new Error("Login response invalid: missing zpw_enk. Cookie may have expired.");
  }

  const zpwServiceMap = validateServiceMap(
    normalizeServiceMap(loginInfo.zpw_service_map_v3)
  );
  const wsEndpoints = typeof loginInfo.zpw_ws === "string"
    ? [loginInfo.zpw_ws]
    : loginInfo.zpw_ws;
  if (!Array.isArray(wsEndpoints) || !wsEndpoints[0]) {
    throw new Error("Login response missing zpw_ws. Cookie may have expired.");
  }
  const wsEndpoint = validateEndpoint(wsEndpoints[0], "zpw_ws[0]", "wss:");
  const validWsEndpoints = [wsEndpoint];
  for (let i = 1; i < wsEndpoints.length; i += 1) {
    try {
      const candidate = validateEndpoint(wsEndpoints[i], `zpw_ws[${i}]`, "wss:");
      if (!validWsEndpoints.includes(candidate)) {
        validWsEndpoints.push(candidate);
      }
    } catch {}
  }
  const buildWsUrl = (endpoint) => makeURL(endpoint, {
    zpw_ver: API_VERSION,
    zpw_type: API_TYPE,
    t: timestamp,
  });
  const wsUrl = buildWsUrl(wsEndpoint);
  const resolvedWsEndpoints = validWsEndpoints.map(buildWsUrl);

  return {
    uid: loginInfo.uid,
    secretKey: loginInfo.zpw_enk,
    send2meId: loginInfo.send2me_id,
    settings: serverInfo.setttings ?? serverInfo.settings ?? {},
    extraVer: serverInfo.extra_ver,
    loginInfo,
    zpwServiceMap,
    wsUrl,
    wsEndpoints: resolvedWsEndpoints,
  };
}

class Zalo {
  constructor(credentials, options) {
    this.enableEncryptParam = true;
    this.validateParams(credentials);
    this.imei = credentials.imei;
    appContext.imei = credentials.imei;
    appContext.cookie = this.parseCookies(credentials.cookie);
    appContext.userAgent = credentials.userAgent;
    appContext.language = credentials.language || "vi";
    appContext.timeMessage = credentials.timeMessage || 0;
    appContext.secretKey = null;
    appContext.uid = null;
    appContext.send2meId = null;
    appContext.settings = null;
    appContext.loginInfo = null;
    this.userId = null;
    this.send2meId = null;
    this.secretKey = null;
    this.is_main_bot = getBotName() === "admin";

    if (options) Object.assign(appContext.options, options);
  }

  parseCookies(cookie) {
    if (typeof cookie === "string") {
      const cookieString = cookie.trim();
      if (!cookieString) throw new Error("Invalid cookie format");
      return cookieString;
    }
    const cookies = Array.isArray(cookie) ? cookie : cookie?.cookies;
    if (!Array.isArray(cookies)) {
      throw new Error("Invalid cookie format");
    }
    const cookieString = cookies
      .map((c) => `${c.name ?? c.key}=${c.value}`)
      .filter((value) => !value.startsWith("undefined=") && !value.endsWith("=undefined"))
      .join("; ");
    if (!cookieString) throw new Error("Invalid cookie format");
    return cookieString;
  }

  validateParams(credentials) {
    if (!credentials?.imei || !credentials?.cookie || !credentials?.userAgent) {
      throw new Error("Missing required params");
    }
  }

  async fetchSession() {
    await checkUpdate();
    const loginData = await login(this.enableEncryptParam);
    const serverInfo = await getServerInfo(this.enableEncryptParam);
    const session = createLoginSession(loginData, serverInfo);
    const { uid, secretKey, send2meId } = session;

    appContext.secretKey = secretKey;
    appContext.uid = uid;
    appContext.send2meId = send2meId;
    appContext.settings = session.settings;
    appContext.extraVer = session.extraVer;
    appContext.loginInfo = session.loginInfo;

    this.userId = uid;
    this.send2meId = send2meId;
    this.secretKey = secretKey;
    return session;
  }

  async login() {
    const session = await this.fetchSession();
    const { uid, secretKey, zpwServiceMap, wsUrl, wsEndpoints } = session;
    const botType = this.is_main_bot ? "Main Bot" : "Mini Bot";
    console.debug(`Đăng nhập thành công trên ${botType} ${uid}`);

    return new API(
      secretKey,
      zpwServiceMap,
      wsUrl,
      this.is_main_bot,
      wsEndpoints
    );
  }
}

Zalo.API_TYPE = API_TYPE;
Zalo.API_VERSION = API_VERSION;

class API {
  constructor(secretKey, zpwServiceMap, wsUrl, is_main_bot = false, wsEndpoints = null) {
    this.secretKey = secretKey;
    this.zpwServiceMap = zpwServiceMap;
    this.listener = new Listener(wsUrl, { wsEndpoints });
    this.is_main_bot = is_main_bot;
    this.getOwnId = getOwnId;
    this._initCapabilities();
  }

  _initCapabilities() {
    const coreCapabilities = [
      ["sendMessage", sendMessageFactory],
      ["uploadAttachment", uploadAttachmentFactory],
      ["getGroupInfo", getGroupInfoFactory],
      ["getUserInfo", getUserInfoFactory],
      ["getAllGroups", getAllGroupsFactory],
      ["getAllFriends", getAllFriendsFactory],
      ["addReaction", addReactionFactory],
    ];

    const optionalCapabilities = [
      ["getGroupInfoV2", getGroupInfoV2Factory],
      ["getStickers", getStickersFactory],
      ["getStickersDetail", getStickersDetailFactory],
      ["findUser", findUserFactory],
      ["uploadThumbnail", uploadThumbnailFactory],
      ["createGroup", createGroupFactory],
      ["changeGroupAvatar", changeGroupAvatarFactory],
      ["removeUserFromGroup", removeUserFromGroupFactory],
      ["addUserToGroup", addUserToGroupFactory],
      ["changeGroupName", changeGroupNameFactory],
      ["sendSticker", sendStickerFactory],
      ["undoMessage", undoMessageFactory],
      ["deleteMessage", removeMessageFactory],
      ["zDeleteMessage", zDeleteMessageFactory],
      ["sendVideo", sendVideoFactory],
      ["changeGroupSetting", changeGroupSettingFactory],
      ["blockUsers", blockUsersInGroupFactory],
      ["addGroupAdmins", addGroupAdminsFactory],
      ["removeGroupAdmins", removeGroupAdminsFactory],
      ["getQRLink", getQRLinkFactory],
      ["sendBusinessCard", sendBusinessCardFactory],
      ["sendFriendRequest", sendFriendRequestFactory],
      ["getGroupPendingMembers", getGroupMembersJoinRequestFactory],
      ["handleGroupPendingMembers", handleGroupPendingMembersFactory],
      ["changeGroupOwner", changeGroupOwnerFactory],
      ["leaveGroup", leaveGroupFactory],
      ["sendCustomSticker", sendCustomStickerFactory],
      ["changeGroupLink", changeGroupLinkFactory],
      ["sendTodo", sendToDoFactory],
      ["getRecentMessages", getRecentMessageFactory],
      ["parseLink", parseLinkFactory],
      ["sendLink", sendLinkFactory],
      ["sendVoice", sendVoiceFactory],
      ["sendPrivate", sendMessagePrivateFactory],
      ["getGroupInfoByLink", getInfoGroupByLinkFactory],
      ["joinGroup", joinGroupByLinkFactory],
      ["sendBankCard", sendBankCardFactory],
      ["sendGif", sendGifFactory],
      ["getGroupMembers", getGroupMembersFactory],
      ["sendImage", sendImageFactory],
      ["sendFile", sendFileFactory],
      ["sendMessageForward", sendMessageForwardFactory],
      ["sendCallVoice", sendCallVoiceFactory],
      ["zSendLocalImage", zSendLocalImageFactory],
      ["zSendLocalImages", zSendMultiLocalImageFactory],
      ["acceptGroupInvite", acceptGroupInviteFactory],
      ["fetchAccountInfo", fetchAccountInfoFactory],
      ["acceptFriendRequest", acceptFriendRequestFactory],
      ["addFriend", addFriendFactory],
      ["blockUser", blockUserFactory],
      ["changeAccountAvatar", changeAccountAvatarFactory],
      ["changeAccountSetting", changeAccountSettingFactory],
      ["changeFriendAlias", changeFriendAliasFactory],
      ["deleteAvatar", deleteAvatarFactory],
      ["deleteGroupInviteBox", deleteGroupInviteBoxFactory],
      ["disperseGroup", disperseGroupFactory],
      ["getAvatarList", getAvatarListFactory],
      ["getBlockedGroupMembers", getBlockedGroupMembersFactory],
      ["getFriendRequests", getFriendRequestsFactory],
      ["getFriendRequestStatus", getFriendRequestStatusFactory],
      ["getGroupBlockedMember", getGroupBlockedMemberFactory],
      ["getGroupInviteBoxList", getGroupInviteBoxListFactory],
      ["getPendingFriendRequests", getPendingFriendRequestsFactory],
      ["getSettings", getSettingsFactory],
      ["rejectFriendRequest", rejectFriendRequestFactory],
      ["removeFriend", removeFriendFactory],
      ["removeFriendAlias", removeFriendAliasFactory],
      ["removeGroupBlockedMember", removeGroupBlockedMemberFactory],
      ["updateLang", updateLangFactory],
      ["setMute", setMuteFactory],
      ["setMuteGroup", setMuteGroupFactory],
      ["reuseAvatar", reuseAvatarFactory],
      ["setPinnedConversations", setPinnedConversationsFactory],
      ["unblockUser", unblockUserFactory],
      ["undoFriendRequest", undoFriendRequestFactory],
      ["updateProfile", updateProfileFactory],
      ["updateSettings", updateSettingsFactory],
    ];

    const initCapability = (name, factory, isCore) => {
      try {
        this[name] = factory(this);
      } catch (e) {
        if (isCore) {
          throw new Error(`Failed to initialize core capability ${name}: ${e.message}`, {
            cause: e,
          });
        }
        console.warn(`[WARN] Không thể khởi tạo ${name}: ${e.message}`);
        this[name] = () => {
          throw new ZaloApiError(`${name} unavailable: ${e.message}`);
        };
      }
    };

    for (const [name, factory] of coreCapabilities) {
      initCapability(name, factory, true);
    }
    for (const [name, factory] of optionalCapabilities) {
      initCapability(name, factory, false);
    }

    this.getCookie = getCookieFactory();
    this.checkImage = checkImageFactory();

    // Outbound transport limiter: caps concurrency + spacing for send/upload
    // APIs so bursts of group traffic cannot trigger Zalo 429 storms.
    try {
      wrapWithLimiter(this);
    } catch (limiterError) {
      console.warn(`[WARN] transport limiter unavailable: ${limiterError.message}`);
    }
  }

  /**
   * Refresh secretKey, zpwServiceMap capabilities, and WebSocket endpoints
   * in-place so existing references (schedulers, dispatchers, web bridge,
   * bound listener EventEmitter) remain valid without leaking listeners.
   */
  applyRefreshedSession({ secretKey, zpwServiceMap, wsUrl, wsEndpoints = null } = {}) {
    if (!secretKey) throw new ZaloApiError("Refreshed session missing secretKey");
    validateServiceMap(zpwServiceMap);
    validateEndpoint(wsUrl, "websocket", "wss:");
    this.secretKey = secretKey;
    this.zpwServiceMap = zpwServiceMap;
    this._initCapabilities();
    if (typeof this.listener?.updateEndpoints === "function") {
      this.listener.updateEndpoints(wsUrl, wsEndpoints);
    } else if (this.listener) {
      this.listener.url = wsUrl;
    }
    this.assertReady();
    return this;
  }

  assertReady() {
    const missingContextFields = ["secretKey", "uid", "imei", "cookie", "userAgent"]
      .filter((field) => !appContext[field]);
    if (!this.secretKey || missingContextFields.length > 0) {
      throw new ZaloApiError(
        `API not initialized: missing ${missingContextFields.join(", ") || "secretKey"}`
      );
    }
    validateServiceMap(this.zpwServiceMap);
    validateEndpoint(this.listener?.url, "websocket", "wss:");
    const coreCapabilities = [
      "sendMessage",
      "uploadAttachment",
      "getGroupInfo",
      "getUserInfo",
      "getAllGroups",
      "getAllFriends",
      "addReaction",
    ];
    for (const name of coreCapabilities) {
      if (typeof this[name] !== "function") {
        throw new ZaloApiError(`API not initialized: core capability ${name} is missing`);
      }
    }
    return true;
  }
}

export {
  API,
  CORE_SERVICE_KEYS,
  Zalo,
  createLoginSession,
  normalizeServiceMap,
  validateEndpoint,
  validateServiceMap,
};

function addFriendAlias(...args) {
  return this.sendFriendRequest(...args);
}

API.prototype.addFriend = addFriendAlias;
