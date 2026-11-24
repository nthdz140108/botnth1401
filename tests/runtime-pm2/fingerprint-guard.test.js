import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFingerprintCommit, isProcessStale } from "../../src/runtime/runtime-fingerprint.js";

test("parseFingerprintCommit extracts the last commit value", () => {
  const line = '[RUNTIME FINGERPRINT] root="C:/x" | entry="src/bootstrap.js" | bot="admin" | pid=42 | commit="abc1234"\n';
  assert.equal(parseFingerprintCommit(line), "abc1234");
  assert.equal(parseFingerprintCommit("no fingerprint here"), null);
  assert.equal(parseFingerprintCommit(""), null);
  assert.equal(parseFingerprintCommit(null), null);
});

test("parseFingerprintCommit returns the most recent fingerprint line", () => {
  const text = [
    '[RUNTIME FINGERPRINT] pid=1 | commit="aaaaaaa"\n',
    "some log noise\n",
    '[RUNTIME FINGERPRINT] pid=2 | commit="bbbbbbb"\n',
  ].join("");
  assert.equal(parseFingerprintCommit(text), "bbbbbbb");
});

test("isProcessStale: online app running an older commit is stale", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  mkdirSync(path.join(root, "logs", "admin"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "admin", "runtime.log"),
    '[RUNTIME FINGERPRINT] pid=1 | commit="oldcommit"\n',
    "utf8",
  );
  const result = await isProcessStale({
    root,
    pm2Name: "admin",
    currentCommit: "newcomm1",
  });
  assert.equal(result.stale, true);
  assert.equal(result.observedCommit, "oldcommit");
});

test("isProcessStale: current commit is not stale", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  mkdirSync(path.join(root, "logs", "admin"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "admin", "runtime.log"),
    '[RUNTIME FINGERPRINT] pid=1 | commit="abc1234"\n',
    "utf8",
  );
  const result = await isProcessStale({ root, pm2Name: "admin", currentCommit: "abc1234" });
  assert.equal(result.stale, false);
  assert.equal(result.observedCommit, "abc1234");
});

test("isProcessStale: full SHA current commit matches short fingerprint", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  mkdirSync(path.join(root, "logs", "admin"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "admin", "runtime.log"),
    '[RUNTIME FINGERPRINT] pid=1 | commit="abc1234"\n',
    "utf8",
  );
  const result = await isProcessStale({
    root, pm2Name: "admin", currentCommit: "abc1234deadbeef",
  });
  assert.equal(result.stale, false);
});

test("isProcessStale: missing telemetry is never stale", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  const result = await isProcessStale({ root, pm2Name: "ghost", currentCommit: "abc1234" });
  assert.equal(result.stale, false);
  assert.equal(result.observedCommit, null);
});

test("isProcessStale: null currentCommit disables the guard", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  mkdirSync(path.join(root, "logs", "admin"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "admin", "runtime.log"),
    '[RUNTIME FINGERPRINT] pid=1 | commit="oldcommit"\n',
    "utf8",
  );
  const result = await isProcessStale({ root, pm2Name: "admin", currentCommit: null });
  assert.equal(result.stale, false);
});

test("isProcessStale: child bot fingerprint found via logs/bot-stdout.log fallback", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fp-guard-"));
  mkdirSync(path.join(root, "logs"), { recursive: true });
  writeFileSync(
    path.join(root, "logs", "bot-stdout.log"),
    '[RUNTIME FINGERPRINT] pid=1 | commit="oldcommit"\n',
    "utf8",
  );
  const result = await isProcessStale({ root, pm2Name: "user-123", currentCommit: "newcomm1" });
  assert.equal(result.stale, true);
  assert.equal(result.observedCommit, "oldcommit");
});

test("isProcessStale: injectable IO overrides are honored", async () => {
  const result = await isProcessStale({
    root: "ignored",
    pm2Name: "admin",
    currentCommit: "newcomm1",
    readLogDirs: () => ["admin"],
    readLogText: () => '[RUNTIME FINGERPRINT] commit="oldcommit"\n',
  });
  assert.equal(result.stale, true);
});
