import { readGroupSettings, readMainBotAdmins, readHighCommandAdmins, readAdmins } from "./io-json.js";

export const ROLE_LEVELS = Object.freeze({
  member: 0,
  adminBox: 1,
  adminBot: 2,
  adminLevelHigh: 3,
});

const ROLE_NAMES = Object.keys(ROLE_LEVELS);
const ROLE_ALIASES = Object.freeze({ all: "member", adminBotOrGroup: "adminBox" });

export const ROLE_LABELS = Object.freeze({
  member: "Tất cả người dùng",
  adminBox: "Quản trị viên nhóm",
  adminBot: "Quản trị viên bot",
  adminLevelHigh: "Quản trị viên cấp cao",
});

const ROLE_LABEL_ALIASES = Object.freeze({ all: "member", adminBotOrGroup: "adminBox" });

export function getRoleLabel(role) {
  const normalized = ROLE_LABEL_ALIASES[role] ?? role;
  return ROLE_LABELS[normalized] ?? ROLE_LABELS.member;
}

export function formatPermissionDenied(requiredRole) {
  const label = getRoleLabel(requiredRole);
  return (
    "Bạn không có đủ quyền hạn để sử dụng lệnh này.\n" +
    `Yêu cầu quyền hạn tối thiểu: ${label}`
  );
}

function uidOf(value) {
  if (value && typeof value === "object") {
    return String(value.uid ?? value.userId ?? value.id ?? "").trim();
  }
  return String(value ?? "").trim();
}

function includesUid(values, uid) {
  if (!Array.isArray(values)) return false;
  return values.some((value) => uidOf(value) === uid);
}

function groupAdminIds(context = {}) {
  const threadId = String(context.threadId ?? "").trim();
  const settings = context.groupSettings?.[threadId]?.adminList;
  const configured = settings && typeof settings === "object" ? Object.keys(settings) : [];
  const native = context.includeNativeGroupAdmins && Array.isArray(context.groupAdmins)
    ? context.groupAdmins.map(uidOf)
    : [];
  return new Set([...configured, ...native].filter(Boolean));
}

export function resolveUserRole(userId, context = {}) {
  const uid = uidOf(userId);
  if (!uid) return "member";
  if (uid === uidOf(context.botUid)) return "adminLevelHigh";
  if (includesUid(context.mainAdmins, uid)) return "adminLevelHigh";
  if (includesUid(context.highCommandAdmins, uid)) return "adminLevelHigh";
  if (includesUid(context.botAdmins, uid)) return "adminBot";
  if (groupAdminIds(context).has(uid)) return "adminBox";
  return "member";
}

export function hasMinimumRole(userId, minimumRole, context = {}) {
  const normalizedMin = typeof minimumRole === "string" ? normalizeRole(minimumRole) : null;
  const required = typeof minimumRole === "number" ? minimumRole : ROLE_LEVELS[normalizedMin] ?? 0;
  return ROLE_LEVELS[resolveUserRole(userId, context)] >= required;
}

export function canManageTarget(callerRole, targetRole, { targetIsBot = false } = {}) {
  if (targetIsBot) return false;
  const normalizedCaller = typeof callerRole === "string" ? normalizeRole(callerRole) : null;
  const normalizedTarget = typeof targetRole === "string" ? normalizeRole(targetRole) : null;
  const callerLevel = typeof callerRole === "number" ? callerRole : ROLE_LEVELS[normalizedCaller] ?? 0;
  const targetLevel = typeof targetRole === "number" ? targetRole : ROLE_LEVELS[normalizedTarget] ?? 0;
  return callerLevel > targetLevel;
}

export function filterManageableTargets(callerRole, targetIds, context = {}) {
  const manageable = [];
  const skipped = [];
  const callerLevel = typeof callerRole === "number"
    ? callerRole
    : ROLE_LEVELS[normalizeRole(callerRole)] ?? 0;
  for (const rawId of Array.isArray(targetIds) ? targetIds : []) {
    const uid = uidOf(rawId);
    const targetIsBot = uid && uid === uidOf(context.botUid);
    const targetRole = resolveUserRole(uid, context);
    if (targetIsBot) {
      skipped.push({ uid, reason: "bot" });
    } else if (targetRole === "member" && !context.allowUnknownTargets) {
      skipped.push({ uid, reason: "not-found" });
    } else if (!canManageTarget(callerLevel, targetRole)) {
      skipped.push({ uid, reason: ROLE_LEVELS[targetRole] === callerLevel ? "same-level" : "higher-level" });
    } else {
      manageable.push(uid);
    }
  }
  return { manageable, skipped };
}

export function normalizeRole(role) {
  const normalized = ROLE_ALIASES[role] ?? role;
  return ROLE_NAMES.includes(normalized) ? normalized : "member";
}

export function isAdmin(userId, threadId, groupAdmins) {
  if (!userId) return false;
  const idStr = String(userId).trim();
  if (!idStr) return false;

  const groupSettings = readGroupSettings();
  const role = resolveUserRole(idStr, {
    threadId,
    mainAdmins: readMainBotAdmins(),
    highCommandAdmins: readHighCommandAdmins(),
    botAdmins: readAdmins(),
    groupSettings,
    groupAdmins,
    includeNativeGroupAdmins: Array.isArray(groupAdmins),
  });
  return ROLE_LEVELS[role] >= ROLE_LEVELS.adminBox;
}
