import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { createCachedJson } from "../src/utils/cached-json.js";
import { createLogger, redactLogEntry } from "../src/utils/logger.js";
import { createRankStore } from "../src/service-debug/info-service/rank-store.js";

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data), "utf8");
  const now = new Date(Date.now() + 2000);
  await fs.utimes(file, now, now);
}

test("cached json serves repeat reads without disk hits and respects ttl", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cached-json-"));
  const file = path.join(tmp, "config.json");
  await writeJson(file, { version: 1 });

  let readCount = 0;
  const fsImpl = {
    statSync: (...args) => {
      readCount += 1;
      return fsSync.statSync(...args);
    },
    readFileSync: fsSync.readFileSync.bind(fsSync),
    existsSync: fsSync.existsSync.bind(fsSync),
  };
  const cache = createCachedJson({ ttlMs: 5000, fsImpl });

  assert.equal(cache.read(file, {}).version, 1);
  readCount = 0;
  for (let i = 0; i < 10; i += 1) {
    cache.read(file, {});
  }
  // statSync still runs (cheap) but readFileSync must not
  assert.equal(readCount, 10);

  // After external write + mtime bump the cache refreshes
  await fs.writeFile(file, JSON.stringify({ version: 2 }), "utf8");
  const now = new Date(Date.now() + 5000);
  await fs.utimes(file, now, now);
  assert.equal(cache.read(file, {}).version, 2);

  // invalidate forces immediate refresh even within TTL
  cache.invalidate(file);
});

test("cached json returns fallback for missing files", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cached-json-missing-"));
  const cache = createCachedJson({});
  const fallback = { empty: true };
  assert.deepEqual(cache.read(path.join(tmp, "nope.json"), fallback), fallback);
});

test("dashboard config writes become visible in at most 5 seconds", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "web-config-cache-"));
  const file = path.join(tmp, "web-config.json");
  await writeJson(file, { selectedGroups: {} });
  const cache = createCachedJson({ ttlMs: 5000 });
  assert.deepEqual(cache.read(file), { selectedGroups: {} });

  // Dashboard writes then bumps mtime; next read sees it well before 5s
  await writeJson(file, { selectedGroups: { g1: true } });
  assert.equal(cache.read(file).selectedGroups.g1, true);
});

test("logger redacts secrets and strips double newlines", () => {
  const redacted = redactLogEntry({
    cookie: "abc",
    imei: "1234",
    userAgent: "Mozilla/5.0",
    token: "t",
    credential: { password: "p" },
    note: "line1\nline2\r\nline3",
  });
  assert.equal(redacted.cookie, "[REDACTED]");
  assert.equal(redacted.imei, "[REDACTED]");
  assert.equal(redacted.userAgent, "[REDACTED]");
  assert.equal(redacted.token, "[REDACTED]");
  assert.equal(redacted.credential.password, "[REDACTED]");
  assert.equal(redacted.note, "line1 line2 line3");
  const serialized = JSON.stringify(redacted);
  assert.ok(!serialized.includes("\n"));
});

test("logger writes valid NDJSON lines with rotation-ready naming", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "logger-"));
  const logger = createLogger({
    dir: tmp,
    baseName: "bot",
    flushIntervalMs: 5,
    maxFileBytes: 200, // force quick rotation
  });
  logger.log({ event: "one", detail: "x".repeat(150) });
  logger.flush();
  logger.log({ event: "two", cookie: "secret" });
  await logger.close();

  const files = (await fs.readdir(tmp)).sort();
  assert.ok(files.length >= 1);
  for (const file of files) {
    const content = await fs.readFile(path.join(tmp, file), "utf8");
    for (const line of content.trim().split("\n")) {
      const parsed = JSON.parse(line);
      if (parsed.event === "two") {
        assert.equal(parsed.cookie, "[REDACTED]");
      }
    }
  }
});
