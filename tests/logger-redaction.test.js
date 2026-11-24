import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLogger, redactLogEntry } from "../src/utils/logger.js";

test("redactLogEntry removes all sensitive credentials and user agents", () => {
  const input = {
    cookie: "zpw_sek=secret; zpw_ws=ws://secret",
    imei: "12345-67890-abcde",
    token: "bearer-token-123",
    credential: { password: "p@ssword", key: "super-secret" },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    user_agent: "Mozilla/5.0 custom",
    safeField: "normal-value",
    multiLine: "line 1\r\nline 2\nline 3",
  };

  const output = redactLogEntry(input);

  assert.equal(output.cookie, "[REDACTED]");
  assert.equal(output.imei, "[REDACTED]");
  assert.equal(output.token, "[REDACTED]");
  assert.equal(output.credential.password, "[REDACTED]");
  assert.equal(output.credential.key, "[REDACTED]");
  assert.equal(output.userAgent, "[REDACTED]");
  assert.equal(output.user_agent, "[REDACTED]");
  assert.equal(output.safeField, "normal-value");
  assert.equal(output.multiLine, "line 1 line 2 line 3");
});

test("logger creates valid NDJSON without double newlines and rotates on byte cap", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "logger-redaction-"));
  const logger = createLogger({
    dir: tmp,
    baseName: "audit",
    maxFileBytes: 250,
    flushIntervalMs: 10,
  });

  logger.log({ event: "event_one", text: "Some normal message line" });
  logger.log({ event: "event_two", token: "super-secret-token", cookie: "zpw_sek=xyz" });
  logger.flush();

  // Exceed byte limit to trigger rotation
  for (let i = 0; i < 10; i++) {
    logger.log({ event: `event_bulk_${i}`, padding: "a".repeat(80) });
  }
  await logger.close();

  const files = await fs.readdir(tmp);
  assert.ok(files.length >= 1, "Log files must exist");

  for (const f of files) {
    const content = await fs.readFile(path.join(tmp, f), "utf8");
    assert.ok(!content.includes("\n\n"), "Must not contain double newlines");
    const lines = content.trim().split("\n");
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.ts, "Timestamp must exist");
      if (parsed.token) assert.equal(parsed.token, "[REDACTED]");
      if (parsed.cookie) assert.equal(parsed.cookie, "[REDACTED]");
    }
  }
});
