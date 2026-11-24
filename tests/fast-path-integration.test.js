import test from "node:test";
import assert from "node:assert/strict";
import { createFastPathDispatcher } from "../src/core/fast-path-dispatcher.js";
import { createLatencyTracker, REQUIRED_PHASES } from "../src/observability/latency-tracker.js";
import { wrapWithLimiter } from "../src/api-zalo/transport-limiter.js";
import { createRuntimeMetrics } from "../src/observability/runtime-metrics.js";

test("fast-path integration tracks full 8-phase lifecycle from ws_received to completed", async () => {
  const tracker = createLatencyTracker();
  const metrics = createRuntimeMetrics({ botId: "bot-integ", latencyTracker: tracker });

  const mockApi = {
    sendMessage: async (msg) => {
      tracker.mark(msg.eventId, "outbound_called");
      await new Promise((r) => setTimeout(r, 5));
      tracker.mark(msg.eventId, "acknowledged");
      return { msgId: "out-123" };
    },
  };

  wrapWithLimiter(mockApi, {
    "fast-text": { maxConcurrent: 8, minTime: 0 },
  });

  const dispatcher = createFastPathDispatcher({
    api: mockApi,
    botId: "bot-integ",
    metrics,
    latencyTracker: tracker,
    handlers: {
      message: async (api, message) => {
        const eventId = String(message.data.cliMsgId || message.data.msgId);
        tracker.mark(eventId, "cooldown_claimed");

        tracker.mark(eventId, "outbound_started");
        await api.sendMessage({ eventId, threadId: message.threadId, text: "Pong" });
      },
    },
  });

  const incomingMessage = {
    threadId: "thread-integ-1",
    data: {
      msgId: "m-integ-1",
      cliMsgId: "c-integ-1",
      content: "!ping",
      uidFrom: "user-integ",
    },
  };

  await dispatcher.dispatchMessage(incomingMessage);

  const snapshot = tracker.snapshot("bot-integ");
  assert.ok(snapshot);
  assert.equal(snapshot.total.count, 1);
  assert.ok(snapshot.total.p50 > 0);

  // Verify phase transitions were tracked
  assert.ok(snapshot.byPhase["ws_received->preflight_started"] !== undefined);
  assert.ok(snapshot.byPhase["preflight_started->handler_started"] !== undefined);
  assert.ok(snapshot.byPhase["handler_started->cooldown_claimed"] !== undefined);
  assert.ok(snapshot.byPhase["cooldown_claimed->outbound_started"] !== undefined);
  assert.ok(snapshot.byPhase["outbound_started->outbound_called"] !== undefined);
  assert.ok(snapshot.byPhase["outbound_called->acknowledged"] !== undefined);
  assert.ok(snapshot.byPhase["acknowledged->completed"] !== undefined);
});
