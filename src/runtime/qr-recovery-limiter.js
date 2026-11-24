/**
 * QR Recovery Limiter — bounds admin QR recovery to a hard time limit.
 *
 * The QR child process (qr-login-admin.js) previously had no upper bound:
 * if the terminal window sat unanswered, the admin bot stayed in the
 * `qr-recovery` phase indefinitely. With the 120s limit, a timeout kills
 * ONLY the QR child, cleans up the matching recovery lock (never a foreign
 * lock written by another run), and lets the caller finish the startup
 * decision (stop/retry) instead of hanging PM2 online forever.
 */

import fs from "node:fs";

export const DEFAULT_QR_LIMIT_MS = 120_000;

/**
 * Run the QR recovery child under a hard time limit.
 *
 * @param {object} options
 * @param {string} options.lockPath recovery lock file path
 * @param {number} [options.limitMs] hard limit (default 120s)
 * @param {(opts: { onTimeout: () => void }) => object} options.spawnChild
 *   spawns the child; must return an object with `pid`, `kill()` and
 *   `once(event, cb)` (Node child_process API).
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable sleep
 * @param {boolean} [options.foreignLockOwnership] when true the lock was
 *   written by another run and must NOT be removed by this one.
 * @returns {Promise<{ exitCode: number|null, timedOut: boolean, timedOutError: Error|null }>}
 */
export async function runQrRecoveryWithLimit({
  lockPath,
  limitMs = DEFAULT_QR_LIMIT_MS,
  spawnChild,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  foreignLockOwnership = false,
} = {}) {
  if (typeof spawnChild !== "function") throw new TypeError("spawnChild must be a function");

  let childExit = null; // { code }
  let timedOutError = null;

  const child = await new Promise((resolveSpawn) => {
    try {
      resolveSpawn(spawnChild({
        onTimeout: () => {},
      }));
    } catch (error) {
      resolveSpawn(null);
      timedOutError = error;
    }
  });

  if (!child) {
    return { exitCode: 1, timedOut: false, timedOutError: timedOutError || new Error("spawn failed") };
  }

  if (typeof child.once === "function") {
    child.once("exit", (code) => {
      childExit = { code: code ?? 1 };
    });
    child.once("error", () => {
      childExit = { code: 1 };
    });
  }

  // Wait until the child exits or the limit elapses.
  const deadline = Date.now() + limitMs;
  while (!childExit && Date.now() < deadline) {
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }

  if (!childExit) {
    // Hard timeout: kill ONLY this QR child.
    try { child.kill(); } catch {}
    // Give the process a short grace period to actually die.
    const graceDeadline = Date.now() + 2_000;
    while (!childExit && Date.now() < graceDeadline) {
      await sleep(20);
    }
    if (!childExit) childExit = { code: null };

    // Clean up the lock ONLY if this run owns it.
    if (!foreignLockOwnership) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
    return { exitCode: null, timedOut: true, timedOutError: new Error(`QR recovery exceeded ${limitMs}ms`) };
  }

  // Child exited within the limit; caller owns lock cleanup as before.
  return { exitCode: childExit.code, timedOut: false, timedOutError: null };
}
