import fs from "fs";
import path from "path";
import { getProjectRoot } from "./env.js";
import { readMainBotAdmins } from "./io-json.js";
import { resolveManagedBotTargetRecord } from "../commands/mybot/System/mybot-identity.js";
import { writeJsonAtomic } from "../commands/mybot/System/json-state.js";

export function getChildAdminListPath(childUid, projectRoot = getProjectRoot()) {
  const root = projectRoot || getProjectRoot();
  const canonicalPath = path.join(root, "mybot", "instances", String(childUid), "data", "admin-list.json");
  if (fs.existsSync(canonicalPath)) return canonicalPath;

  const legacyPath = path.join(root, "mybot", "configs", `list_admin-${childUid}.json`);
  if (fs.existsSync(legacyPath)) return legacyPath;

  return canonicalPath;
}

export function readChildAdminList(childUid, { projectRoot = getProjectRoot() } = {}) {
  const root = projectRoot || getProjectRoot();
  const filePath = getChildAdminListPath(childUid, root);
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
      if (Array.isArray(parsed)) {
        return parsed.map((id) => String(id).trim()).filter(Boolean);
      }
    }
  } catch {}
  return [];
}

export function writeChildAdminList(childUid, adminList, { projectRoot = getProjectRoot() } = {}) {
  const root = projectRoot || getProjectRoot();
  const canonicalPath = path.join(root, "mybot", "instances", String(childUid), "data", "admin-list.json");
  const unique = Array.from(new Set((adminList || []).map((id) => String(id).trim()).filter(Boolean)));
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  writeJsonAtomic(canonicalPath, unique);

  // Also sync to legacy path for backward compatibility
  const legacyPath = path.join(root, "mybot", "configs", `list_admin-${childUid}.json`);
  try {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    writeJsonAtomic(legacyPath, unique);
  } catch {}

  return unique;
}

export function addChildAdmin(childUid, targetUid, { projectRoot = getProjectRoot() } = {}) {
  const current = readChildAdminList(childUid, { projectRoot });
  const strTarget = String(targetUid).trim();
  if (!strTarget || current.includes(strTarget)) return current;
  current.push(strTarget);
  return writeChildAdminList(childUid, current, { projectRoot });
}

export function removeChildAdmin(childUid, targetUid, { projectRoot = getProjectRoot() } = {}) {
  const current = readChildAdminList(childUid, { projectRoot });
  const strTarget = String(targetUid).trim();
  const next = current.filter((id) => id !== strTarget);
  return writeChildAdminList(childUid, next, { projectRoot });
}

export function resolveChildAuthorization({
  childUid,
  actorUid,
  envelopeRole = null,
  capabilities = [],
  groupAdmins = [],
  projectRoot = getProjectRoot(),
} = {}) {
  const root = projectRoot || getProjectRoot();
  const strChildUid = String(childUid || "").trim();
  const strActorUid = String(actorUid || "").trim();

  const mainHighAdmins = readMainBotAdmins(root).map((id) => String(id).trim());
  const isMainHighAdmin = mainHighAdmins.includes(strActorUid);

  // Resolve bot target record to get verified ownerUid
  const botRecord = resolveManagedBotTargetRecord(strChildUid, { projectRoot: root });
  const ownerUid = botRecord?.ownerUid ? String(botRecord.ownerUid).trim() : null;
  const isOwner = Boolean(ownerUid && ownerUid === strActorUid);
  const isSelf = Boolean(strChildUid && strChildUid === strActorUid);

  const localAdmins = readChildAdminList(strChildUid, { projectRoot: root });
  const isLocalBotAdmin = localAdmins.includes(strActorUid);

  const isEnvelopeHigh = envelopeRole === "adminLevelHigh";
  const isEnvelopeBotAdmin = envelopeRole === "adminBot";
  const isEnvelopeBoxAdmin = envelopeRole === "adminBox";

  const isAdminLevelHigh = Boolean(isMainHighAdmin || isEnvelopeHigh);
  const isBotAdmin = Boolean(isAdminLevelHigh || isOwner || isSelf || isLocalBotAdmin || isEnvelopeBotAdmin);
  const isGroupAdmin = Boolean(isBotAdmin || isEnvelopeBoxAdmin || (Array.isArray(groupAdmins) && groupAdmins.includes(strActorUid)));

  let role = "user";
  if (isAdminLevelHigh) {
    role = "adminLevelHigh";
  } else if (isBotAdmin) {
    role = "adminBot";
  } else if (isGroupAdmin) {
    role = "adminBox";
  }

  return {
    childUid: strChildUid,
    actorUid: strActorUid,
    role,
    isAdminLevelHigh,
    isBotAdmin,
    isGroupAdmin,
    isMainBotAdmin: isMainHighAdmin,
    isOwner,
    isSelf,
    capabilities: Array.isArray(capabilities) ? capabilities : [],
  };
}
