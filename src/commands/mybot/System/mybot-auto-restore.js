import path from "path";
import fs from "fs";

/**
 * Auto-restore / auto-start policy for child bots at startup (`run.bat`).
 *
 * NEW POLICY: every VALID, non-expired child bot is an auto-start candidate
 * regardless of its previous `status` (including `stopped`). `status` only
 * records what happened in the previous session — Stop is honored until the
 * next `run.bat`.
 *
 * A bot is selected when ALL of the following hold (fail-closed):
 * - key is not `admin`
 * - not disabled (`enabled === false`, `status === "disabled"`,
 *   `statusDisabled === true`), not rejected/deleted
 * - expiryAt is "-1" (permanent) or parses to a future timestamp;
 *   missing/malformed expiry fails closed
 * - not cookieDead, trialStatus not pending/activating
 * - credentials contain BOTH cookie and imei. Resolution order (newest first):
 *     1. inline `botInfo.credentials` / legacy flat `cookie`/`imei` (test stubs),
 *     2. registry-declared `configFilePath` (e.g. `mybot/credentials/<uid>.json`),
 *     3. canonical QR location `mybot/credentials/<uid>.json`,
 *     4. legacy credential path under the project root.
 * - webPort parses to a valid port (1..65535)
 *
 * The credential FILE read is async because in production the registry never
 * carries secrets — QR stores them at `mybot/credentials/<uid>.json`. When
 * `projectRoot` is omitted, only inline credentials are considered (legacy
 * sync callers / unit tests that ship secrets in the registry).
 *
 * `identityPending` is NOT a reason to exclude a bot anymore. A pending child
 * must be allowed to start so it can resolve its own admin identities in its
 * own session (the fix for the child identity deadlock). While pending the bot
 * runs in restricted mode (self UID is the only Supreme Admin, fail-closed), but
 * it stays online and keeps trying to resolve.
 *
 * `explainAutoRestoreCandidates()` returns the skip reason per excluded bot
 * (filtered secrets) so reconcile logs can show exactly why a bot was not
 * started.
 */

const EXCLUDED_STATUSES = new Set(["disabled", "rejected", "deleted", "blocked"]);

function inlineCredentialShapeOk(botInfo) {
  const creds = botInfo?.credentials && typeof botInfo.credentials === "object"
    ? botInfo.credentials
    : botInfo;
  const cookie = String(creds?.cookie || "").trim();
  const imei = String(creds?.imei || "").trim();
  return cookie.length > 0 && imei.length > 0;
}

function readCredentialFile(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    const cookie = typeof data.cookie === "string"
      ? data.cookie.trim()
      : (data.cookie && typeof data.cookie === "object" ? JSON.stringify(data.cookie) : "");
    const imei = String(data.imei || "").trim();
    return { cookie, imei };
  } catch {
    return null;
  }
}

/**
 * Resolve credential source files in priority order. Returns the absolute
 * path to read, or null if no candidate path exists. Pure-path computation;
 * never reads.
 *
 * @param {object} botInfo
 * @param {string} projectRoot
 * @returns {string|null}
 */
export function resolveCredentialFilePath(botInfo, projectRoot) {
  if (!botInfo || typeof botInfo !== "object") return null;
  const root = projectRoot ? path.resolve(projectRoot) : null;
  const uid = String(botInfo.uid || botInfo.botKey || "").trim();
  const candidates = [];

  // 1. configFilePath declared in the registry (relative or absolute).
  if (root && botInfo.configFilePath) {
    const declared = String(botInfo.configFilePath).trim();
    if (declared) candidates.push(path.isAbsolute(declared) ? declared : path.join(root, declared));
  }

  // 2. Canonical QR location: mybot/credentials/<uid>.json.
  if (root && uid) candidates.push(path.join(root, "mybot", "credentials", `${uid}.json`));

  // 3. Legacy credential path the project still understands.
  if (root && uid) candidates.push(path.join(root, "mybot", "bots", `${uid}.json`));

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  return null;
}

/**
 * Async credential validity check. Mirrors the legacy inline check AND
 * reads the credential file when needed so production QR bots (whose
 * registry has no `credentials` field) are correctly restored.
 *
 * @param {object} botInfo
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @returns {boolean}
 */
export function hasValidCredentials(botInfo, { projectRoot = null } = {}) {
  if (inlineCredentialShapeOk(botInfo)) return true;
  if (!projectRoot) return false;
  const filePath = resolveCredentialFilePath(botInfo, projectRoot);
  if (!filePath) return false;
  const creds = readCredentialFile(filePath);
  return Boolean(creds && creds.cookie.length > 0 && creds.imei.length > 0);
}

function parseWebPort(botInfo) {
  const raw = botInfo?.webPort;
  if (raw === undefined || raw === null || raw === "") return null;
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return port;
}

/**
 * Evaluate one registry entry. Returns { ok, reason } — reason is the
 * fail-closed skip explanation when ok is false.
 *
 * Pass `projectRoot` so the credential check can read `mybot/credentials/<uid>.json`
 * (the real QR location) when the registry entry does not inline credentials.
 * Without `projectRoot` the credential check falls back to inline-only and
 * keeps the legacy synchronous behaviour.
 */
export function evaluateRestoreCandidate(uid, botInfo, { now = Date.now(), projectRoot = null } = {}) {
  if (!uid || uid === "admin") return { ok: false, reason: "not-a-child-bot" };
  if (!botInfo || typeof botInfo !== "object") return { ok: false, reason: "malformed-record" };

  if (botInfo.deleted === true) return { ok: false, reason: "deleted" };
  if (botInfo.enabled === false) return { ok: false, reason: "disabled" };
  if (botInfo.statusDisabled === true) return { ok: false, reason: "disabled" };
  if (EXCLUDED_STATUSES.has(String(botInfo.status || "").toLowerCase())) {
    return { ok: false, reason: `status-${String(botInfo.status).toLowerCase()}` };
  }

  // Expiry: "-1" is permanent; anything else must parse and be in the future.
  const expiryRaw = botInfo.expiryAt;
  if (expiryRaw === undefined || expiryRaw === null || String(expiryRaw).trim() === "") {
    return { ok: false, reason: "missing-expiry" };
  }
  if (String(expiryRaw).trim() !== "-1") {
    const expiryTime = Date.parse(expiryRaw);
    if (Number.isNaN(expiryTime)) return { ok: false, reason: "malformed-expiry" };
    if (expiryTime <= now()) return { ok: false, reason: "expired" };
  }

  if (botInfo.cookieDead === true) return { ok: false, reason: "cookie-dead" };
  const trialStatus = String(botInfo.trialStatus || "").toLowerCase();
  if (trialStatus === "pending" || trialStatus === "activating") {
    return { ok: false, reason: `trial-${trialStatus}` };
  }

  if (!hasValidCredentials(botInfo, { projectRoot })) return { ok: false, reason: "missing-credentials" };

  const webPort = parseWebPort(botInfo);
  if (webPort === null) return { ok: false, reason: "invalid-web-port" };

  return { ok: true, reason: null };
}

export function getAutoRestoreCandidates(registry = {}, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const projectRoot = options.projectRoot || null;
  const candidates = [];
  for (const [uid, botInfo] of Object.entries(registry || {})) {
    const verdict = evaluateRestoreCandidate(uid, botInfo, { now, projectRoot });
    if (!verdict.ok) continue;
    const port = parseWebPort(botInfo);
    candidates.push({
      uid,
      webPort: port,
      botKey: botInfo.botKey || uid,
      displayName: botInfo.displayName || botInfo.name || uid,
      ...botInfo,
      webPort: port,
    });
  }

  return candidates.sort((a, b) => {
    const timeA = a.createdAt ? Date.parse(a.createdAt) : 0;
    const timeB = b.createdAt ? Date.parse(b.createdAt) : 0;
    if (!isNaN(timeA) && !isNaN(timeB) && timeA !== timeB) {
      return timeA - timeB;
    }
    return String(a.uid).localeCompare(String(b.uid));
  });
}

/**
 * Full evaluation report: candidates plus per-bot skip reasons for every
 * excluded registry entry. Reasons are static policy strings — no secrets.
 */
export function explainAutoRestoreCandidates(registry = {}, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const projectRoot = options.projectRoot || null;
  const candidates = [];
  const skipped = {};
  for (const [uid, botInfo] of Object.entries(registry || {})) {
    const verdict = evaluateRestoreCandidate(uid, botInfo, { now, projectRoot });
    if (verdict.ok) candidates.push({ uid, botKey: botInfo?.botKey || uid, webPort: parseWebPort(botInfo) });
    else skipped[uid] = verdict.reason;
  }
  return { candidates, skipped };
}

export async function executeAutoRestore({
  registry = {},
  launcherFn,
  isPortInUseFn = async () => false,
  logFn = console.log,
  now = Date.now(),
  projectRoot = null,
} = {}) {
  const { candidates, skipped } = explainAutoRestoreCandidates(registry, { now, projectRoot });
  const attempted = [];
  const succeeded = [];
  const failed = [];

  for (const candidate of candidates) {
    const bot = { ...candidate, ...(registry[candidate.uid] || {}) };
    const uid = candidate.uid;
    attempted.push(uid);

    const webPort = candidate.webPort || parseInt(bot.webPort, 10);
    if (webPort && (await isPortInUseFn(webPort))) {
      logFn(`Bot ${bot.displayName || uid} (${uid}) is already running on port ${webPort}, skipping`);
      succeeded.push(uid);
      continue;
    }

    try {
      const result = await launcherFn(uid);
      if (result === true || result?.success === true) {
        succeeded.push(uid);
        logFn(`Bot ${bot.displayName || uid} (${uid}) auto-restored successfully`);
      } else {
        failed.push({ uid, reason: result?.reason || "launcher returned false" });
        logFn(`Failed to auto-restore bot ${uid}: ${result?.reason || "launcher returned false"}`);
      }
    } catch (err) {
      failed.push({ uid, reason: err.message });
      logFn(`Failed to auto-restore bot ${uid}: ${err.message}`);
    }
  }

  return { attempted, succeeded, failed, skipped };
}