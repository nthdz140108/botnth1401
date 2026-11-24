import { MessageType } from "../../api-zalo/models/index.js";

const COMMAND_GROUPS = Object.freeze({
  friends: Object.freeze(["mybot", "name", "info", "card", "addfriend", "undofriend", "rejectfriend", "listfriend", "waitinglist"]),
  group: Object.freeze(["group", "kick", "block", "join", "leave"]),
  media: Object.freeze(["image", "video", "gif", "voice", "sticker", "download"]),
  utility: Object.freeze(["google", "thoitiet", "ff", "qrbank", "getlink", "getvoice", "checkip", "checkdomain", "cpus"]),
  antiService: Object.freeze(["kickimg", "blockimg", "target", "antigif"]),
  highRisk: Object.freeze(["kickallmember", "blockallmember", "leaveallbox", "leavelock", "dispersegroup", "key", "addfriendall"]),
});

const COMMAND_INDEX = buildCommandIndex(COMMAND_GROUPS);

const API_METHOD_ALIASES = Object.freeze({
  sendMessageToThread: "sendMessage",
  sendGroupMessage: "sendMessage",
  sendPrivateMessage: "sendMessage",
  replyMessage: "sendMessage",
  removeMembers: "removeUserFromGroup",
  blockMembers: "blockUsers",
});

export const NQDUAN_COMMAND_GROUPS = Object.freeze(COMMAND_GROUPS);

export function classifyNqduanCommand(commandName = "") {
  const normalizedName = normalizeKey(commandName);
  const group = COMMAND_INDEX.get(normalizedName) || "utility";
  const risk = group === "highRisk" || group === "antiService" ? "critical" : "normal";
  return {
    name: normalizedName,
    group,
    risk,
    commandGroups: NQDUAN_COMMAND_GROUPS,
  };
}

export function normalizeNqduanMessage(message = {}) {
  const base = message && typeof message === "object" ? { ...message } : {};
  const data = base.data && typeof base.data === "object" ? { ...base.data } : {};
  const content = coerceMessageContent(data.content ?? base.content ?? "");
  const mentions = normalizeMentions(data.mentions ?? base.mentions);
  const threadId = normalizeId(base.threadId ?? base.thread?.id ?? data.threadId);
  const senderId = normalizeId(data.uidFrom ?? base.senderId ?? base.userId ?? base.sender?.id);
  const senderName = String(data.dName ?? base.senderName ?? base.dName ?? base.sender?.name ?? "").trim();
  const quote = data.quote ?? base.quote ?? null;
  const type = normalizeMessageType(base.type ?? base.chatType ?? data.type ?? "group");

  return {
    ...base,
    threadId,
    type,
    data: {
      ...data,
      uidFrom: senderId,
      dName: senderName,
      content,
      mentions,
      quote,
    },
  };
}

export function createNqduanApiAdapter(api = {}, context = {}) {
  const target = api && typeof api === "object" ? api : {};
  return new Proxy(target, {
    get(source, prop, receiver) {
      if (typeof prop !== "string") {
        return Reflect.get(source, prop, receiver);
      }

      if (prop === "sendMessageToThread") {
        return (...args) => invokeMethod(target, "sendMessage", args, context);
      }

      const alias = API_METHOD_ALIASES[prop];
      if (alias) {
        return (...args) => invokeMethod(target, alias, args, context, prop);
      }

      const value = Reflect.get(source, prop, receiver);
      if (typeof value === "function") {
        return (...args) => invokeMethod(target, prop, args, context);
      }

      if (value !== undefined) {
        return value;
      }

      return (...args) => {
        throw createNqduanBridgeError("NQDUAN_API_METHOD_MISSING", `Missing Nqduan API method: ${prop}`, {
          method: prop,
          commandName: context.commandName || null,
          commandGroup: context.commandGroup || null,
          args,
        });
      };
    },
  });
}

export function createNqduanDependencyAdapter(dependencies = {}, context = {}) {
  const normalized = {
    database: normalizeDependencyEntry(dependencies.database, "database"),
    ffmpeg: normalizeDependencyEntry(dependencies.ffmpeg, "ffmpeg"),
    python: normalizeDependencyEntry(dependencies.python, "python"),
    apiKey: normalizeApiKeyEntry(dependencies.apiKeys),
  };

  return {
    summary() {
      return Object.entries(normalized).map(([name, entry]) => ({
        name,
        available: entry.available,
        reason: entry.reason,
        details: entry.details,
        commandName: context.commandName || null,
        commandGroup: context.commandGroup || null,
      }));
    },
    describe(name) {
      const entry = normalized[normalizeKey(name)];
      if (!entry) {
        return {
          name: normalizeKey(name),
          available: false,
          reason: "unknown dependency",
          commandName: context.commandName || null,
          commandGroup: context.commandGroup || null,
        };
      }
      return {
        name: normalizeKey(name),
        available: entry.available,
        reason: entry.reason,
        details: entry.details,
        commandName: context.commandName || null,
        commandGroup: context.commandGroup || null,
      };
    },
    ensure(name, extra = {}) {
      const entry = this.describe(name);
      if (entry.available) {
        return entry.details;
      }
      throw createNqduanBridgeError("NQDUAN_DEPENDENCY_MISSING", `Missing Nqduan dependency: ${entry.name}`, {
        dependency: entry.name,
        commandName: extra.commandName || context.commandName || null,
        commandGroup: extra.commandGroup || context.commandGroup || null,
        reason: entry.reason,
        details: entry.details,
      });
    },
  };
}

export function createNqduanBridgeRuntime(input = {}) {
  const command = classifyNqduanCommand(input.commandName || input.aliasCommand || input.message?.data?.content || "");
  const message = normalizeNqduanMessage(input.message || {});
  const api = createNqduanApiAdapter(input.api || {}, {
    commandName: command.name,
    commandGroup: command.group,
  });
  const dependencies = createNqduanDependencyAdapter(input.dependencies || {}, {
    commandName: command.name,
    commandGroup: command.group,
  });
  const permissions = resolvePermissionState({
    permissionLevel: input.permissionLevel,
    isAdminLevelHighest: input.isAdminLevelHighest,
    command,
  });

  return {
    command,
    api,
    message,
    groupSettings: input.groupSettings || {},
    groupInfo: input.groupInfo || {},
    groupAdmins: input.groupAdmins || [],
    args: normalizeArgs(input.args || message.data.content),
    permissions,
    dependencies,
    context: {
      scope: input.scope || "group",
      permissionLevel: input.permissionLevel || "all",
      isAdminLevelHighest: Boolean(input.isAdminLevelHighest),
      aliasCommand: input.aliasCommand || command.name,
    },
  };
}

export function createNqduanBridgeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  if (details.method) error.method = details.method;
  if (details.dependency) error.dependency = details.dependency;
  if (details.commandName) error.commandName = details.commandName;
  if (details.commandGroup) error.commandGroup = details.commandGroup;
  if (details.reason) error.reason = details.reason;
  if (details.details !== undefined) error.details = details.details;
  if (details.args !== undefined) error.args = details.args;
  return error;
}

export function normalizeNqduanError(error, context = {}) {
  if (error && error.code && String(error.code).startsWith("NQDUAN_")) {
    return attachContext(error, context);
  }
  return createNqduanBridgeError("NQDUAN_HANDLER_ERROR", error instanceof Error ? error.message : String(error), {
    commandName: context.commandName || null,
    commandGroup: context.commandGroup || null,
    details: error,
  });
}

async function invokeMethod(target, methodName, args, context, aliasName = null) {
  const method = target?.[methodName];
  if (typeof method !== "function") {
    throw createNqduanBridgeError("NQDUAN_API_METHOD_MISSING", `Missing Nqduan API method: ${aliasName || methodName}`, {
      method: aliasName || methodName,
      commandName: context.commandName || null,
      commandGroup: context.commandGroup || null,
      args,
    });
  }

  try {
    return await Promise.resolve(method.apply(target, args));
  } catch (error) {
    throw normalizeNqduanError(error, context);
  }
}

function normalizeArgs(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeDependencyEntry(entry, name) {
  if (entry === false || entry == null) {
    return { available: false, reason: `${name} unavailable`, details: null };
  }
  if (entry === true) {
    return { available: true, reason: null, details: { available: true } };
  }
  if (typeof entry === "string") {
    return { available: true, reason: null, details: { executable: entry } };
  }
  if (typeof entry === "object") {
    return {
      available: entry.available !== false,
      reason: entry.reason ?? (entry.available === false ? `${name} unavailable` : null),
      details: entry,
    };
  }
  return { available: Boolean(entry), reason: Boolean(entry) ? null : `${name} unavailable`, details: { value: entry } };
}

function normalizeApiKeyEntry(apiKeys) {
  const available = Boolean(apiKeys && typeof apiKeys === "object" && Object.values(apiKeys).some((value) => String(value ?? "").trim()));
  return {
    available,
    reason: available ? null : "missing API key",
    details: apiKeys && typeof apiKeys === "object" ? { ...apiKeys } : {},
  };
}

function normalizeMentions(mentions) {
  if (!Array.isArray(mentions)) return [];
  return mentions
    .map((mention) => ({
      ...mention,
      uid: normalizeId(mention?.uid),
      pos: Number.isFinite(mention?.pos) ? mention.pos : Number.parseInt(mention?.pos, 10) || 0,
      len: Number.isFinite(mention?.len) ? mention.len : Number.parseInt(mention?.len, 10) || 0,
      name: String(mention?.name ?? "").trim(),
    }))
    .filter((mention) => mention.uid);
}

function coerceMessageContent(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.title === "string") return value.title;
  return String(value ?? "");
}

function resolvePermissionState({ permissionLevel, isAdminLevelHighest, command }) {
  const level = permissionLevel || (isAdminLevelHighest ? "adminLevelHigh" : "all");
  const allowed = Boolean(isAdminLevelHighest || level === "adminLevelHigh");
  return {
    level,
    allowed,
    required: command.group === "highRisk" ? "adminLevelHigh" : "all",
    commandGroup: command.group,
  };
}

function attachContext(error, context) {
  if (context.commandName && !error.commandName) error.commandName = context.commandName;
  if (context.commandGroup && !error.commandGroup) error.commandGroup = context.commandGroup;
  return error;
}

function buildCommandIndex(groups) {
  const index = new Map();
  for (const [group, commands] of Object.entries(groups)) {
    for (const command of commands) {
      index.set(normalizeKey(command), group);
    }
  }
  return index;
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function normalizeId(value) {
  return String(value ?? "").trim();
}

function normalizeMessageType(value) {
  if (value === MessageType.DirectMessage || value === 0) {
    return MessageType.DirectMessage;
  }
  if (value === MessageType.GroupMessage || value === 1) {
    return MessageType.GroupMessage;
  }
  const normalized = normalizeKey(value);
  if (normalized === "private" || normalized === "privatemessage" || normalized === "direct" || normalized === "directmessage") {
    return MessageType.DirectMessage;
  }
  return MessageType.GroupMessage;
}
