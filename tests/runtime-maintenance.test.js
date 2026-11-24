import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeMaintenance } from "../src/core/runtime-maintenance.js";

test("runtime maintenance runs pre-midnight pipeline in exact order", async () => {
  const executionOrder = [];
  const stores = {
    rank: {
      flush: async () => executionOrder.push("flush:rank"),
      reset: () => executionOrder.push("reset:rank"),
    },
    training: { flush: async () => executionOrder.push("flush:training") },
    message: { flush: async () => executionOrder.push("flush:message") },
    sqlite: { flush: async () => executionOrder.push("flush:sqlite") },
  };
  const spool = {
    prune: async () => {
      executionOrder.push("prune:spool");
      return { pruned: 10 };
    },
  };
  const caches = {
    message: { prune: () => executionOrder.push("prune:messageCache") },
    link: { prune: () => executionOrder.push("prune:linkCache") },
    image: { cleanup: () => executionOrder.push("prune:imageCache") },
    group: { purgeStale: () => executionOrder.push("prune:groupCache") },
    cooldown: { prune: () => executionOrder.push("prune:cooldown") },
  };
  const workers = {
    pruneIdle: async () => executionOrder.push("workers:pruneIdle"),
  };
  const sqlite = {
    checkpoint: () => executionOrder.push("sqlite:checkpoint"),
  };

  const maintenance = createRuntimeMaintenance({
    stores,
    caches,
    workers,
    spool,
    sqlite,
  });

  const res = await maintenance.runPreMidnight();
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);

  // Check order: flush stores -> prune spool -> prune caches -> workers -> sqlite checkpoint
  assert.ok(executionOrder.indexOf("flush:rank") < executionOrder.indexOf("prune:spool"));
  assert.ok(executionOrder.indexOf("prune:spool") < executionOrder.indexOf("prune:messageCache"));
  assert.ok(executionOrder.indexOf("prune:messageCache") < executionOrder.indexOf("workers:pruneIdle"));
  assert.ok(executionOrder.indexOf("workers:pruneIdle") < executionOrder.indexOf("sqlite:checkpoint"));

  // Check midnight reset
  const midnightRes = await maintenance.runMidnightReset();
  assert.equal(midnightRes.ok, true);
  assert.equal(midnightRes.resetRank, "done");
  assert.equal(executionOrder[executionOrder.length - 1], "reset:rank");
});

test("maintenance shutdown flushes all stores safely", async () => {
  let flushed = 0;
  const maintenance = createRuntimeMaintenance({
    stores: {
      rank: { flush: async () => flushed++ },
      training: { flush: async () => flushed++ },
      message: { flush: async () => flushed++ },
    },
  });

  await maintenance.shutdown();
  assert.equal(flushed, 3);
});
