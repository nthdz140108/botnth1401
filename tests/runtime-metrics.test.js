import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createRuntimeMetrics,
  registerHealthProvider,
  unregisterHealthProvider,
  collectHealthExtensions,
  buildRuntimeFingerprint,
} from "../src/observability/runtime-metrics.js";

test("runtime metrics tracks inbound, ack, spool and outbound in one window", () => {
  const metrics = createRuntimeMetrics({ sampleIntervalMs: 10 });
  metrics.recordInbound({ kind: "message", threadId: "t1" });
  metrics.recordInbound({ kind: "group_event", threadId: "t2" });
  metrics.trackPending("evt-1");
  metrics.recordSpool({ eventId: "evt-2", bytes: 128 });
  metrics.recordAck({ eventId: "evt-1" });
  metrics.recordOutbound({ operation: "sendMessage", status: "success", durationMs: 12 });
  metrics.recordOutbound({ operation: "sendMessage", status: "error", durationMs: 40 });

  const snap = metrics.snapshot();
  assert.equal(snap.inbound.total, 2);
  assert.equal(snap.inbound.activeThreads, 2);
  assert.equal(snap.inbound.byKind.message, 1);
  assert.equal(snap.inbound.byKind.group_event, 1);
  assert.equal(snap.inbound.unacked, 1);
  assert.equal(snap.spool.count, 1);
  assert.equal(snap.spool.bytes, 128);
  assert.equal(snap.outbound.sendMessage.total, 2);
  assert.equal(snap.outbound.sendMessage.errors, 1);
  assert.ok(snap.process.pid > 0);

  metrics.resetWindow();
  const after = metrics.snapshot();
  assert.equal(after.inbound.total, 0);
  assert.equal(after.outbound.sendMessage, undefined);
});

test("runtime metrics computes event loop latency percentiles under load", async () => {
  const metrics = createRuntimeMetrics({ sampleIntervalMs: 5 });
  metrics.start();
  for (let i = 0; i < 5; i++) {
    const busyUntil = Date.now() + 15;
    while (Date.now() < busyUntil) {
      JSON.parse(JSON.stringify({ fill: "x".repeat(1024) }));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  metrics.stop();
  const snap = metrics.snapshot();
  assert.ok(snap.eventLoop.samples >= 3, "expected several loop samples");
  assert.ok(snap.eventLoop.p99 >= snap.eventLoop.p50);
  assert.ok(snap.eventLoop.max >= snap.eventLoop.p95);
});

test("runtime maintenance, workers and storage mode surface in snapshot", () => {
  const metrics = createRuntimeMetrics({});
  metrics.setMaintenance({ status: "completed", lastRunAt: "2026-08-26T16:59:00.000Z" });
  metrics.setWorkers({ count: 4, busy: 1 });
  metrics.setStorageMode("sqlite-dual-write");
  metrics.setQueueDepth("inbound", 7);
  const snap = metrics.snapshot();
  assert.equal(snap.maintenance.status, "completed");
  assert.equal(snap.workers.count, 4);
  assert.equal(snap.storage.mode, "sqlite-dual-write");
  assert.equal(snap.queues.inbound, 7);
});

test("health provider registry aggregates extensions and isolates failures", async () => {
  registerHealthProvider("queues", () => ({ inbound: 0 }));
  registerHealthProvider("broken", () => {
    throw new Error("boom");
  });
  try {
    const ext = await collectHealthExtensions();
    assert.deepEqual(ext.queues, { inbound: 0 });
    assert.equal(ext.broken.error, "boom");
  } finally {
    unregisterHealthProvider("queues");
    unregisterHealthProvider("broken");
  }
});

test("runtime fingerprint includes pid, botId, node version and storage mode", () => {
  const fp = buildRuntimeFingerprint({ botId: "admin", commit: "abc123" });
  assert.equal(fp.pid, process.pid);
  assert.equal(fp.botId, "admin");
  assert.equal(fp.commit, "abc123");
  assert.equal(fp.nodeVersion, process.version);
  assert.equal(fp.platform, process.platform);
});

test("baseline capture script produces snapshots with acceptance gates", { timeout: 30000 }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rt-baseline-"));
    const scriptPath = fileURLToPath(new URL("../scripts/capture-runtime-baseline.js", import.meta.url));
    const run = promisify(execFile);
    const outDir = path.join(tmp, "logs", "runtime-baseline");
    const { stdout } = await run(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        RUNTIME_BASELINE_OUTPUT_DIR: outDir,
        RUNTIME_BASELINE_DURATION_MS: "400",
        RUNTIME_BASELINE_SNAPSHOT_INTERVAL_MS: "150",
        RUNTIME_BASELINE_THREADS: "12",
        RUNTIME_BASELINE_PIPELINES: "4",
        RUNTIME_BASELINE_TASK_WORK_MS: "1",
      },
    });
    assert.match(stdout, /\[baseline\] complete/);
    const files = await fs.readdir(outDir);
    assert.ok(files.length >= 1);
    const content = JSON.parse(await fs.readFile(path.join(outDir, files[0]), "utf8"));
    assert.equal(content.acceptance.noUnackedEvents, true);
    assert.ok(content.snapshots.length >= 1);
    assert.equal(content.pipelines, 4);
});
