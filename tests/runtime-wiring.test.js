import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeLifecycle } from "../src/core/runtime-lifecycle.js";

test("runtime lifecycle wires inbound coordinator, maintenance, workers, stores and metrics cleanly", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-lifecycle-"));

  const lifecycle = await createRuntimeLifecycle({
    projectRoot: tmp,
    botName: "test-lifecycle-bot",
    api: {
      listener: {
        start: async () => {},
      },
    },
    handlers: {},
  });

  assert.ok(lifecycle);
  assert.ok(lifecycle.inboundCoordinator);
  assert.ok(lifecycle.reconnectCoordinator);
  assert.ok(lifecycle.nsfwWorkerPool);
  assert.ok(lifecycle.canvasWorkerPool);
  assert.ok(lifecycle.mediaJobStore);
  assert.ok(lifecycle.maintenance);
  assert.ok(lifecycle.stores);

  // Check stats
  const inStats = lifecycle.inboundCoordinator.stats();
  assert.equal(inStats.concurrency, 32);
  assert.equal(inStats.panicked, false);

  const nsfwStats = lifecycle.nsfwWorkerPool.stats();
  assert.equal(nsfwStats.workers, 2);

  const canvasStats = lifecycle.canvasWorkerPool.stats();
  assert.equal(canvasStats.workers, 2);

  // Check maintenance status
  const mStatus = lifecycle.maintenance.status();
  assert.equal(mStatus.timezone, "Asia/Ho_Chi_Minh");

  // Shutdown cleanly
  await lifecycle.shutdown();
});
