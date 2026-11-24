import { LRUCache } from "lru-cache";
import { sendReactionConfirmReceive } from "./command-response.js";
export { sendReactionConfirmReceive } from "./command-response.js";

import { readWebConfig, writeGroupSettings, getCommandConfig } from "../utils/io-json.js";
import { getInstanceKind, getBotId, getProjectRoot } from "../utils/env.js";
import { managerData } from "./bot-manager/active-bot.js";
import { isMyBotAdminCooldownBypass, dispatchCommand } from "./command-dispatcher.js";
import { isDatabaseReady } from "../utils/server-config.js";
import { sendMessageInsufficientAuthority } from "../service-debug/chat-zalo/chat-style/chat-style.js";
import { handlePrefixCommand } from "./bot-manager/prefix.js";
import { getGlobalPrefix } from "../service-debug/service.js";
import { parseCommandContent } from "./command-parser.js";
import { resolveCommand } from "./command-router.js";
import {
  canInteractWithGroup,
  resolveGroupCommandPermission,
  shouldPersistGroupSettings,
} from "./group-interaction-policy.js";
import { commandRegistry } from "./command-registry.js";
import { getActiveRuntimeLifecycle } from "../core/runtime-lifecycle.js";
import { scopeAllows } from "./command-policy.js";
import {
  loadRuntimeCommandPolicy,
  resolveRuntimeCommandPolicy,
  resolveStudioBehaviorOverlay,
  resolveCommandConfigForContext,
} from "./command-policy-loader.js";
import { getRuntimeDependencyState } from "../utils/runtime-dependencies.js";
import { isHighRiskCommand } from "./high-risk-policy.js";
import { checkNotFindCommand } from "./bot-manager/utilities.js";
import { removeMention } from "../utils/format-util.js";
import { sendReactionWaitingCountdown } from "./manager-command/check-countdown.js";
import { getPermissionCommandName } from "./manager-command/set-command.js";
import {
  getBehaviorForCommand,
  evaluateBehaviorGate,
  CooldownLedger,
  renderBehaviorMessage,
  buildTemplateVars,
} from "./command-behavior-context.js";
import { resolveInstanceAuthorization } from "../utils/instance-authorization.js";
import { logAuthorizationDecision } from "../utils/authorization-log.js";
import { resolveRequiredRole, roleSatisfies } from "./command-permission-policy.js";
import { ROLE_LEVELS, formatPermissionDenied } from "../utils/role-policy.js";
import { resolveCommandPartsToCustom } from "./custom-commands/resolver.js";
import { invokeCustomCommand } from "./custom-commands/cmdadd-command.js";
import { checkCustomCommandCooldown } from "./custom-commands/cooldown.js";

const cooldownLedgers = new LRUCache({ max: 500 });
const runtimePolicyCache = new LRUCache({ max: 64, ttl: 5 * 60 * 1000 });

function getCooldownLedger(commandName) {
  let ledger = cooldownLedgers.get(commandName);
  if (!ledger) {
    ledger = new CooldownLedger();
    cooldownLedgers.set(commandName, ledger);
  }
  return ledger;
}

function getRuntimeCommandPolicy(command) {
  const botId = String(getBotId() || "admin");
  let policy = runtimePolicyCache.get(botId);
  if (!policy) {
    policy = loadRuntimeCommandPolicy({ botId });
    runtimePolicyCache.set(botId, policy);
  }
  return resolveRuntimeCommandPolicy(command, policy);
}

function getRawRuntimePolicy() {
  const botId = String(getBotId() || "admin");
  let policy = runtimePolicyCache.get(botId);
  if (!policy) {
    policy = loadRuntimeCommandPolicy({ botId });
    runtimePolicyCache.set(botId, policy);
  }
  return policy;
}

function mergeStudioBehavior(behaviorProfile, overlay) {
  if (!overlay || typeof overlay !== "object") return behaviorProfile;
  return deepMergeBehaviorProfiles(behaviorProfile, overlay);
}

function deepMergeBehaviorProfiles(base, patch) {
  const output = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = deepMergeBehaviorProfiles(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function studioOverlayFor(commandName, threadId) {
  try {
    return resolveStudioBehaviorOverlay(getRawRuntimePolicy(), commandName, {
      botId: String(getBotId() || "admin"),
      threadId,
      root: getProjectRoot(),
    });
  } catch {
    return null;
  }
}

function commandConfigForContext(commandName, threadId) {
  try {
    return resolveCommandConfigForContext({
      policy: getRawRuntimePolicy(),
      root: getProjectRoot(),
      commandName,
      botId: String(getBotId() || "admin"),
      threadId,
    });
  } catch {
    return null;
  }
}

export function invalidateRuntimePolicyCache(botId = null) {
  if (botId === null) {
    runtimePolicyCache.clear();
    return;
  }
  runtimePolicyCache.delete(String(botId));
}

export function getCommand(command, commandConfig) {
  const commandConfigFinal = Array.isArray(commandConfig)
    ? commandConfig
    : Array.isArray(getCommandConfig()?.commands)
      ? getCommandConfig().commands
      : [];

  return commandConfigFinal.find(
    (cmd) => cmd.name === command || (cmd.alias && cmd.alias.includes(command))
  );
}

function findRegistryDefinition(name) {
  if (!name) return null;
  const normalized = String(name).trim().toLowerCase();
  return commandRegistry.lookup?.get(normalized)?.[0] || commandRegistry[normalized] || null;
}

function buildRuntimeAliasRegistry(aliasKey, definition) {
  const key = String(aliasKey || "").trim().toLowerCase();
  const lookup = new Map(commandRegistry.lookup);
  lookup.set(key, [definition]);
  const keys = [...lookup.keys()].sort((left, right) => {
    const lengthDifference = right.split(" ").length - left.split(" ").length;
    return lengthDifference || right.length - left.length;
  });
  return {
    ...commandRegistry,
    lookup,
    keys,
  };
}

async function checkPermission(
  api,
  message,
  commandName,
  userPermissionLevel,
  isNotify = true,
  { aliasCommand = "", args = [], scope = "group" } = {}
) {
  const commandConfig = Array.isArray(getCommandConfig()?.commands) ? getCommandConfig().commands : [];
  const command = getCommand(commandName, commandConfig);

  const policy = resolveRequiredRole({
    canonicalName: commandName,
    alias: aliasCommand || commandName,
    args,
    scope,
  });
  if (policy.failClosed) {
    if (isNotify) {
      await sendMessageInsufficientAuthority(
        api,
        message,
        `Lệnh "${commandName}" chưa có chính sách quyền và bị từ chối (fail-closed).`
      );
    }
    return false;
  }

  const registryEntry = findRegistryDefinition(commandName) || findRegistryDefinition(command?.name);
  const runtimePolicy = getRuntimeCommandPolicy(command || { name: commandName });
  const configuredPermission = registryEntry?.permission || runtimePolicy.permission || command?.permission;
  const configuredName = resolveGroupCommandPermission(commandName, configuredPermission);
  const requiredPermissionName = commandName === "setcmd"
    ? "adminLevelHigh"
    : ROLE_LEVELS[configuredName] !== undefined && ROLE_LEVELS[configuredName] > ROLE_LEVELS[policy.requiredRole]
      ? configuredName
      : policy.requiredRole;
  if (roleSatisfies(userPermissionLevel, requiredPermissionName)) {
    return true;
  }

  getPermissionCommandName({
    ...command,
    permission: requiredPermissionName,
  });
  if (isNotify) {
    const caption = formatPermissionDenied(requiredPermissionName);
    await sendMessageInsufficientAuthority(api, message, caption);
  }
  return false;
}

export async function checkCommandCountdown(
  api,
  message,
  userId,
  commandName,
  commandUsage
) {
  const commandConfig = Array.isArray(getCommandConfig()?.commands) ? getCommandConfig().commands : [];
  const command = getCommand(commandName, commandConfig);

  if (!command) {
    return true;
  }

  const behavior = mergeStudioBehavior(
    getBehaviorForCommand(getRuntimeCommandPolicy(command)),
    studioOverlayFor(command.name, message?.threadId),
  );
  const verdict = getCooldownLedger(command.name).consume({
    behavior,
    fallbackCountdownSeconds: Number(command.countdown) || 0,
    userId,
    threadId: message.threadId,
  });
  if (!verdict.allowed) {
    const vars = buildTemplateVars({
      user: message?.data?.uidFrom,
      userId: message?.data?.uidFrom,
      thread: message.threadId,
      command: command.name,
      prefix: getGlobalPrefix(),
      remaining: verdict.remainingSeconds,
      reason: verdict.reasonCode || "",
      behavior,
    });
    let custom = null;
    if (verdict.reasonCode === "MAX_USES_PER_HOUR") {
      custom = renderBehaviorMessage(behavior, "onMaxUses", vars);
    }
    if (!custom) {
      custom = renderBehaviorMessage(behavior, "onCooldown", vars);
    }
    if (custom) {
      await api.sendMessage({ msg: custom }, message.threadId, message.type);
    } else {
      await sendReactionWaitingCountdown(
        api,
        message,
        verdict.remainingSeconds,
        commandName
      );
    }
    return false;
  }

  return true;
}

export function initGroupSettings(groupSettings, threadId, nameGroup) {
  if (!threadId) return;
  const isNewGroup = !groupSettings[threadId];

  const defaultSettings = {
    adminList: {},
    muteList: {},
    activeBot: false,
    welcomeGroup: false,
    byeGroup: false,
    antiSpam: false,
    filterBadWords: false,
    removeLinks: false,
    learnEnabled: false,
    replyEnabled: false,
    onlyText: false,
    memberApprove: false,
    antiNude: false,
    allowSticker: false,
    allowStickerlag: false,
    antiGif: false,
    antiVideo: false,
    antiStickerEffect: false,
    enableKickImage: false,
    enableBlockImage: false,
    enableDownload: false,
    autoReplyCommand: false,
    whiteList: {},
    antiUndo: false,
    sendtext: false,
    removeTags: false,
    antiMention: false,
    enableSetup: false,
    antiJoinLeave: false,
    antiKickBlock: false,
    enableAntiBot: false,
    antiPhotoVideo: false,
    antiVoice: false,
    antiText: false,
    antiFile: false,
    updateGroup: false,
    blockForward: false,
    autoJoin: false,
    antiPhoneNumber: false,
    ifMentioned: false,
  };

  if (isNewGroup) {
    groupSettings[threadId] = { nameGroup: nameGroup || "" };
  }

  let hasNewFields = false;
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!(key in groupSettings[threadId])) {
      groupSettings[threadId][key] = value;
      hasNewFields = true;
    }
  }

  const nameChanged = nameGroup && (!groupSettings[threadId].nameGroup || groupSettings[threadId].nameGroup !== nameGroup);
  if (nameChanged) {
    groupSettings[threadId].nameGroup = nameGroup;
  }

  if (isNewGroup || hasNewFields || nameChanged) {
    writeGroupSettings(groupSettings);
  }
}

export async function checkAdminLevelHighest(
  api,
  message,
  isAdminLevelHighest
) {
  if (!isAdminLevelHighest) {
    await sendMessageInsufficientAuthority(
      api,
      message,
      formatPermissionDenied("adminLevelHigh")
    );
    return false;
  }
  return true;
}

export async function checkAdminBotPermission(api, message, callerIsBotAdmin) {
  if (!callerIsBotAdmin) {
    await sendMessageInsufficientAuthority(
      api,
      message,
      formatPermissionDenied("adminBot")
    );
    return false;
  }
  return true;
}

export async function checkAdminBoxPermission(api, message, callerIsAdminBox) {
  if (!callerIsAdminBox) {
    await sendMessageInsufficientAuthority(
      api,
      message,
      formatPermissionDenied("adminBox")
    );
    return false;
  }
  return true;
}

function createCommandErrorReference(message, error) {
  const threadPart = message?.threadId ? String(message.threadId) : "unknown-thread";
  const senderPart = message?.data?.uidFrom ? String(message.data.uidFrom) : "unknown-user";
  const errorName = error instanceof Error ? error.name : typeof error;
  const referenceSeed = `${threadPart}:${senderPart}:${Date.now()}:${errorName}`;
  let hash = 0;
  for (let index = 0; index < referenceSeed.length; index += 1) {
    hash = (hash * 31 + referenceSeed.charCodeAt(index)) >>> 0;
  }
  return `CMD-${hash.toString(16).toUpperCase().padStart(8, "0")}`;
}

function formatMissingDependencyDetail(item) {
  if (!item || typeof item !== "object") {
    return String(item);
  }
  if (item.kind === "database") {
    return "database";
  }
  if (item.kind === "config") {
    return `config ${item.name || item.requirements?.join(" or ")}`;
  }
  if (item.kind === "runtime") {
    return `runtime ${item.name}`;
  }
  return item.name || item.kind || "dependency";
}

function formatMissingDependencyMessage(result) {
  if (Array.isArray(result?.missingDetails) && result.missingDetails.length > 0) {
    return result.missingDetails.map(formatMissingDependencyDetail).join(", ");
  }
  if (Array.isArray(result?.missing) && result.missing.length > 0) {
    return result.missing.map((item) => (
      Array.isArray(item) ? item.join(" or ") : String(item)
    )).join(", ");
  }
  return "";
}

async function sendCommandError(api, message, error) {
  const threadId = message?.threadId;
  const senderId = message?.data?.uidFrom;
  const reference = createCommandErrorReference(message, error);
  if (!threadId || typeof message?.type === "undefined" || !message?.data) {
    console.error("Không thể gửi lỗi command do message thiếu trường bắt buộc", {
      reference,
      threadId,
      messageType: message?.type,
      hasData: Boolean(message?.data),
      senderId,
      error,
    });
    return false;
  }
  try {
    await api.sendMessage(
      {
        msg: `Đã xảy ra lỗi khi xử lý lệnh. Vui lòng thử lại sau.\nMã lỗi: ${reference}`,
      },
      threadId,
      message?.type
    );
  } catch (sendError) {
    console.error("Lỗi khi gửi thông báo lỗi command", {
      reference,
      threadId,
      senderId,
      sendError,
      originalError: error,
    });
    return false;
  }
  console.error("Lỗi command đã được báo cho người dùng", {
    reference,
    threadId,
    senderId,
    error,
  });
  return true;
}

async function sendPhase1Result(api, message, result) {
  if (!result || result.code === "HANDLED" || result.code === "ACCEPTED") return;
  if (result.code === "HANDLER_ERROR") {
    await sendCommandError(api, message, result.error);
    return;
  }

  const behavior = mergeStudioBehavior(
    getBehaviorForCommand(getRuntimeCommandPolicy({ name: result.command })),
    studioOverlayFor(result.command, message?.threadId),
  );
  const customText = renderBehaviorMessage(behavior, result.code, buildTemplateVars({
    user: message?.data?.uidFrom, userId: message?.data?.uidFrom, thread: message?.threadId,
    command: result.command, prefix: getGlobalPrefix(), reason: result.reason || "",
    behavior,
  }));
  if (customText) {
    await api.sendMessage({ msg: customText }, message.threadId, message.type);
    return;
  }

  const messages = {
    SCOPE_DENIED: "This command is not available in this chat scope.",
    INSTANCE_DENIED: "Lệnh này chỉ khả dụng trên bot admin.",
    PERMISSION_DENIED: "You do not have permission to use this command.",
    COMMAND_DISABLED: "This command is currently disabled.",
    DRY_RUN_REQUIRED: "This high-risk command requires dry-run confirmation.",
    KILL_SWITCH_ACTIVE: "This command is currently blocked by dashboard safety controls.",
    MISSING_ARGUMENT: "Please provide the required command arguments.",
    MISSING_DEPENDENCY: "This command is missing required dependencies.",
    DB_BLOCKED: "This command requires a ready database.",
    TIMEOUT: "The command took too long and was stopped.",
    LANE_OVERLOADED: "Hệ thống đang xử lý nhiều tác vụ nặng, vui lòng thử lại sau vài giây.",
    AMBIGUOUS_COMMAND: "The command name is ambiguous.",
    OUT_OF_SCHEDULE: "Lệnh này chỉ hoạt động trong khung giờ được cấu hình.",
    THREAD_NOT_WHITELISTED: "Lệnh này không được phép dùng trong hội thoại này.",
    THREAD_BLOCKED: "Lệnh này đã bị chặn trong hội thoại này.",
    USER_NOT_ALLOWED: "Bạn không có quyền dùng lệnh này.",
    MAX_USES_PER_HOUR: "Bạn đã đạt giới hạn số lần dùng lệnh trong giờ này.",
  };
  const detail = result.code === "MISSING_DEPENDENCY" ? formatMissingDependencyMessage(result) : "";
  const baseMessage = result.code === "PERMISSION_DENIED"
    ? formatPermissionDenied(result.requiredRole)
    : messages[result.code] || "The command could not be executed.";
  await api.sendMessage(
    { msg: `${baseMessage}${detail ? ` Missing: ${detail}.` : (result.code !== "PERMISSION_DENIED" && result.command ? ` Command: ${result.command}.` : "")}` },
    message.threadId,
    message.type
  );
}

export async function handleCommandPrivate(api, message, authorization = null) {
  try {
    const threadId = message.threadId;
    const senderId = message.data.uidFrom;
    const rawContent = message.data?.content;
    if (typeof rawContent !== "string") return 1;
    const content = removeMention(message) || rawContent.trim();
    const prefix = getGlobalPrefix();
    const authorizationSnapshot = authorization || resolveInstanceAuthorization({
      senderId,
      threadId: "",
      instanceUid: getBotId(),
      instanceKind: getInstanceKind(),
    });
    const isAdminLevelHighest = authorizationSnapshot.isAdminLevelHigh;
    const webConfig = readWebConfig();
    const privateEnabled = webConfig.privateEnabled !== false;

    if (typeof content === "string") {
      const lowerContent = content.toLowerCase();
      const lowerPrefix = prefix.toLowerCase();
      const isBarePrefix = lowerContent === "prefix";
      const isPrefixedPrefix = lowerContent === `${lowerPrefix}prefix` || lowerContent.startsWith(`${lowerPrefix}prefix `);

      if (isBarePrefix || isPrefixedPrefix) {
        await sendReactionConfirmReceive(api, message, 3);
        const handled = await handlePrefixCommand(
          api,
          message,
          isAdminLevelHighest
        );
        if (handled) return 3;
      }

      const parsedCommand = parseCommandContent(content, prefix);
      if (!parsedCommand) {
        return 1;
      }

      const commandConfig = getCommandConfig()?.commands || [];
      let { command, commandParts } = parsedCommand;
      const inputCommand = command;
      let registryMatch = resolveCommand(commandParts, commandRegistry);
      let runtimeCmd = null;
      if (registryMatch.code === "RESOLVED") {
        command = registryMatch.definition.name;
      } else {
        runtimeCmd = getCommand(inputCommand, commandConfig);
        if (runtimeCmd) {
          command = runtimeCmd.name;
          const runtimeDef = findRegistryDefinition(runtimeCmd.name);
          if (runtimeDef) {
            registryMatch = {
              code: "RESOLVED",
              definition: runtimeDef,
              args: commandParts.slice(1),
              matchedParts: [inputCommand],
              commandParts,
              isRuntimeAlias: true,
            };
          }
        }
      }

      const customResolved = resolveCommandPartsToCustom(registryMatch, commandParts, getProjectRoot());
      if (customResolved) {
        await sendReactionConfirmReceive(api, message, 3);
        const cooldown = checkCustomCommandCooldown({
          userId: senderId,
          threadId,
          commandName: customResolved.custom.name,
        });
        if (!cooldown.allowed) {
          await sendReactionWaitingCountdown(api, message, cooldown.remainingSeconds, customResolved.custom.name);
          return 1;
        }
        await invokeCustomCommand(api, message, customResolved.custom, { root: getProjectRoot() });
        return 1;
      }

      const isMainAdmin = authorizationSnapshot.isMainBotAdmin;
      const isCallerAdmin = authorizationSnapshot.isBotAdmin;

      if (registryMatch.code !== "RESOLVED" && !runtimeCmd) {
        if (
          !privateEnabled &&
          !managerData.data.onBotPrivate &&
          !isCallerAdmin &&
          !isAdminLevelHighest
        ) {
          await sendMessageInsufficientAuthority(
            api,
            message,
            "Tương tác lệnh trong tin nhắn riêng tư đã bị tắt!"
          );
          return 0;
        }
        await checkNotFindCommand(api, message, inputCommand, commandConfig);
        return 0;
      }

      const isMyBotAdminBypass = isMyBotAdminCooldownBypass({
        command,
        isAdminLevelHighest,
        isMainBotAdmin: authorizationSnapshot?.isMainBotAdmin,
      });
      if (
        !isMyBotAdminBypass &&
        !(await checkCommandCountdown(
          api,
          message,
          senderId,
          command
        ))
      ) {
        return;
      }

      let userPermissionLevel = authorizationSnapshot.role === "member" ? "all" : authorizationSnapshot.role;
      if (isAdminLevelHighest || isMainAdmin) userPermissionLevel = "adminLevelHigh";
      if (isHighRiskCommand(command) && isMainAdmin) {
        userPermissionLevel = "adminLevelHigh";
      }
      if (!(await checkPermission(api, message, command, userPermissionLevel, true, {
        aliasCommand: registryMatch.code === "RESOLVED" ? registryMatch.matchedParts.join(" ") : inputCommand,
        args: registryMatch.code === "RESOLVED" ? registryMatch.args : commandParts.slice(1),
        scope: "private",
      }))) {
        logAuthorizationDecision({
          instanceKind: authorizationSnapshot.instanceKind,
          instanceUid: authorizationSnapshot.instanceUid,
          senderId,
          threadId,
          scope: "private",
          role: authorizationSnapshot.role,
          source: authorizationSnapshot.source,
          command,
          verdict: "denied",
          detail: "permission",
        });
        return;
      }

      logAuthorizationDecision({
        instanceKind: authorizationSnapshot.instanceKind,
        instanceUid: authorizationSnapshot.instanceUid,
        senderId,
        threadId,
        scope: "private",
        role: authorizationSnapshot.role,
        source: authorizationSnapshot.source,
        command,
        verdict: "allowed",
      });
      const aliasCommand = registryMatch.code === "RESOLVED"
        ? registryMatch.matchedParts.join(" ")
        : inputCommand;
      const commandInfo = getCommand(command, commandConfig);
      const numHandleCommand = commandInfo?.type || (registryMatch.code === "RESOLVED" ? registryMatch.definition.type : 99);
      const commandPolicy = getRuntimeCommandPolicy(commandInfo || { name: command });
      if (!scopeAllows(commandPolicy.effectiveScope, "private")) {
        await sendPhase1Result(api, message, { code: "SCOPE_DENIED", command: commandInfo?.name || command });
        return numHandleCommand;
      }
      const behaviorProfile = mergeStudioBehavior(
        getBehaviorForCommand(commandPolicy),
        studioOverlayFor(commandInfo?.name || command, threadId),
      );
      const gateVerdict = evaluateBehaviorGate({
        behavior: behaviorProfile,
        threadId,
        senderId,
      });
      if (gateVerdict.code !== "OK") {
        const customGate = renderBehaviorMessage(behaviorProfile, gateVerdict.code, buildTemplateVars({
          user: senderId, userId: senderId, thread: threadId, command, prefix,
          behavior: behaviorProfile,
        }));
        if (customGate) await api.sendMessage({ msg: customGate }, threadId, message.type);
        else await sendPhase1Result(api, message, { code: gateVerdict.code, command });
        return numHandleCommand;
      }

      const activeCommand = commandInfo ? commandInfo.active : true;
      if (!isCallerAdmin && !isAdminLevelHighest && aliasCommand !== "" && !activeCommand) {
        await sendPhase1Result(api, message, { code: "COMMAND_DISABLED", command: commandInfo?.name || command });
        return numHandleCommand;
      }

      if (
        numHandleCommand === 1 &&
        !privateEnabled &&
        !managerData.data.onBotPrivate &&
        !isCallerAdmin &&
        !isAdminLevelHighest
      ) {
        await sendMessageInsufficientAuthority(
          api,
          message,
          "Tương tác lệnh trong tin nhắn riêng tư đã bị tắt!"
        );
        return 0;
      }

      command = commandInfo?.name || command;
      message.commandName = command;
      message.aliasCommand = aliasCommand;

      const shouldSendReaction = [1, 2, 3].includes(numHandleCommand) && (
        isCallerAdmin ||
        privateEnabled ||
        managerData.data.onBotPrivate
      );
      if (shouldSendReaction) {
        await sendReactionConfirmReceive(api, message, numHandleCommand);
      }

      const lifecycle = getActiveRuntimeLifecycle();
      const dispatchRegistry = registryMatch.isRuntimeAlias
        ? buildRuntimeAliasRegistry(inputCommand, registryMatch.definition)
        : commandRegistry;
      const registeredResult = registryMatch.code === "RESOLVED"
        ? await dispatchCommand({
          api,
          message,
          commandParts,
          aliasCommand,
          scope: "private",
          scopeOverride: commandPolicy.effectiveScope,
          permissionLevel: userPermissionLevel,
          config: process.env,
          dbReady: isDatabaseReady(),
          dependencies: getRuntimeDependencyState({ api }),
          isAdminLevelHighest,
          isMainBotAdmin: isMainAdmin,
          instanceKind: authorizationSnapshot.instanceKind,
          authorizationSnapshot,
          commandConfig: commandConfigForContext(command, threadId),
          workloadBroker: lifecycle?.workloadBroker || null,
        }, dispatchRegistry)
        : null;
      if (registeredResult) {
        await sendPhase1Result(api, message, registeredResult);
        return numHandleCommand;
      }

      if (numHandleCommand === 99) {
        await checkNotFindCommand(api, message, command, commandConfig);
      } else {
        await sendMessageInsufficientAuthority(
          api,
          message,
          "Lệnh chỉ áp dụng đối với nhóm hoặc cộng đồng!"
        );
      }
      return 0;
    }

    return 1;
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh private:", error);
    await sendCommandError(api, message, error);
    return 1;
  }
}

export async function handleCommand(
  api,
  message,
  groupInfo,
  groupAdmins,
  groupSettings,
  isAdminLevelHighest,
  callerIsBotAdmin,
  callerIsAdminBox,
  handleChat,
  authorization = null
) {
  const threadId = message.threadId;
  const senderId = message.data.uidFrom;
  const content = removeMention(message);
  const prefix = getGlobalPrefix();
  let numHandleCommand = -1;

  try {
    if (typeof content !== "string") {
      return numHandleCommand;
    }

    const authorizationSnapshot = authorization || resolveInstanceAuthorization({
      senderId,
      threadId,
      instanceUid: getBotId(),
      instanceKind: getInstanceKind(),
      groupSettings,
    });
    isAdminLevelHighest = authorizationSnapshot.isAdminLevelHigh;
    callerIsBotAdmin = authorizationSnapshot.isBotAdmin;
    callerIsAdminBox = authorizationSnapshot.isGroupAdmin;

    const parsedCommand = parseCommandContent(content, prefix);
    if (!parsedCommand) {
      return numHandleCommand;
    }

    let { command, commandParts } = parsedCommand;
    const inputCommand = command;
    const commandConfig = getCommandConfig()?.commands || [];
    let registryMatch = resolveCommand(commandParts, commandRegistry);
    let runtimeCmd = null;
    if (registryMatch.code === "RESOLVED") {
      command = registryMatch.definition.name;
    } else {
      runtimeCmd = getCommand(inputCommand, commandConfig);
      if (runtimeCmd) {
        command = runtimeCmd.name;
        const runtimeDef = findRegistryDefinition(runtimeCmd.name);
        if (runtimeDef) {
          registryMatch = {
            code: "RESOLVED",
            definition: runtimeDef,
            args: commandParts.slice(1),
            matchedParts: [inputCommand],
            commandParts,
            isRuntimeAlias: true,
          };
        }
      }
    }

    if (!handleChat) return;
    numHandleCommand = 99;

    const isGroupActiveBot = groupSettings[threadId]?.activeBot === true;
    if (!canInteractWithGroup({
      activeBot: isGroupActiveBot,
      isAdminBot: callerIsBotAdmin,
      isAdminBox: callerIsAdminBox,
      commandParts: [command, ...commandParts.slice(1)],
    })) {
      return numHandleCommand;
    }

    const customResolved = resolveCommandPartsToCustom(registryMatch, commandParts, getProjectRoot());
    if (customResolved) {
      await sendReactionConfirmReceive(api, message, 3);
      const cooldown = checkCustomCommandCooldown({
        userId: senderId,
        threadId,
        commandName: customResolved.custom.name,
      });
      if (!cooldown.allowed) {
        await sendReactionWaitingCountdown(api, message, cooldown.remainingSeconds, customResolved.custom.name);
        return numHandleCommand;
      }
      await invokeCustomCommand(api, message, customResolved.custom, { root: getProjectRoot() });
      return numHandleCommand;
    }

    if (registryMatch.code !== "RESOLVED" && !runtimeCmd) {
      if (isGroupActiveBot || callerIsBotAdmin) {
        await checkNotFindCommand(api, message, inputCommand, commandConfig);
      }
      return numHandleCommand;
    }

    const isMyBotAdminBypass = isMyBotAdminCooldownBypass({
      command,
      isAdminLevelHighest,
      isMainBotAdmin: authorizationSnapshot?.isMainBotAdmin,
    });
    if (
      !isMyBotAdminBypass &&
      !(await checkCommandCountdown(
        api,
        message,
        senderId,
        command
      ))
    ) {
      return numHandleCommand;
    }

    const isMainAdmin = authorizationSnapshot.isMainBotAdmin;
    const isCallerAdmin = callerIsBotAdmin;

    let userPermissionLevel = authorizationSnapshot.role === "member" ? "all" : authorizationSnapshot.role;
    if (isAdminLevelHighest || isMainAdmin) userPermissionLevel = "adminLevelHigh";
    if (isHighRiskCommand(command) && isMainAdmin) {
      userPermissionLevel = "adminLevelHigh";
    }

    if (
      !(await checkPermission(
        api,
        message,
        command,
        userPermissionLevel,
        isGroupActiveBot || isCallerAdmin,
        {
          aliasCommand: registryMatch.code === "RESOLVED" ? registryMatch.matchedParts.join(" ") : inputCommand,
          args: registryMatch.code === "RESOLVED" ? registryMatch.args : commandParts.slice(1),
          scope: "group",
        }
      ))
    ) {
      logAuthorizationDecision({
        instanceKind: authorizationSnapshot.instanceKind,
        instanceUid: authorizationSnapshot.instanceUid,
        senderId,
        threadId,
        scope: "group",
        role: authorizationSnapshot.role,
        source: authorizationSnapshot.source,
        command,
        verdict: "denied",
        detail: "permission",
      });
      return numHandleCommand;
    }

    logAuthorizationDecision({
      instanceKind: authorizationSnapshot.instanceKind,
      instanceUid: authorizationSnapshot.instanceUid,
      senderId,
      threadId,
      scope: "group",
      role: authorizationSnapshot.role,
      source: authorizationSnapshot.source,
      command,
      verdict: "allowed",
    });
    const aliasCommand = registryMatch.code === "RESOLVED"
      ? registryMatch.matchedParts.join(" ")
      : inputCommand;
    const commandInfo = getCommand(command, commandConfig);
    const commandPolicy = getRuntimeCommandPolicy(commandInfo || { name: command });
    if (!scopeAllows(commandPolicy.effectiveScope, "group")) {
      await sendPhase1Result(api, message, { code: "SCOPE_DENIED", command: commandInfo?.name || command });
      return numHandleCommand;
    }
    const behaviorProfile = mergeStudioBehavior(
      getBehaviorForCommand(commandPolicy),
      studioOverlayFor(commandInfo?.name || command, threadId),
    );
    const gateVerdict = evaluateBehaviorGate({
      behavior: behaviorProfile,
      threadId,
      senderId,
    });
    if (gateVerdict.code !== "OK") {
      const customGate = renderBehaviorMessage(behaviorProfile, gateVerdict.code, buildTemplateVars({
        user: senderId, userId: senderId, thread: threadId, command, prefix,
        behavior: behaviorProfile,
      }));
      if (customGate) await api.sendMessage({ msg: customGate }, threadId, message.type);
      else await sendPhase1Result(api, message, { code: gateVerdict.code, command });
      return numHandleCommand;
    }
    const activeCommand = commandInfo ? commandInfo.active : true;
    if (!isCallerAdmin && aliasCommand !== "" && !activeCommand) {
      return numHandleCommand;
    }
    numHandleCommand = commandInfo?.type || (registryMatch.code === "RESOLVED" ? registryMatch.definition.type : 99);
    command = commandInfo?.name || command;
    message.commandName = command;
    message.aliasCommand = aliasCommand;

    const shouldSendReaction = [1, 2, 3].includes(numHandleCommand) && (
      isCallerAdmin ||
      groupSettings[threadId]?.activeBot === true
    );
    if (shouldSendReaction) {
      await sendReactionConfirmReceive(api, message, numHandleCommand);
    }

    const lifecycle = getActiveRuntimeLifecycle();
    const dispatchRegistry = registryMatch.isRuntimeAlias
      ? buildRuntimeAliasRegistry(inputCommand, registryMatch.definition)
      : commandRegistry;
    const registeredResult = registryMatch.code === "RESOLVED"
      ? await dispatchCommand({
        api,
        message,
        commandParts,
        aliasCommand,
        scope: "group",
        scopeOverride: commandPolicy.effectiveScope,
        permissionLevel: userPermissionLevel,
        config: process.env,
        dbReady: isDatabaseReady(),
        dependencies: getRuntimeDependencyState({ api }),
        groupInfo,
        groupAdmins,
        groupSettings,
        isAdminLevelHighest,
        callerIsBotAdmin,
        callerIsAdminBox,
        isMainBotAdmin: isMainAdmin,
        instanceKind: authorizationSnapshot.instanceKind,
        authorizationSnapshot,
        commandConfig: commandConfigForContext(command, threadId),
        workloadBroker: lifecycle?.workloadBroker || null,
      }, dispatchRegistry)
      : null;
    if (registeredResult) {
      if (shouldPersistGroupSettings(commandParts, registeredResult)) {
        writeGroupSettings(groupSettings);
      }
      await sendPhase1Result(api, message, registeredResult);
      return numHandleCommand;
    }

    if (
      numHandleCommand === 99 &&
      (groupSettings[threadId]?.activeBot === true || callerIsBotAdmin)
    ) {
      await checkNotFindCommand(api, message, command, commandConfig);
    }

    return numHandleCommand;
  } catch (error) {
    console.error("Lỗi khi xử lý lệnh nhóm:", error);
    await sendCommandError(api, message, error);
    return numHandleCommand;
  }
}
