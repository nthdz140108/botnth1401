import test from "node:test";
import assert from "node:assert/strict";
import { createStateClaimRegistry } from "../src/core/state-claim-registry.js";

test("state claim registry handles tryClaim, release, and expiration", async () => {
  const registry = createStateClaimRegistry({ ttlMs: 50 });

  const claimed = registry.tryClaim("cooldown:bot-1:user-1:help", "evt-1");
  assert.equal(claimed, true);

  // Duplicate claim while active must fail
  const duplicate = registry.tryClaim("cooldown:bot-1:user-1:help", "evt-2");
  assert.equal(duplicate, false);

  assert.equal(registry.has("cooldown:bot-1:user-1:help"), true);

  // Release by wrong eventId should fail
  const wrongRelease = registry.release("cooldown:bot-1:user-1:help", "evt-wrong");
  assert.equal(wrongRelease, false);
  assert.equal(registry.has("cooldown:bot-1:user-1:help"), true);

  // Release by correct eventId should succeed
  const okRelease = registry.release("cooldown:bot-1:user-1:help", "evt-1");
  assert.equal(okRelease, true);
  assert.equal(registry.has("cooldown:bot-1:user-1:help"), false);

  // Claim again and let it expire
  registry.tryClaim("cooldown:bot-1:user-1:help", "evt-3", 30);
  assert.equal(registry.has("cooldown:bot-1:user-1:help"), true);

  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(registry.has("cooldown:bot-1:user-1:help"), false);
  assert.equal(registry.tryClaim("cooldown:bot-1:user-1:help", "evt-4"), true);
});

test("state claim registry prunes expired entries", () => {
  const registry = createStateClaimRegistry({ ttlMs: 100 });
  registry.tryClaim("k1", "e1", 10);
  registry.tryClaim("k2", "e2", 5000);

  const future = Date.now() + 50;
  const pruned = registry.prune(future);
  assert.equal(pruned, 1);
  assert.equal(registry.has("k1"), false);
  assert.equal(registry.has("k2"), true);
});
