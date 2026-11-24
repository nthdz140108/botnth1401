import test from "node:test";
import assert from "node:assert/strict";
import { createFastPathDispatcher } from "../src/core/fast-path-dispatcher.js";
import { createWorkloadBroker } from "../src/core/workload-broker.js";
import { createLatencyTracker } from "../src/observability/latency-tracker.js";
import { createRuntimeMetrics } from "../src/observability/runtime-metrics.js";
import { wrapWithLimiter } from "../src/api-zalo/transport-limiter.js";

test("multi-bot stress test: 4 bots process 1000 concurrent events without blocking fast path", async () => {
  const bots = ["stress-bot-1", "stress-bot-2", "stress-bot-3", "stress-bot-4"];
  const totalEventsPerBot = 250; // 4 * 250 = 1000 total events
  const tracker = createLatencyTracker();
  const botContexts = new Map();

  for (const botId of bots) {
    const metrics = createRuntimeMetrics({ botId, latencyTracker: tracker });
    metrics.start();

    const broker = createWorkloadBroker({
      botId,
      metrics,
      maxHeavyConcurrent: 2,
      maxBroadcastConcurrent: 3,
    });

    const mockApi = {
      sendMessage: async (msg) => {
        await new Promise((r) => setTimeout(r, 1));
        return { ok: true, msgId: `msg-${Date.now()}` };
      },
      addReaction: async (react) => {
        await new Promise((r) => setTimeout(r, 1));
        return { ok: true };
      },
      uploadAttachment: async (files) => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true, files };
      },
    };

    wrapWithLimiter(mockApi, {
      "fast-text": { maxConcurrent: 32, minTime: 0 },
      control: { maxConcurrent: 32, minTime: 0 },
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
              return api.uploadAttachment(["file.mp4"]);
            });
            await api.sendMessage("ACK: heavy task submitted");
          } else {
            await broker.runFast("chat", async () => {
              await api.sendMessage(`Echo: ${message.data.content}`);
            });
          }
        },
        reaction: async (api, react) => {
          await broker.runControl("reaction", async () => {
            await api.addReaction(react);
          });
        },
        undo: async (api, undo) => {
          await broker.runControl("undo", async () => {
            // Undo logic
          });
        },
      },
    });

    botContexts.set(botId, { metrics, broker, dispatcher, mockApi });
  }

  // Generate 1000 events across concurrent threads
  const botRunners = bots.map(async (botId) => {
    const ctx = botContexts.get(botId);
    const threads = 25;
    const eventsPerThread = totalEventsPerBot / threads;

    const threadPromises = [];
    for (let t = 0; t < threads; t++) {
      threadPromises.push(
        (async () => {
          for (let e = 0; e < eventsPerThread; e++) {
            const seq = t * eventsPerThread + e + 1;
            const rand = Math.random();
            const threadId = `thread-${botId}-${t}`;
            const msgId = `msg-${botId}-${seq}`;
            const cliMsgId = `cli-${botId}-${seq}`;

            if (rand < 0.8) {
              await ctx.dispatcher.dispatchMessage({
                threadId,
                data: { msgId, cliMsgId, content: `Hello ${seq}`, isHeavy: false, uidFrom: `user-${t}` },
              });
            } else if (rand < 0.9) {
              if (rand < 0.85) {
                await ctx.dispatcher.dispatchReaction({
                  threadId,
                  data: { msgId, uidFrom: `user-${t}`, reactType: "like" },
                });
              } else {
                await ctx.dispatcher.dispatchUndo({
                  threadId,
                  data: { msgId },
                });
              }
            } else {
              await ctx.dispatcher.dispatchMessage({
                threadId,
                data: { msgId, cliMsgId, content: `!yt ${seq}`, isHeavy: true, uidFrom: `user-${t}` },
              });
            }
          }
        })()
      );
    }

    await Promise.all(threadPromises);
  });

  await Promise.all(botRunners);

  try {
    // Validate results
    for (const botId of bots) {
      const snap = tracker.snapshot(botId);
      assert.ok(snap, `snapshot exists for ${botId}`);
      assert.equal(snap.total.count, totalEventsPerBot);

      // Fast-text p95 must remain low
      const fastStats = snap.byClass["fast-text"];
      assert.ok(fastStats, `fast-text stats exist for ${botId}`);
      assert.ok(fastStats.p95 < 150, `fast-text p95 ${fastStats.p95}ms must be < 150ms`);
    }
  } finally {
    for (const botId of bots) {
      const ctx = botContexts.get(botId);
      if (ctx) {
        await ctx.broker.shutdown();
        ctx.metrics.stop();
      }
    }
  }
});
