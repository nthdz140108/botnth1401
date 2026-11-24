import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeMaintenance } from "../src/core/runtime-maintenance.js";
import { createStateClaimRegistry } from "../src/core/state-claim-registry.js";
import { ImageBufferCache } from "../src/utils/image-buffer-cache.js";

test("runtime maintenance continuous prune clears stale data across all caches", async () => {
  const stateClaims = createStateClaimRegistry({ ttlMs: 100 });
  const imageCache = new ImageBufferCache({ ttlMs: 100 });

  stateClaims.tryClaim("k-old", "e-1", 50);
  stateClaims.tryClaim("k-fresh", "e-2", 50000);

  const maintenance = createRuntimeMaintenance({
    stores: {
      stateClaims,
    },
    caches: {
      image: imageCache,
    },
  });

  // Fast forward time
  const future = Date.now() + 150;
  const res = await maintenance.runContinuousPrune(future);

  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  assert.equal(stateClaims.has("k-old"), false);
  assert.equal(stateClaims.has("k-fresh"), true);

  // Run Pre-midnight and Midnight Reset
  const preMidnight = await maintenance.runPreMidnight();
  assert.equal(preMidnight.ok, true);

  const resetRes = await maintenance.runMidnightReset();
  assert.equal(resetRes.ok, true);
});
