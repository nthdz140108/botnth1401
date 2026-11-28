import path from "node:path";
import { QrSessionManager } from "./qr-session.js";
import { ConfigStore } from "./config-store.js";
import { verifyLoginCredential } from "../commands/mybot/System/login-verification.js";
import { persistVerifiedBot } from "../commands/mybot/System/verified-provisioning.js";
import { initializeVerifiedBotFiles } from "../commands/mybot/Manager/qr-login-command.js";

export function createQrSessionManager({
  root = process.cwd(),
  registry,
  configStore = new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") }),
  auditStore = null,
  moduleLoader = () => import("../commands/mybot/Credentials/qr-login.js"),
  maxConcurrentSessions = process.env.QR_LOGIN_MAX_CONCURRENT !== undefined && process.env.QR_LOGIN_MAX_CONCURRENT !== ""
    ? process.env.QR_LOGIN_MAX_CONCURRENT
    : Infinity,
  persistQrFile = false,
  verifyAccount = verifyLoginCredential,
  drafts = new Map(),
} = {}) {
  if (!registry) throw new Error("registry is required");
  let modulePromise;
  const loadModule = () => {
    modulePromise ||= Promise.resolve(moduleLoader());
    return modulePromise;
  };

  const manager = new QrSessionManager({
    initSession: async (context) => (await loadModule()).initSession({ ...context, persistQrFile }),
    verifyClient: async (session) => (await loadModule()).verifyClient(session),
    generateQr: async (session, context) => (await loadModule()).generateQRCode(session, { ...context, persistQrFile }),
    waitScan: async (code, session, signal, options) => (await loadModule()).waitingScan(code, session, signal, options),
    waitConfirm: async (code, session, options) => (await loadModule()).waitingConfirm(code, session, options),
    readQr: async (session) => session?.qrImage || null,
    verifyAccount: (credential, options) => verifyAccount(credential, { ...options, root }),
    writeCredential: async (botId, credential, session, verification) => {
      const draft = drafts.get(botId);
      const bot = await registry.describe(botId);
      if (!bot && !draft) {
        const error = new Error("Bot not found");
        error.status = 404;
        error.code = "BOT_NOT_FOUND";
        throw error;
      }
      const file = bot?.configPath || bot?.paths?.credentialPath;
      if (bot && !file) {
        const error = new Error("Credential file not found");
        error.status = 404;
        error.code = "CREDENTIAL_FILE_NOT_FOUND";
        throw error;
      }
      const result = await persistVerifiedBot({ root, credential, identity: verification.identity,
        ...(draft ? {
          newBotKey: botId,
          ownerUid: draft.ownerUid,
          ownerName: draft.ownerName || "",
          profilePatch: { activationPolicy: draft.activationPolicy },
          initialize: (botKey, storedCredential, record, txn) => initializeVerifiedBotFiles({ root, botKey, credential: storedCredential, record, txn, prefix: draft.prefix }),
        } : { targetBotKey: botId }),
        allowAdmin: true, allowMainUpdate: true, signal: verification.signal });
      drafts.delete(botId);
      if (auditStore) {
        await auditStore.append({
          action: "qr-login.complete",
          botId,
          sessionId: session?.sessionId || session?.id || null,
          changedPaths: result.changedPaths,
        }).catch(() => {});
      }
      return result;
    },
    maxConcurrentSessions,
  });
  const start = manager.start.bind(manager);
  manager.start = async (botId) => {
    const draft = drafts.get(botId);
    if (draft && draft.expiresAt <= Date.now()) {
      drafts.delete(botId);
      throw Object.assign(new Error("Phiên tạo Bot đã hết hạn. Hãy tạo QR mới."), { code: "QR_DRAFT_EXPIRED", status: 410, stage: "initialize" });
    }
    if (!draft && !(await registry.describe(botId))) {
      throw Object.assign(new Error("Không tìm thấy Bot hoặc phiên tạo Bot."), { code: "BOT_NOT_FOUND", status: 404, stage: "initialize" });
    }
    try { return await start(botId); }
    catch (error) { if (error.code !== "QR_CONFLICT") drafts.delete(botId); throw error; }
  };
  const finish = manager.finish.bind(manager);
  manager.finish = async (entry) => {
    try { return await finish(entry); }
    finally { drafts.delete(entry.botId); }
  };
  const cancel = manager.cancel.bind(manager);
  manager.cancel = (botId) => {
    const discarded = drafts.delete(botId);
    return cancel(botId) || discarded;
  };
  return manager;
}
