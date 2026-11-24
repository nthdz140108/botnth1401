import test from "node:test";
import assert from "node:assert/strict";
import { LRUCache } from "lru-cache";
import { ImageBufferCache } from "../src/utils/image-buffer-cache.js";
import { CooldownLedger } from "../src/commands/command-behavior-context.js";
import { cacheState, pruneLinkPlatformCache } from "../src/utils/link-platform-cache.js";
import { getGroupInfoCache } from "../src/service-debug/info-service/group-info-data.js";

test("image buffer cache bounds by total bytes (64MB) and evicts oldest", () => {
  const cache = new ImageBufferCache({ maxBytes: 1000, ttlMs: 60000 });

  // Add 400 bytes
  cache.setBuffer("img-1", Buffer.alloc(400));
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().totalBytes, 400);

  // Add 400 bytes -> total 800
  cache.setBuffer("img-2", Buffer.alloc(400));
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().totalBytes, 800);

  // Add 400 bytes -> total would be 1200 > 1000, so img-1 is evicted
  cache.setBuffer("img-3", Buffer.alloc(400));
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().totalBytes, 800);
  assert.equal(cache.cache.has("img-1"), false);
  assert.equal(cache.cache.has("img-2"), true);
  assert.equal(cache.cache.has("img-3"), true);

  cache.clear();
});

test("cooldown ledger deletes empty buckets and prune cleans expired keys", () => {
  const ledger = new CooldownLedger();
  const now = 1000000;

  // Single use
  const res = ledger.consume({
    behavior: { operation: { cooldownMode: "perUser", cooldownOverride: 10 } },
    userId: "u1",
    threadId: "t1",
    now,
  });
  assert.equal(res.allowed, true);
  assert.equal(ledger.usage.has("u:u1"), true);

  // Consume with now + 2 hours (old timestamp pruned)
  const res2 = ledger.consume({
    behavior: { operation: { cooldownMode: "perUser", cooldownOverride: 10 } },
    userId: "u1",
    threadId: "t1",
    now: now + 2 * 3600 * 1000,
  });
  assert.equal(res2.allowed, true);

  // Prune after expiry
  ledger.prune(now + 10 * 3600 * 1000);
  assert.equal(ledger.usage.has("u:u1"), false);
});

test("link platform cache prunes entries older than 7 days and limits size", () => {
  const now = Date.now();
  const eightDaysAgo = now - 8 * 24 * 3600 * 1000;

  cacheState.data.youtube["old-yt"] = { fileUrl: "http://old", timestamp: eightDaysAgo };
  cacheState.data.youtube["new-yt"] = { fileUrl: "http://new", timestamp: now };

  pruneLinkPlatformCache(now);

  assert.equal(cacheState.data.youtube["old-yt"], undefined);
  assert.ok(cacheState.data.youtube["new-yt"]);
});

test("group info cache is bounded by LRUCache max 500", () => {
  const cache = getGroupInfoCache();
  assert.ok(cache instanceof LRUCache);
  assert.equal(cache.max, 500);
});
