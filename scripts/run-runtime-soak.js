import { createLatencyTracker } from "../src/observability/latency-tracker.js";
import { createRuntimeMetrics } from "../src/observability/runtime-metrics.js";
import { createWorkloadBroker } from "../src/core/workload-broker.js";
import { createFastPathDispatcher } from "../src/core/fast-path-dispatcher.js";
import { wrapWithLimiter } from "../src/api-zalo/transport-limiter.js";
import { createLongRunningHealth } from "../src/core/long-running-health.js";

async function main() {
  const durationSeconds = Number(process.env.SOAK_DURATION_SEC || 5);
  const botCount = Number(process.env.SOAK_BOT_COUNT || 4);

  console.log(`\n======================================================`);
  console.log(`  STARTING RUNTIME SOAK TEST (${durationSeconds}s, ${botCount} bots)`);
  console.log(`======================================================\n`);

  const tracker = createLatencyTracker();
  const bots = [];

  for (let i = 1; i <= botCount; i++) {
    const botId = `soak-bot-${i}`;
    const metrics = createRuntimeMetrics({ botId, latencyTracker: tracker });
    metrics.start();

    const broker = createWorkloadBroker({
      botId,
      metrics,
      maxHeavyConcurrent: 2,
      maxBroadcastConcurrent: 3,
    });

    const mockApi = {
      sendMessage: async () => ({ ok: true }),
      addReaction: async () => ({ ok: true }),
      uploadAttachment: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true };
      },
    };

    wrapWithLimiter(mockApi, {
      "fast-text": { maxConcurrent: 8, minTime: 0 },
      control: { maxConcurrent: 8, minTime: 0 },
      heavy: { maxConcurrent: 2, minTime: 10 },
    });

    const dispatcher = createFastPathDispatcher({
      api: mockApi,
      botId,
      metrics,
      latencyTracker: tracker,
      handlers: {
        message: async (api, message) => {
          if (message.data.isHeavy) {
            broker.submitHeavy("media", message.data, async () => {
              return api.uploadAttachment(["soak.mp4"]);
            });
            await api.sendMessage("ACK");
          } else {
            await broker.runFast("chat", async () => {
              await api.sendMessage("Echo");
            });
          }
        },
      },
    });

    bots.push({ botId, metrics, broker, dispatcher, mockApi });
  }

  const health = createLongRunningHealth({
    intervalMs: 1000,
  });
  health.start();

  const stopAt = Date.now() + durationSeconds * 1000;
  let totalDispatched = 0;

  async function pumpBot(bot) {
    let seq = 0;
    while (Date.now() < stopAt) {
      seq++;
      totalDispatched++;
      const isHeavy = Math.random() < 0.1;
      await bot.dispatcher.dispatchMessage({
        threadId: `soak-thread-${seq % 50}`,
        data: {
          msgId: `msg-${bot.botId}-${seq}`,
          cliMsgId: `cli-${bot.botId}-${seq}`,
          content: `Test message ${seq}`,
          isHeavy,
          uidFrom: `user-${seq % 100}`,
        },
      });
      // Small tick between iterations
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  await Promise.all(bots.map((b) => pumpBot(b)));

  health.stop();
  for (const b of bots) {
    await b.broker.shutdown();
    b.metrics.stop();
  }

  const summary = tracker.snapshot();
  console.log(`\n================ SOAK RESULTS ================`);
  console.log(`Total Events Dispatched: ${totalDispatched}`);
  console.log(`Global Events Tracked:   ${summary.global.count}`);
  console.log(`Global p50 Latency:      ${summary.global.p50}ms`);
  console.log(`Global p95 Latency:      ${summary.global.p95}ms`);
  console.log(`Global p99 Latency:      ${summary.global.p99}ms`);
  console.log(`==============================================\n`);

  for (const bot of bots) {
    const bSnap = tracker.snapshot(bot.botId);
    console.log(`Bot [${bot.botId}]: count=${bSnap.total.count} p50=${bSnap.total.p50}ms p95=${bSnap.total.p95}ms p99=${bSnap.total.p99}ms`);
  }

  if (summary.global.p95 > 100) {
    console.error(`❌ FAILED: Global p95 latency ${summary.global.p95}ms > 100ms threshold`);
    process.exit(1);
  }

  console.log(`\n✅ SOAK TEST PASSED SUCCESSFULLY!\n`);
}

main().catch((err) => {
  console.error("Soak test failed:", err);
  process.exit(1);
});
