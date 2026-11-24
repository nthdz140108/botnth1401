import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Startup deadlines:
 * - zalo.login() wrapped with a 30s deadline (login never settles → deadline).
 * - QR recovery limited to 120s; timeout ends only the QR child and cleans
 *   the matching lock.
 */

test("login deadline fires for a never-settling login within the deadline", async () => {
  const { withDeadline } = await import("../src/runtime/listener-state.js");
  const started = Date.now();
  await assert.rejects(
    () => withDeadline(new Promise(() => {}), 40, "login deadline"),
    /login deadline/
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2_000, `deadline must be enforced promptly, took ${elapsed}ms`);
});

test("qr recovery runner aborts the QR child after the 120s limit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-qr-limit-"));
  const lockPath = path.join(dir, "admin-recovery.lock");
  try {
    const { runQrRecoveryWithLimit } = await import("../src/runtime/qr-recovery-limiter.js");
    const result = await runQrRecoveryWithLimit({
      lockPath,
      limitMs: 50,
      spawnChild: ({ onTimeout }) => {
        // Simulated QR child that never exits on its own.
        return {
          pid: 4242,
          kill: () => true,
        };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.exitCode, null);
    // Lock must be cleaned up after timeout.
    assert.equal(fs.existsSync(lockPath), false, "lock file must be removed after QR timeout");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qr recovery runner returns the child exit code when it finishes in time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-qr-ok-"));
  const lockPath = path.join(dir, "admin-recovery.lock");
  try {
    const { runQrRecoveryWithLimit } = await import("../src/runtime/qr-recovery-limiter.js");
    const result = await runQrRecoveryWithLimit({
      lockPath,
      limitMs: 5_000,
      spawnChild: () => {
        return {
          pid: 5151,
          kill: () => true,
          once: (event, cb) => { if (event === "exit") setTimeout(() => cb(0), 10); },
        };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("qr recovery timeout cleans only its own lock and leaves a foreign lock alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-qr-foreign-"));
  const lockPath = path.join(dir, "admin-recovery.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, phase: "qr-child" }));
  try {
    const { runQrRecoveryWithLimit } = await import("../src/runtime/qr-recovery-limiter.js");
    const result = await runQrRecoveryWithLimit({
      lockPath,
      limitMs: 40,
      foreignLockOwnership: true, // lock was not written by this run
      spawnChild: () => ({ pid: 4243, kill: () => true }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    assert.equal(result.timedOut, true);
    assert.equal(fs.existsSync(lockPath), true, "foreign lock must NOT be removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
