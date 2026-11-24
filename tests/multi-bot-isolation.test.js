import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeLifecycle, getActiveRuntimeLifecycle } from "../src/core/runtime-lifecycle.js";
import { getBotRuntimeMetrics } from "../src/observability/runtime-metrics.js";

test("multi-bot isolation maintains independent lifecycle, queue, metrics, and processes per bot", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "multi-bot-iso-"));

  const bot1 = await createRuntimeLifecycle({
    projectRoot: tmp,
    botName: "bot-alpha",
    api: { listener: { start: async () => {} } },
  });

  const bot2 = await createRuntimeLifecycle({
    projectRoot: tmp,
    botName: "bot-beta",
    api: { listener: { start: async () => {} } },
  });

  assert.ok(bot1);
  assert.ok(bot2);
  assert.notEqual(bot1, bot2);
  assert.equal(bot1.botName, "bot-alpha");
  assert.equal(bot2.botName, "bot-beta");

  // Metrics must be isolated
  const m1 = getBotRuntimeMetrics("bot-alpha");
  const m2 = getBotRuntimeMetrics("bot-beta");
  assert.notEqual(m1, m2);

  m1.recordInbound({ kind: "message", threadId: "t1" });
  assert.equal(m1.snapshot().inbound.total, 1);
  assert.equal(m2.snapshot().inbound.total, 0);

  // Restarting/shutting down bot1 must not affect bot2
  await bot1.shutdown();
  assert.equal(getActiveRuntimeLifecycle("bot-alpha"), null);
  assert.ok(getActiveRuntimeLifecycle("bot-beta"));

  await bot2.shutdown();
  assert.equal(getActiveRuntimeLifecycle("bot-beta"), null);
});
