import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeMaintenance } from "../src/core/runtime-maintenance.js";

test("runtime maintenance pre-midnight flushes stores, prunes caches, and shrinks idle workers", async () => {
  let storesFlushed = 0;
  let cachesPruned = 0;
  let workersPruned = 0;
  let spoolPruned = 0;
  let sqliteCheckpointed = 0;

  const maintenance = createRuntimeMaintenance({
    stores: {
      rank: { flush: async () => { storesFlushed++; } },
      message: { flush: async () => { storesFlushed++; } },
      training: { flush: async () => { storesFlushed++; } },
      sqlite: { flush: async () => { storesFlushed++; } },
    },
    caches: {
      message: { prune: () => { cachesPruned++; } },
      link: { prune: () => { cachesPruned++; } },
      image: { cleanup: () => { cachesPruned++; } },
      group: { purgeStale: () => { cachesPruned++; } },
      cooldown: { prune: () => { cachesPruned++; } },
    },
    workers: {
      pruneIdle: async () => { workersPruned++; },
      close: async () => {},
    },
    spool: {
      prune: async () => { spoolPruned++; return { deleted: 5 }; },
      close: async () => {},
    },
    sqlite: {
      checkpoint: () => { sqliteCheckpointed++; },
    },
    clock: () => 1700000000000,
  });

  const res = await maintenance.runPreMidnight();
  assert.equal(res.ok, true);
  assert.equal(storesFlushed, 4);
  assert.equal(cachesPruned, 5);
  assert.equal(workersPruned, 1);
  assert.equal(spoolPruned, 1);
  assert.equal(sqliteCheckpointed, 1);

  const status = maintenance.status();
  assert.equal(status.lastPreMidnight.ok, true);
});

test("runtime maintenance midnight reset executes rank reset", async () => {
  let resetCalled = false;
  const maintenance = createRuntimeMaintenance({
    stores: {
      rank: {
        reset: () => { resetCalled = true; },
      },
    },
  });

  const res = await maintenance.runMidnightReset();
  assert.equal(res.ok, true);
  assert.equal(resetCalled, true);
  assert.equal(res.resetRank, "done");
});
