import test from "node:test";
import assert from "node:assert/strict";
import { createLatencyTracker } from "../src/observability/latency-tracker.js";
import { createRuntimeMetrics } from "../src/observability/runtime-metrics.js";

test("synthetic test: 4 simulated bot processes with 300 threads handle concurrent workload without blocking text", async () => {
  const bots = ["bot-1", "bot-2", "bot-3", "bot-4"];
  const threadCountPerBot = 300;
  const tracker = createLatencyTracker();
  const botMetrics = new Map();

  for (const botId of bots) {
    const m = createRuntimeMetrics({ botId, latencyTracker: tracker });
    m.start();
    botMetrics.set(botId, m);
  }

  // Generate synthetic workload: 80% text, 10% reaction/undo, 10% heavy
  const tasks = [];
  let eventSeq = 0;

  for (const botId of bots) {
    for (let t = 0; t < threadCountPerBot; t++) {
      const threadId = `group-${botId}-${t}`;
      const rand = Math.random();
      let kind = "message";
      let commandClass = "fast-text";
      let simulatedDelayMs = 5; // text fast

      if (rand < 0.8) {
        kind = "message";
        commandClass = "fast-text";
        simulatedDelayMs = 2 + Math.floor(Math.random() * 5); // 2-7ms
      } else if (rand < 0.9) {
        kind = rand < 0.85 ? "reaction" : "undo";
        commandClass = "control";
        simulatedDelayMs = 1 + Math.floor(Math.random() * 3); // 1-4ms
      } else {
        kind = "message";
        commandClass = "media";
        // Heavy task simulated
        simulatedDelayMs = 50 + Math.floor(Math.random() * 50); // 50-100ms in accelerated test
      }

      eventSeq++;
      const eventId = `evt-${botId}-${eventSeq}`;

      tasks.push(
        (async () => {
          tracker.begin(eventId, kind, botId, { commandClass, threadId });
          tracker.mark(eventId, "preflight_started");
          tracker.mark(eventId, "cooldown_claimed");
          tracker.mark(eventId, "handler_started");

          // Simulate non-blocking async execution
          await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));

          tracker.mark(eventId, "outbound_started");
          tracker.mark(eventId, "outbound_called");
          tracker.mark(eventId, "acknowledged");
          tracker.finish(eventId, "ok");
        })()
      );
    }
  }

  await Promise.all(tasks);

  // Check metrics for each bot
  for (const botId of bots) {
    const snap = tracker.snapshot(botId);
    assert.equal(snap.botId, botId);
    assert.equal(snap.total.count, threadCountPerBot);

    // Fast-text p95 must be low and independent of heavy task
    const fastTextStats = snap.byClass["fast-text"];
    assert.ok(fastTextStats, `fast-text stats exist for ${botId}`);
    assert.ok(fastTextStats.p95 < 100, `fast-text p95 ${fastTextStats.p95}ms should be < 100ms`);

    // Heavy task stats
    const heavyStats = snap.byClass["media"];
    if (heavyStats && heavyStats.count > 0) {
      assert.ok(heavyStats.p50 >= 40, `media p50 should reflect heavy simulated duration`);
    }

    const m = botMetrics.get(botId);
    const mSnap = m.snapshot();
    assert.ok(mSnap.memory);
    assert.ok(typeof mSnap.memory.slopeBytesPerSec === "number");
    assert.ok(typeof mSnap.eventLoop.p99 === "number");
    m.stop();
  }
});
