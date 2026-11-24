import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

const durationMs = Math.max(1, Number(workerData?.durationMs) || 3000);
const start = performance.now();
let ops = 0;

while (performance.now() - start < durationMs) {
  const h = crypto.createHash("sha256");
  h.update(String(ops) + Math.random());
  h.digest("hex");
  ops++;
}

parentPort?.postMessage({ ops, durationMs });
