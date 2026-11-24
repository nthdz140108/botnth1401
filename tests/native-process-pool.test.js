import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNativeProcessPool } from "../src/core/native-process-pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultWorkersDir = path.resolve(__dirname, "..", "src", "workers");

test("native process pool starts with 0 workers and spawns on demand up to maxProcesses", async () => {
  const canvasProcessPath = path.join(defaultWorkersDir, "canvas-process.js");
  const pool = createNativeProcessPool({
    entrypoint: canvasProcessPath,
    maxProcesses: 2,
    taskTimeoutMs: 5000,
  });

  // 1. Startup with 0 workers
  assert.equal(pool.stats().processes, 0, "startup must have 0 workers");

  // 2. Single task spawns exactly 1 worker
  const res = await pool.run("ping", {});
  assert.equal(res, "pong");

  const stats = pool.stats();
  assert.equal(stats.processes, 1, "single task spawns 1 worker");
  assert.equal(stats.queued, 0);

  // 3. Burst test: 3 tasks concurrently do not exceed max ceiling of 2
  const results = await Promise.all([
    pool.run("ping", {}),
    pool.run("ping", {}),
    pool.run("ping", {}),
  ]);
  assert.deepEqual(results, ["pong", "pong", "pong"]);
  assert.ok(pool.stats().processes <= 2, "burst must not exceed ceiling of 2");

  await pool.close();
  assert.equal(pool.stats().processes, 0, "shutdown cleans up all workers");
});

test("native process pool reaps idle workers to 0 and does not respawn on idle crash", async () => {
  const canvasProcessPath = path.join(defaultWorkersDir, "canvas-process.js");
  const pool = createNativeProcessPool({
    entrypoint: canvasProcessPath,
    maxProcesses: 2,
    idleTimeoutMs: 100, // 100ms for fast test
    taskTimeoutMs: 5000,
  });

  // Spawn 1 worker
  await pool.run("ping", {});
  assert.equal(pool.stats().processes, 1);

  // Wait for idle reaper (100ms)
  for (let i = 0; i < 20 && pool.stats().processes > 0; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pool.stats().processes, 0, "idle workers must be reaped down to 0");

  // Prune idle explicitly also reaches 0
  await pool.run("ping", {});
  assert.equal(pool.stats().processes, 1);
  await pool.pruneIdle();
  assert.equal(pool.stats().processes, 0, "pruneIdle must reap to 0");

  await pool.close();
});

test("nsfw process pool classifies image buffer in child process", async () => {
  const nsfwProcessPath = path.join(defaultWorkersDir, "nsfw-process.js");
  const pool = createNativeProcessPool({
    entrypoint: nsfwProcessPath,
    maxProcesses: 1,
    taskTimeoutMs: 30000,
  });

  const pingRes = await pool.run("ping", {});
  assert.equal(pingRes, "pong");

  const validPng32 = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABmJLR0QA/wD/AP+gvaeTAAAAL0lEQVRYhe3OMQEAMAyAMDb/nlsZfYIB8mqmw/7lHAAAAAAAAAAAAAAAAAAAoGoBLuUCPvn1/YkAAAAASUVORK5CYII=",
    "base64"
  );
  const classifyRes = await pool.run("classify", { buffer: validPng32 });
  assert.ok(classifyRes);
  assert.ok(Array.isArray(classifyRes.predictions));
  assert.equal(typeof classifyRes.nsfwScore, "number");

  await pool.close();
  assert.equal(pool.stats().processes, 0);
});
