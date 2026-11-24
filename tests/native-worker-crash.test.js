import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeProcessPool } from "../src/core/native-process-pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultWorkersDir = path.resolve(__dirname, "..", "src", "workers");

test("native process pool handles worker crash gracefully and spawns replacement", async () => {
  const canvasProcessPath = path.join(defaultWorkersDir, "canvas-process.js");
  const pool = createNativeProcessPool({
    entrypoint: canvasProcessPath,
    maxProcesses: 1,
    taskTimeoutMs: 3000,
  });

  // Task 1: ping
  const r1 = await pool.run("ping", {});
  assert.equal(r1, "pong");

  // Force kill the child process to simulate crash
  const initialStats = pool.stats();
  assert.equal(initialStats.processes, 1);

  // Verify invalid recycle returns worker_not_found
  const invalidRes = await pool.recycle("non-existent-pid");
  assert.deepEqual(invalidRes, { success: false, reason: "worker_not_found" });

  // Recycle / kill the actual worker
  const pid = pool.stats().pids[0];
  const recRes = await pool.recycle(pid);
  assert.equal(recRes.success, true);

  // Wait briefly for replacement
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Task 2: ping after crash/recycle must still succeed on replacement child
  const r2 = await pool.run("ping", {});
  assert.equal(r2, "pong");

  await pool.close();
});
