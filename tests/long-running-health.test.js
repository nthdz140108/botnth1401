import test from "node:test";
import assert from "node:assert/strict";
import { createLongRunningHealth } from "../src/core/long-running-health.js";

test("long running health detects high heap slope and event loop delays", async () => {
  let simulatedSlope = 30; // 30 MB/hr (> 25 threshold)
  let simulatedEventLoop = 160; // 160ms (> 150 threshold)
  let prunedCount = 0;

  const mockMetrics = {
    snapshot: () => ({
      memory: {
        heapUsed: 200 * 1024 * 1024,
        slopeMbPerHour: simulatedSlope,
      },
      eventLoop: {
        p99: simulatedEventLoop,
      },
    }),
  };

  const mockMaintenance = {
    runContinuousPrune: async () => {
      prunedCount++;
    },
  };

  const health = createLongRunningHealth({
    metrics: mockMetrics,
    maintenance: mockMaintenance,
    intervalMs: 50,
    maxHeapMb: 450,
    maxHeapSlopeMbPerHour: 25,
    maxEventLoopDelayMs: 150,
  });

  // Run 3 check cycles to trigger consecutive slope warning
  await health.checkHealth();
  await health.checkHealth();
  const record3 = await health.checkHealth();

  assert.ok(record3.warnings.some((w) => w.includes("EVENT_LOOP_LAG")));
  assert.ok(record3.warnings.some((w) => w.includes("HIGH_HEAP_SLOPE")));
  assert.equal(prunedCount, 4); // 3 regular prunes + 1 aggressive slope cleanup

  const status = health.status();
  assert.equal(status.consecutiveHighSlopeCount, 3);
  assert.equal(status.historyCount, 3);

  health.stop();
});
