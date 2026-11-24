import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claimOwnerTrial, loadTrialLedger } from "../src/commands/mybot/System/mybot-trial-ledger.js";

test("claimOwnerTrial handles high-concurrency race conditions atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-trial-race-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });

  const ownerUid = "race-owner-999";
  const numWorkers = 10;

  // Run 10 parallel claims for the same owner simultaneously
  const results = await Promise.all(
    Array.from({ length: numWorkers }).map((_, i) =>
      Promise.resolve().then(() => claimOwnerTrial(ownerUid, `bot-${i}`, { root }))
    )
  );

  const successCount = results.filter((r) => r.success === true).length;
  const quotaExhaustedCount = results.filter((r) => r.code === "TRIAL_QUOTA_EXHAUSTED").length;

  assert.equal(successCount, 1, "Exactly one claim should succeed");
  assert.equal(quotaExhaustedCount, numWorkers - 1, "All other concurrent claims should be rejected with TRIAL_QUOTA_EXHAUSTED");

  // Verify ledger integrity
  const ledgerData = loadTrialLedger({ root });
  assert.ok(ledgerData.ledger[ownerUid]);
  const weeks = Object.keys(ledgerData.ledger[ownerUid]);
  assert.equal(weeks.length, 1);
});

test("claimOwnerTrial multi-process race condition across real Node processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-trial-proc-race-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });

  const ownerUid = "multi-proc-owner-777";
  const { pathToFileURL } = await import("node:url");
  const moduleUrl = pathToFileURL(path.resolve("src/commands/mybot/System/mybot-trial-ledger.js")).href;
  const workerScript = `
    import { claimOwnerTrial } from ${JSON.stringify(moduleUrl)};
    const res = claimOwnerTrial(${JSON.stringify(ownerUid)}, process.argv[2], { root: ${JSON.stringify(root)} });
    process.stdout.write(JSON.stringify(res));
  `;

  const scriptPath = path.join(root, "worker.mjs");
  await fs.writeFile(scriptPath, workerScript, "utf8");

  const numProcesses = 6;
  const { spawn } = await import("node:child_process");

  const runWorker = (botId) => new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, botId], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  });

  const results = await Promise.all(
    Array.from({ length: numProcesses }).map((_, i) => runWorker(`proc-bot-${i}`))
  );

  const successCount = results.filter((r) => r.success === true).length;
  const quotaExhaustedCount = results.filter((r) => r.code === "TRIAL_QUOTA_EXHAUSTED").length;

  assert.equal(successCount, 1, "Exactly one process should claim trial successfully");
  assert.equal(quotaExhaustedCount, numProcesses - 1, "All other processes must receive TRIAL_QUOTA_EXHAUSTED");
});

test("claimOwnerTrial recovers from dead PID stale lock automatically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-trial-crash-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });

  const ledgerPath = path.join(root, "mybot", "state", "trial-ledger.json");
  const lockFile = `${ledgerPath}.lock`;

  // Simulate stale lock left behind by a dead PID (e.g. 9999999)
  await fs.writeFile(lockFile, JSON.stringify({
    pid: 9999999,
    createdAt: Date.now() - 30000,
    heartbeatAt: Date.now() - 30000,
  }), "utf8");

  const res = claimOwnerTrial("crash-test-owner", "bot-recovered", { root, ledgerPath });
  assert.equal(res.success, true);
  assert.equal(res.record.ownerUid, "crash-test-owner");
});
