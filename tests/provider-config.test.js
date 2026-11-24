import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadProviderEnvironment } from "../src/bootstrap.js";
import { dispatchCommand } from "../src/commands/command-dispatcher.js";
import { createPhase3Registry } from "../src/commands/command-registry.js";
import { readProviderConfig, updateProviderConfig } from "../src/dashboard/provider-config-service.js";
import { getZaloCookiePayload, getZaloRuntimeConfig } from "../src/api-zalo/zalo-config.js";
import { createProviderError, normalizeProviderFailure, PROVIDER_ERROR_CODES, withProviderRetry } from "../src/dashboard/provider-adapter.js";

const PROVIDER_ENV_NAMES = [
  "GEMINI_API_KEYS", "SIMSIMI_API_KEY", "OPENWEATHER_API_KEY", "WEATHERAPI_KEY", "TOMORROW_API_KEY",
  "HOANGDEV_API_KEY", "TIKTOK_COOKIE", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_DOWNLOADER_SECRET", "SPOTIFY_DOWNLOADER_PASSPHRASE", "TENOR_API_KEY", "REMOVE_BG_API_KEY",
  "ZINGMP3_API_KEY", "ZINGMP3_SECRET_KEY", "ZALO_WEB_URL", "ZALO_ORIGIN", "ZALO_REFERER", "ZALO_USER_AGENT",
];

async function fixture({ local = "", env = "" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-config-"));
  if (local) await fs.writeFile(path.join(root, ".env.local"), local);
  if (env) await fs.writeFile(path.join(root, ".env"), env);
  return root;
}

function withoutProviderProcessEnv(fn) {
  const previous = Object.fromEntries(PROVIDER_ENV_NAMES.map((key) => [key, process.env[key]]));
  for (const key of PROVIDER_ENV_NAMES) delete process.env[key];
  return Promise.resolve().then(fn).finally(() => {
    for (const key of PROVIDER_ENV_NAMES) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("reads masked provider state without returning raw values", async () => {
  await withoutProviderProcessEnv(async () => {
    const root = await fixture({
      local: "GEMINI_API_KEYS=test-gemini-value\nCUSTOM_FLAG=keep\n",
      env: "TENOR_API_KEY=test-tenor-fallback\n",
    });
    const result = await readProviderConfig(root);
    assert.deepEqual(result.keys.find((item) => item.name === "GEMINI_API_KEYS"), {
      name: "GEMINI_API_KEYS", configured: true, masked: "********",
    });
    assert.deepEqual(result.keys.find((item) => item.name === "TENOR_API_KEY"), {
      name: "TENOR_API_KEY", configured: true, masked: "********",
    });
    assert.equal(JSON.stringify(result).includes("test-gemini-value"), false);
    assert.equal(JSON.stringify(result).includes("test-tenor-fallback"), false);
    assert.equal(result.health.gemini.status, "healthy");
    assert.equal(result.health["gpt-deepseek"].status, "missing");
  });
});

test("process environment wins over local and fallback files", async () => {
  await withoutProviderProcessEnv(async () => {
    const root = await fixture({ local: "TENOR_API_KEY=local\n", env: "TENOR_API_KEY=fallback\n" });
    process.env.TENOR_API_KEY = "process";
    const result = await readProviderConfig(root);
    assert.equal(result.keys.find((item) => item.name === "TENOR_API_KEY").configured, true);
  });
});

test("updates only whitelisted keys, removes empty keys, and preserves other entries", async () => {
  await withoutProviderProcessEnv(async () => {
    const root = await fixture({ local: "# keep this comment\nCUSTOM_FLAG=keep\nTENOR_API_KEY=old\n" });
    const result = await updateProviderConfig(root, {
      TENOR_API_KEY: "new-tenor",
      GEMINI_API_KEYS: "",
    });
    const saved = await fs.readFile(path.join(root, ".env.local"), "utf8");
    assert.match(saved, /# keep this comment/);
    assert.match(saved, /CUSTOM_FLAG=keep/);
    assert.match(saved, /TENOR_API_KEY=new-tenor/);
    assert.doesNotMatch(saved, /GEMINI_API_KEYS=/);
    assert.deepEqual(result.changedKeys, ["TENOR_API_KEY"]);
    assert.equal(result.restartRequired, true);
    assert.ok(result.backup?.file);
    assert.equal(await fs.readFile(result.backup.file, "utf8"), "# keep this comment\nCUSTOM_FLAG=keep\nTENOR_API_KEY=old\n");
  });
});

test("rejects unknown keys and non-string values before writing", async () => {
  await withoutProviderProcessEnv(async () => {
    const root = await fixture({ local: "CUSTOM_FLAG=keep\n" });
    await assert.rejects(
      () => updateProviderConfig(root, { NOT_A_PROVIDER: "x" }),
      (error) => error.code === "PROVIDER_CONFIG_INVALID" && error.status === 400,
    );
    await assert.rejects(
      () => updateProviderConfig(root, { TENOR_API_KEY: 42 }),
      (error) => error.code === "PROVIDER_CONFIG_INVALID" && error.status === 400,
    );
    assert.equal(await fs.readFile(path.join(root, ".env.local"), "utf8"), "CUSTOM_FLAG=keep\n");
  });
});

test("creates a new local env file when no local file exists", async () => {
  await withoutProviderProcessEnv(async () => {
    const root = await fixture({ env: "TENOR_API_KEY=fallback\n" });
    const result = await updateProviderConfig(root, { TENOR_API_KEY: "local" });
    assert.equal(result.backup, null);
    assert.match(await fs.readFile(path.join(root, ".env.local"), "utf8"), /TENOR_API_KEY=local/);
  });
});

test("normalizes provider failures and retries retryable errors", async () => {
  const timeoutError = normalizeProviderFailure(new Error("Request timed out"), "gemini", "req-1");
  assert.equal(timeoutError.code, PROVIDER_ERROR_CODES.TIMEOUT);
  assert.equal(timeoutError.provider, "gemini");
  assert.equal(timeoutError.correlationId, "req-1");
  assert.equal(timeoutError.status, 504);

  let attempts = 0;
  const result = await withProviderRetry(async () => {
    attempts += 1;
    if (attempts < 2) throw createProviderError(PROVIDER_ERROR_CODES.TIMEOUT, "timeout", { provider: "gemini" });
    return "ok";
  }, { provider: "gemini", retries: 2, timeoutMs: 20, retryDelayMs: 1 });
  assert.equal(result, "ok");
  assert.equal(attempts, 2);
});

test("configured .env.local values reach provider dispatch after bootstrap", async () => {
  await withoutProviderProcessEnv(async () => {
    const root = await fixture({ local: "TENOR_API_KEY=local-tenor\n" });
    loadProviderEnvironment({ root });
    const result = await dispatchCommand({
      commandParts: ["gifmeme", "sample"],
      scope: "group",
      config: process.env,
      dbReady: true,
      dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
    }, createPhase3Registry({ gifmeme: async () => "ok" }));
    assert.equal(result.code, "HANDLED");
    assert.equal(result.value, "ok");
  });
});

test("zalo runtime config reads safe overrides without exposing raw values", () => {
  const config = getZaloRuntimeConfig({
    ZALO_WEB_URL: "https://example.test",
    ZALO_ORIGIN: "https://origin.test",
    ZALO_REFERER: "https://ref.test/",
    ZALO_USER_AGENT: "TestAgent/1.0",
  });
  assert.deepEqual(config, {
    webUrl: "https://example.test",
    origin: "https://origin.test",
    referer: "https://ref.test/",
    userAgent: "TestAgent/1.0",
  });

  const payload = getZaloCookiePayload({ cookies: [{ name: "sid", value: "abc" }] }, { ZALO_WEB_URL: "https://example.test" });
  assert.deepEqual(payload, {
    url: "https://example.test",
    cookies: [{ name: "sid", value: "abc" }],
  });
});

test("provider-independent commands still dispatch with an empty config", async () => {
  const result = await dispatchCommand({
    commandParts: ["gif"],
    scope: "private",
    config: {},
    dbReady: true,
    dependencies: { zaloSession: true, ffmpeg: true, ffprobe: true },
  }, createPhase3Registry({ gif: async () => "ok" }));
  assert.equal(result.code, "HANDLED");
  assert.equal(result.value, "ok");
});
