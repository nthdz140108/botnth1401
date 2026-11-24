import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import PQueue from "p-queue";
import {
  createRuntimeMetrics,
  buildRuntimeFingerprint,
} from "../src/observability/runtime-metrics.js";

const DEFAULT_DURATION_MS = 30 * 60 * 1000;
const THREADS = Number(process.env.RUNTIME_BASELINE_THREADS || 300);
const PIPELINES = Number(process.env.RUNTIME_BASELINE_PIPELINES || 32);
const DURATION_MS = Number(process.env.RUNTIME_BASELINE_DURATION_MS || DEFAULT_DURATION_MS);
const SNAPSHOT_INTERVAL_MS = Number(process.env.RUNTIME_BASELINE_SNAPSHOT_INTERVAL_MS || 30000);
const TASK_WORK_MS = Number(process.env.RUNTIME_BASELINE_TASK_WORK_MS || 2);

function resolveProjectRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
}

async function runSyntheticWork(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBaseline({ durationMs = DURATION_MS, snapshotIntervalMs = SNAPSHOT_INTERVAL_MS, outputDir = process.env.RUNTIME_BASELINE_OUTPUT_DIR || null } = {}) {
  const projectRoot = resolveProjectRoot();
  const resolvedOutputDir = outputDir || path.join(projectRoot, "logs", "runtime-baseline");
  fs.mkdirSync(resolvedOutputDir, { recursive: true });

  const metrics = createRuntimeMetrics({ sampleIntervalMs: 200 });
  metrics.start();

  const queue = new PQueue({ concurrency: PIPELINES });
  const startedAt = Date.now();
  const snapshots = [];
  let stopped = false;

  const snapshotTimer = setInterval(() => {
    const snap = metrics.snapshot();
    snapshots.push(snap);
    const file = path.join(resolvedOutputDir, `baseline-${startedAt}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          fingerprint: buildRuntimeFingerprint({ botId: "baseline-harness" }),
          threads: THREADS,
          pipelines: PIPELINES,
          durationMs: Date.now() - startedAt,
          snapshots,
        },
        null,
        2
      )
    );
    console.log(`[baseline] snapshot #${snapshots.length} eventLoopP99=${snap.eventLoop.p99}ms rss=${snap.memory.rss}`);
  }, Math.min(snapshotIntervalMs, durationMs));

  const producer = (async () => {
    let sequence = 0;
    while (!stopped && Date.now() - startedAt < durationMs) {
      for (let thread = 1; thread <= THREADS; thread += 1) {
        sequence += 1;
        const eventId = `evt_${sequence}`;
        metrics.recordInbound({ kind: "message", threadId: `synthetic-${thread}` });
        metrics.trackPending(eventId);
        queue
          .add(async () => {
            await runSyntheticWork(TASK_WORK_MS);
            metrics.recordAck({ eventId });
            metrics.recordOutbound({ operation: "synthetic", status: "success", durationMs: TASK_WORK_MS });
          })
          .catch(() => {
            metrics.recordOutbound({ operation: "synthetic", status: "error", durationMs: 0 });
          });
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();

  await producer;
  stopped = true;
  clearInterval(snapshotTimer);
  await queue.onIdle();
  metrics.stop();

  const finalSnapshot = metrics.snapshot();
  snapshots.push(finalSnapshot);
  const result = {
    fingerprint: buildRuntimeFingerprint({ botId: "baseline-harness" }),
    threads: THREADS,
    pipelines: PIPELINES,
    durationMs: Date.now() - startedAt,
    acceptance: {
      eventLoopP99Under100Ms: finalSnapshot.eventLoop.p99 < 100,
      noUnackedEvents: finalSnapshot.inbound.unacked === 0,
    },
    snapshots,
  };
  const file = path.join(resolvedOutputDir, `baseline-${startedAt}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(`[baseline] complete -> ${file}`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("capture-runtime-baseline.js")) {
  runBaseline().catch((error) => {
    console.error("[baseline] failed:", error);
    process.exitCode = 1;
  });
}
