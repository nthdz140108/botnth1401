import { isMainBotAdmin } from "../utils/io-json.js";

export const HIGH_RISK_COMMANDS = new Set([
  "spamjoin",
  "spamgroup",
  "addfriendall",
  "kickall",
  "blockall",
  "leave",
  "kickallmember",
  "blockallmember",
  "leaveallbox",
  "leavelock",
  "dispersegroup",
  "kickimg",
  "blockimg",
  "target",
  "key",
  "locmem",
]);

export const HIGH_RISK_CATEGORIES = Object.freeze({
  spamjoin: "vip.highRisk",
  spamgroup: "vip.highRisk",
  addfriendall: "vip.highRisk",
  kickall: "vip.highRisk",
  blockall: "vip.highRisk",
  leave: "vip.highRisk",
  kickallmember: "vip.highRisk",
  blockallmember: "vip.highRisk",
  leaveallbox: "vip.highRisk",
  leavelock: "vip.highRisk",
  dispersegroup: "vip.highRisk",
  kickimg: "vip.highRisk",
  blockimg: "vip.highRisk",
  target: "vip.highRisk",
  key: "vip.highRisk",
  locmem: "vip.highRisk",
});

export function isHighRiskCommand(command) {
  return HIGH_RISK_COMMANDS.has(normalizeCommandName(command?.name || command));
}

export function resolveHighRiskPolicy(command, context = {}) {
  const name = normalizeCommandName(command?.name || command);
  const isHighRisk = isHighRiskCommand(name) || command?.risk === "critical" || command?.risk === "high";
  const actorId = normalizeString(context.senderId || context.userId || context.uid);
  const killSwitch = Boolean(context.killSwitch);
  const isMainAdmin = context.isMainBotAdmin !== undefined
    ? Boolean(context.isMainBotAdmin)
    : (actorId ? isMainBotAdmin(actorId) : false);
  const isTopLevelAdmin = isMainAdmin
    || context.isAdminLevelHighest === true
    || normalizeString(context.permissionLevel) === "adminlevelhigh";

  if (!isHighRisk) {
    return { allowed: true, reason: null, riskLevel: command?.risk || "normal" };
  }

  if (killSwitch) {
    return deny("KILL_SWITCH_ACTIVE", "High-risk commands are disabled by dashboard kill switch.", { riskLevel: command?.risk || "critical" });
  }

  if (!isTopLevelAdmin) {
    return deny("PERMISSION_DENIED", "High-risk commands require main bot admin permission.", { riskLevel: command?.risk || "critical" });
  }

  return { allowed: true, reason: null, riskLevel: command?.risk || "critical" };
}

function deny(code, message, extra = {}) {
  return { allowed: false, code, message, ...extra };
}

function normalizeAllowlist(value) {
  const entries = Array.isArray(value) ? value : [];
  return new Set(entries.map(normalizeString).filter(Boolean));
}

function normalizeCommandName(value) {
  return normalizeString(value).split(/\s+/).filter(Boolean).join(" ");
}

function normalizeString(value) {
  return String(value ?? "").trim().toLowerCase();
}

