/**
 * Runtime fingerprint guard (LEGACY — reconcile no longer uses this).
 *
 * Reconcile now detects stale-commit processes via the MYBOT_CODE_COMMIT env
 * marker (see reconcile-guard.js), which is authoritative and does not depend
 * on log paths. This module is kept for manual diagnosis of historical log
 * files and for tests: it detects PM2 `online` apps still running code from
 * an older git commit by reading [RUNTIME FINGERPRINT] lines (written by
 * src/bootstrap.js at boot) from candidate log files.
 *
 * Missing telemetry is NEVER treated as stale: the reconcile path must not
 * block startup just because logs were rotated or a fresh install has no
 * logs yet. Staleness is only asserted on positive evidence of an older
 * commit in the logs.
 */

import fs from "node:fs";
import path from "node:path";

const FINGERPRINT_RE = /\[RUNTIME FINGERPRINT\][^\n]*commit="([^"\r\n]+)"/g;

/** Extract the most recent [RUNTIME FINGERPRINT] commit value from text. */
export function parseFingerprintCommit(text) {
  if (!text) return null;
  let match = null;
  for (const m of text.matchAll(FINGERPRINT_RE)) match = m;
  return match ? match[1] : null;
}

/** Overridable IO for tests. */
function defaultReadLogDirs(root) {
  const logsDir = path.join(root, "logs");
  try {
    return fs.readdirSync(logsDir, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? entry.name : entry.name.replace(/\.(log|txt)$/i, "")));
  } catch {
    return [];
  }
}

function defaultReadLogText(root, relative) {
  try {
    return fs.readFileSync(path.join(root, relative), "utf8").slice(-200_000);
  } catch {
    return "";
  }
}

/**
 * Decide whether the PM2 app `pm2Name` is running code from an older commit.
 *
 * Log sources, in priority order:
 * 1. logs/<pm2Name>/runtime.log — per-bot runtime logger output
 * 2. logs/<pm2Name>.log / logs/<pm2Name>-out.log — per-bot legacy files
 * 3. logs/bot-stdout.log — main bot stdout fallback
 *
 * @param {object} params
 * @param {string} params.root project root
 * @param {string} params.pm2Name PM2 app name (= botKey)
 * @param {string|null} params.currentCommit full or short SHA from git HEAD;
 *   null disables the guard (git unavailable).
 * @param {Function} [params.readLogDirs] test override (root) => string[]
 * @param {Function} [params.readLogText] test override (root, rel) => string
 * @returns {Promise<{stale:boolean, observedCommit:string|null}>}
 */
export async function isProcessStale({
  root,
  pm2Name,
  currentCommit,
  readLogDirs = (r) => defaultReadLogDirs(r),
  readLogText = (r, rel) => defaultReadLogText(r, rel),
}) {
  if (!currentCommit) return { stale: false, observedCommit: null };
  const currentShort = String(currentCommit).slice(0, 7).toLowerCase();

  const perBotCandidates = [
    path.join("logs", pm2Name, "runtime.log"),
    path.join("logs", `${pm2Name}.log`),
    path.join("logs", `${pm2Name}-out.log`),
  ];
  for (const relative of perBotCandidates) {
    const commit = parseFingerprintCommit(readLogText(root, relative));
    if (commit) {
      const stale = !commit.toLowerCase().startsWith(currentShort);
      return { stale, observedCommit: commit };
    }
  }

  // Main bot fallback: logs/bot-stdout.log fingerprint lines.
  const mainCommit = parseFingerprintCommit(readLogText(root, path.join("logs", "bot-stdout.log")));
  if (mainCommit) {
    const stale = !mainCommit.toLowerCase().startsWith(currentShort);
    return { stale, observedCommit: mainCommit };
  }
  return { stale: false, observedCommit: null };
}
