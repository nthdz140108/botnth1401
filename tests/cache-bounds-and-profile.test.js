import { test } from "node:test";
import assert from "node:assert/strict";
import { getResourceProfile } from "../src/utils/resource-profile.js";
import { ImageBufferCache } from "../src/utils/image-buffer-cache.js";
import { createMessageCacheStore } from "../src/utils/message-cache.js";
import { getCachedJson, setCachedJson, publicApiCache, clearPublicApiCache } from "../src/utils/public-api-cache.js";
import { phase1Registry, phase2Registry, phase11Registry } from "../src/commands/command-registry.js";

test("resource-profile: defaults to compat and applies lean limits when configured or canary", () => {
  // 1. Defaults safely to compat
  const origProfile = process.env.MYBOT_RESOURCE_PROFILE;
  const origCanary = process.env.MYBOT_LEAN_BOT_KEYS;
  delete process.env.MYBOT_RESOURCE_PROFILE;
  delete process.env.MYBOT_LEAN_BOT_KEYS;

  try {
    const defaultProfile = getResourceProfile("main");
    assert.equal(defaultProfile.isLean, false);
    assert.equal(defaultProfile.profile, "compat");
    assert.equal(defaultProfile.imageBufferMaxBytes, 64 * 1024 * 1024);
    assert.equal(defaultProfile.messageCacheMaxEntries, 20000);

    // 2. Canary lean bot
    process.env.MYBOT_LEAN_BOT_KEYS = "bot-canary,other-bot";
    const canaryProfile = getResourceProfile("bot-canary");
    assert.equal(canaryProfile.isLean, true);
    assert.equal(canaryProfile.profile, "lean");
    assert.equal(canaryProfile.imageBufferMaxBytes, 16 * 1024 * 1024);
    assert.equal(canaryProfile.messageCacheMaxEntries, 5000);

    // 3. Explicit lean profile
    process.env.MYBOT_RESOURCE_PROFILE = "lean";
    const mainLean = getResourceProfile("main");
    assert.equal(mainLean.isLean, true);
    assert.equal(mainLean.imageBufferMaxBytes, 32 * 1024 * 1024);
    assert.equal(mainLean.messageCacheMaxEntries, 10000);
    assert.equal(mainLean.publicApiCacheMaxEntries, 500);

    const childLean = getResourceProfile("bot-1");
    assert.equal(childLean.isLean, true);
    assert.equal(childLean.imageBufferMaxBytes, 16 * 1024 * 1024);
    assert.equal(childLean.messageCacheMaxEntries, 5000);
  } finally {
    if (origProfile !== undefined) process.env.MYBOT_RESOURCE_PROFILE = origProfile;
    else delete process.env.MYBOT_RESOURCE_PROFILE;
    if (origCanary !== undefined) process.env.MYBOT_LEAN_BOT_KEYS = origCanary;
    else delete process.env.MYBOT_LEAN_BOT_KEYS;
  }
});

test("image-buffer-cache: buffers larger than maxBytes are not cached", async () => {
  const cache = new ImageBufferCache({ maxBytes: 1024, ttlMs: 60000 });
  
  // Smaller buffer gets cached
  const smallBuf = Buffer.alloc(500);
  cache.setBuffer("small", smallBuf);
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().totalBytes, 500);

  // Buffer larger than 1024 cap is ignored
  const largeBuf = Buffer.alloc(2000);
  cache.setBuffer("large", largeBuf);
  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().totalBytes, 500);
});

test("message-cache: store respects profile limit", () => {
  const origProfile = process.env.MYBOT_RESOURCE_PROFILE;
  try {
    process.env.MYBOT_RESOURCE_PROFILE = "lean";
    const fakeContext = {
      uid: "test-child-bot",
      botName: "child-bot",
      messageJsonPath: ""
    };
    const store = createMessageCacheStore(fakeContext);
    assert.equal(store.lru.max, 5000);

    process.env.MYBOT_RESOURCE_PROFILE = "compat";
    const compatStore = createMessageCacheStore({
      uid: "test-child-compat",
      botName: "child-compat",
      messageJsonPath: ""
    });
    assert.equal(compatStore.lru.max, 20000);
  } finally {
    if (origProfile !== undefined) process.env.MYBOT_RESOURCE_PROFILE = origProfile;
    else delete process.env.MYBOT_RESOURCE_PROFILE;
  }
});

test("public-api-cache: is bounded and supports set/get/clear", () => {
  clearPublicApiCache();
  assert.ok(publicApiCache.max >= 500 && publicApiCache.max <= 2000);

  setCachedJson("test-provider", "https://api.test/data", { foo: "bar" }, 5000);
  const cached = getCachedJson("test-provider", "https://api.test/data");
  assert.deepEqual(cached, { foo: "bar" });

  clearPublicApiCache();
  assert.equal(getCachedJson("test-provider", "https://api.test/data"), null);
});

test("command-registry: heavy AI commands are defined with lazy handlers", () => {
  const geminiMake = phase1Registry.definitions.find((d) => d.name === "gemini make");
  assert.ok(geminiMake);
  assert.equal(typeof geminiMake.handler, "function");

  const createImage = phase2Registry.definitions.find((d) => d.name === "create-image");
  assert.ok(createImage);
  assert.equal(typeof createImage.handler, "function");

  const stickerAi = phase11Registry.definitions.find((d) => d.name === "sticker ai");
  assert.ok(stickerAi);
  assert.equal(typeof stickerAi.handler, "function");
});
