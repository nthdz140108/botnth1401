import fs from "node:fs";
import path from "node:path";
import { getProfile, updateProfile, updateStyle, resetStyle } from "../commands/mybot/System/mybot-profile-service.js";
import { getOwnerTrialStatus, resetOwnerTrialForWeek, getTrialLedgerPath } from "../commands/mybot/System/mybot-trial-ledger.js";
import { withMyBotsTransaction } from "../commands/mybot/Manager/qr-provisioning-registry.js";
import { writeJsonAtomic } from "../commands/mybot/System/json-state.js";

function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, message, status, stage: "configuration" }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return fallback; throw error; } }

// The bridge uses the same profile and prefix implementations as Zalo commands.
export function createBotManagementService({ root, registry, prefixService, auditStore, verifyAdminUid }) {
  const registryPath = path.join(root, "mybot", "mybots.json");
  const options = { root, actor: "dashboard", auditStore };
  async function requireBot(id) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) fail("INVALID_BOT_ID", "Mã Bot không hợp lệ");
    const bot = await registry.describe(id);
    if (!bot) fail("BOT_NOT_FOUND", "Không tìm thấy Bot", 404);
    return bot;
  }
  async function mutate(id, action) {
    await requireBot(id);
    return withMyBotsTransaction({ root, registryPath }, async (txn) => {
      const current = txn.readRegistry();
      if (id !== "admin" && !current[id]) fail("BOT_NOT_FOUND", "Không tìm thấy Bot", 404);
      for (const file of ["profile.json", "database.json", "command.json", "web-config.json", "admin-list.json"]) {
        txn.trackFile?.(path.join(root, "mybot", "instances", id, "data", file));
      }
      if (id === "admin") txn.trackFile?.(path.join(root, "assets", "data", "list_admin.json"));
      const bot = await registry.describe(id);
      if (bot?.paths?.commandFilePath) txn.trackFile?.(path.resolve(root, bot.paths.commandFilePath));
      const result = await action(current[id] || {}, txn);
      return result;
    });
  }
  async function profile(id) { await requireBot(id); const p = getProfile(id, { root }); return { botId: id, ...p, displayName: p.nameServer, profile: p }; }
  async function saveProfile(id, body) {
    return mutate(id, async () => {
      const p = updateProfile(id, { ...body, ...(body.displayName !== undefined ? { nameServer: body.displayName } : {}) }, options).profile;
      return { botId: id, ...p, profile: p };
    });
  }
  async function style(id, body, reset = false) {
    return mutate(id, () => {
      const p = (reset ? resetStyle(id, options) : updateStyle(id, body.style || body, options)).profile;
      return { botId: id, style: p.style, profile: p };
    });
  }
  async function expiry(id, body) {
    return mutate(id, (record, txn) => {
      const preset = String(body.preset || body.expiryPreset || "").toLowerCase().replace(/^\+/, "");
      const durations = { "1h": 3600000, "1d": 86400000, "7d": 604800000, "30d": 2592000000 };
      const permanent = ["permanent", "never", "-1"].includes(preset) || body.expiryAt === "-1";
      const patch = {};
      if (body.ownerUid !== undefined) patch.ownerUid = String(body.ownerUid).trim();
      if (!record.activatedAt && !record.trialStartedAt && (permanent || durations[preset])) {
        patch.activationPolicy = permanent ? { type: "permanent" } : { type: "duration", durationMs: durations[preset] };
        patch.expiryAt = null;
      } else if (permanent) patch.expiryAt = "-1";
      else if (durations[preset]) patch.expiryAt = new Date(Math.max(Date.now(), Date.parse(record.expiryAt) || 0) + durations[preset]).toISOString();
      else if (body.expiryAt && Number.isFinite(Date.parse(body.expiryAt))) patch.expiryAt = new Date(body.expiryAt).toISOString();
      else fail("INVALID_EXPIRY_DATE", "Hạn dùng không hợp lệ");
      const p = updateProfile(id, patch, options).profile;
      // Preserve policy even when reading an older profile schema during rollout.
      const latest = readJson(registryPath, {});
      latest[id] = { ...latest[id], ...patch };
      if (txn.patchBot) txn.patchBot(id, patch);
      else writeJsonAtomic(registryPath, latest);
      return { botId: id, ...patch, profile: p };
    });
  }
  function adminFile(id) { return id === "admin" ? path.join(root, "assets", "data", "list_admin.json") : path.join(root, "mybot", "instances", id, "data", "admin-list.json"); }
  async function admins(id) { await requireBot(id); const uids = readJson(adminFile(id), []); return { botId: id, admins: uids.map((uid) => ({ uid: String(uid), adminUid: String(uid) })) }; }
  async function changeAdmin(id, body, removeUid) {
    return mutate(id, async (_, txn) => {
      const uid = String(removeUid || body.uid || body.adminUid || "").trim();
      if (!uid || !/^[a-zA-Z0-9_-]+$/.test(uid)) fail("INVALID_UID", "UID không hợp lệ");
      if (!removeUid && id !== "admin" && !(await verifyAdminUid?.(id, uid))) fail("CHILD_ADMIN_VERIFICATION_REQUIRED", "UID chưa được xác minh trong phiên Bot con. Hãy kết nối Bot và chọn UID từ danh sách bạn bè của Bot.");
      const file = adminFile(id);
      const existing = readJson(file, []).map(String);
      const next = removeUid ? existing.filter((entry) => entry !== uid) : [...new Set([...existing, uid])];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (txn.writeJson) txn.writeJson(file, next); else writeJsonAtomic(file, next);
      return { botId: id, admins: next, added: removeUid ? undefined : uid, removed: removeUid ? existing.includes(uid) : undefined };
    });
  }
  async function settings(id, body) {
    return mutate(id, async () => {
      if (body.prefix !== undefined) await prefixService.update(id, String(body.prefix).trim());
      const p = updateProfile(id, { ownerUid: body.ownerUid, nameServer: body.displayName }, options).profile;
      const file = path.join(root, "mybot", "instances", id, "data", "web-config.json");
      const current = readJson(file, {});
      for (const key of ["privateEnabled", "groupEnabled"]) if (body[key] !== undefined) current[key] = Boolean(body[key]);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeJsonAtomic(file, current);
      return { botId: id, profile: p, chatPolicy: current, restartRequired: true };
    });
  }
  return { profile, saveProfile, style, expiry, admins, changeAdmin, settings,
    prefix: async (id, body) => body ? mutate(id, () => prefixService.update(id, String(body.prefix || "").trim())) : prefixService.read(id),
    trialStatus: (ownerUid) => getOwnerTrialStatus(ownerUid, { root }),
    resetTrial: (ownerUid) => withMyBotsTransaction({ root, registryPath }, (txn) => {
      txn.trackFile?.(getTrialLedgerPath(root));
      return { ownerUid, reset: resetOwnerTrialForWeek(ownerUid, undefined, { root }) };
    }),
  };
}
