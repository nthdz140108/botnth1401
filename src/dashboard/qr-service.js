import path from "node:path";
import { QrSessionManager } from "./qr-session.js";
import { ConfigStore } from "./config-store.js";

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
} = {}) {
  if (!registry) throw new Error("registry is required");
  let modulePromise;
  const loadModule = () => {
    modulePromise ||= Promise.resolve(moduleLoader());
    return modulePromise;
  };

  return new QrSessionManager({
    initSession: async (context) => (await loadModule()).initSession({ ...context, persistQrFile }),
    verifyClient: async (session) => (await loadModule()).verifyClient(session),
    generateQr: async (session, context) => (await loadModule()).generateQRCode(session, { ...context, persistQrFile }),
    waitScan: async (code, session, signal, options) => (await loadModule()).waitingScan(code, session, signal, options),
    waitConfirm: async (code, session, options) => (await loadModule()).waitingConfirm(code, session, options),
    readQr: async (session) => session?.qrImage || null,
    writeCredential: async (botId, credential, session) => {
      const bot = await registry.describe(botId);
      if (!bot) {
        const error = new Error("Bot not found");
        error.status = 404;
        error.code = "BOT_NOT_FOUND";
        throw error;
      }
      const file = bot.configPath || bot.paths?.credentialPath;
      if (!file) {
        const error = new Error("Credential file not found");
        error.status = 404;
        error.code = "CREDENTIAL_FILE_NOT_FOUND";
        throw error;
      }
      const result = await configStore.writeJson(file, credential);
      if (auditStore) {
        await auditStore.append({
          action: "qr-login.complete",
          botId,
          sessionId: session?.sessionId || session?.id || null,
          changedPaths: result.changedPaths,
        });
      }
      return result;
    },
    maxConcurrentSessions,
  });
}
