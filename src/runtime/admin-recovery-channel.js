import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA_VERSION = 1;
const ACTIVE_FILE = "active.json";
const STATES = {
  starting: 0,
  waiting_scan: 1,
  waiting_confirm: 2,
  success: 3,
  failed: 3,
  cancelled: 3,
  expired: 3,
};
const SESSION_ID_PATTERN = /^[a-z0-9_-]+$/i;
const FORBIDDEN_KEY_PATTERN = /cookie|imei|token|credentials|resultData/i;

function buildManifest({ sessionId, state, createdAt, expiresAt, ownerPid, updatedAt }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    state,
    createdAt,
    expiresAt,
    qrFile: `sessions/${sessionId}/qr.png`,
    ownerPid,
    updatedAt,
  };
}

function isExpired(manifest, now) {
  const expires = Date.parse(manifest.expiresAt);
  if (Number.isNaN(expires)) return true;
  return now() >= expires;
}

async function writeJsonAtomic(filePath, tmpPath, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(tmpPath, body, "utf8");
  await fs.rename(tmpPath, filePath);
}

export function createAdminRecoveryChannel({
  projectRoot,
  now = () => Date.now(),
  randomId = () => crypto.randomBytes(12).toString("hex"),
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const channelRoot = path.join(projectRoot, ".runtime", "admin-recovery");
  const sessionsDir = path.join(channelRoot, "sessions");

  async function readManifest() {
    let raw;
    try {
      raw = await fs.readFile(path.join(channelRoot, ACTIVE_FILE), "utf8");
    } catch {
      return null;
    }
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) return null;
    if (typeof manifest.sessionId !== "string" || !SESSION_ID_PATTERN.test(manifest.sessionId)) {
      return null;
    }
    return manifest;
  }

  function resolveSessionDir(sessionId) {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
    return path.join(sessionsDir, sessionId);
  }

  async function removeSessionDir(sessionId) {
    const dir = resolveSessionDir(sessionId);
    if (!dir) return;
    await fs.rm(dir, { recursive: true, force: true });
  }

  return {
    async publishQr({ imageBuffer, expiresAt, ownerPid }) {
      if (!Buffer.isBuffer(imageBuffer)) throw new TypeError("imageBuffer must be a Buffer");
      if (!Date.parse(expiresAt)) throw new TypeError("expiresAt must be an ISO timestamp");
      const prior = await readManifest();
      const sessionId = randomId();
      if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
        throw new TypeError("randomId must produce an opaque session id");
      }
      if (sessionId.length > 128 || FORBIDDEN_KEY_PATTERN.test(sessionId)) {
        throw new TypeError("randomId produced an unusable session id");
      }
      const sessionDir = path.join(sessionsDir, sessionId);
      const qrPath = path.join(sessionDir, "qr.png");
      const createdAt = new Date(now()).toISOString();

      await fs.mkdir(sessionDir, { recursive: true });
      const qrTmp = `${qrPath}.${process.pid}.tmp`;
      await fs.writeFile(qrTmp, imageBuffer);
      await fs.rename(qrTmp, qrPath);

      const manifest = buildManifest({
        sessionId,
        state: "waiting_scan",
        createdAt,
        expiresAt,
        ownerPid,
        updatedAt: createdAt,
      });
      const activeTmp = path.join(sessionDir, `active.json.${process.pid}.tmp`);
      await writeJsonAtomic(path.join(channelRoot, ACTIVE_FILE), activeTmp, manifest);
      await fs.writeFile(path.join(sessionDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      if (prior && prior.sessionId && prior.sessionId !== sessionId) {
        await removeSessionDir(prior.sessionId);
      }
      return { ...manifest };
    },

    async transition(sessionId, state, detail) {
      if (!(state in STATES)) return null;
      const manifest = await readManifest();
      if (!manifest || manifest.sessionId !== sessionId) return null;
      if (isExpired(manifest, now)) return null;
      const currentRank = STATES[manifest.state];
      if (currentRank >= 3) return null;
      if (STATES[state] <= currentRank) return null;
      const updated = {
        ...manifest,
        state,
        updatedAt: new Date(now()).toISOString(),
      };
      if (STATES[state] >= 3) {
        const dir = resolveSessionDir(sessionId);
        if (dir) {
          await fs.rm(dir, { recursive: true, force: true });
        }
        await fs.rm(path.join(channelRoot, ACTIVE_FILE), { force: true });
        return { ...updated };
      }
      const sessionDir = resolveSessionDir(sessionId);
      const activeTmp = sessionDir
        ? path.join(sessionDir, `active.json.${process.pid}.tmp`)
        : `${path.join(channelRoot, ACTIVE_FILE)}.${process.pid}.tmp`;
      await writeJsonAtomic(path.join(channelRoot, ACTIVE_FILE), activeTmp, updated);
      return { ...updated };
    },

    async readActive() {
      const manifest = await readManifest();
      if (!manifest) return null;
      if (isExpired(manifest, now)) return null;
      return { ...manifest };
    },

    async readQr(sessionId) {
      const manifest = await readManifest();
      if (!manifest || manifest.sessionId !== sessionId) return null;
      if (isExpired(manifest, now)) return null;
      const dir = resolveSessionDir(sessionId);
      if (!dir) return null;
      const qrFile = manifest.qrFile || `sessions/${sessionId}/qr.png`;
      if (path.isAbsolute(qrFile)) return null;
      const normalized = path.normalize(qrFile).split(path.sep).join("/");
      if (normalized.includes("..")) return null;
      const resolved = path.resolve(channelRoot, qrFile);
      const rootWithSep = path.resolve(channelRoot) + path.sep;
      if (!resolved.startsWith(rootWithSep)) return null;
      try {
        const bytes = await fs.readFile(resolved);
        return Buffer.from(bytes);
      } catch {
        return null;
      }
    },

    async cleanup(sessionId, finalState) {
      const manifest = await readManifest();
      if (!manifest || manifest.sessionId !== sessionId) return null;
      if (finalState !== undefined && !(finalState in STATES)) return null;
      if (finalState !== undefined && STATES[finalState] < 3) return null;
      const dir = resolveSessionDir(sessionId);
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true });
      }
      await fs.rm(path.join(channelRoot, ACTIVE_FILE), { force: true });
      return { sessionId, state: finalState || "cancelled" };
    },
  };
}

export default createAdminRecoveryChannel;
