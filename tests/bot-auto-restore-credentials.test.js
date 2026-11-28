import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auto-restore credential-source regression tests.
 *
 * Production bug: QR login stores credentials at `mybot/credentials/<uid>.json`,
 * NOT inside the registry entry. The old `hasValidCredentials` only looked at
 * `botInfo.credentials` / flat `cookie`/`imei` fields, so a real QR bot whose
 * registry carried no secrets was never restored by `run.bat`.
 *
 * These tests verify that a registry with NO inline secret but a valid
 * credential FILE is still restored, and that every malformed/missing file
 * variant is rejected (fail-closed).
 */

async function loadPolicy() {
  return import("../src/commands/mybot/System/mybot-auto-restore.js");
}

const FUTURE = new Date(Date.now() + 86400_000).toISOString();

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-creds-"));
  fs.mkdirSync(path.join(root, "mybot", "credentials"), { recursive: true });
  return root;
}

function validRegistryEntry(uid, overrides = {}) {
  return {
    uid,
    status: "stopped",
    desiredStatus: "running",
    webPort: "5311",
    expiryAt: FUTURE,
    enabled: true,
    ...overrides,
  };
}

test("registry without inline secret but valid mybot/credentials/<uid>.json is restored", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-file-creds";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: { data: { c: "abc" } }, imei: "imei-999" }), "utf8");

  const registry = { [uid]: validRegistryEntry(uid, { configFilePath: `mybot/credentials/${uid}.json` }) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.deepEqual(candidates.map((c) => c.uid), [uid]);
});

test("registry with only a uid (no configFilePath) still resolves canonical QR credential path", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "user-12345";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: "c=1", imei: "imei-1" }), "utf8");

  const registry = { [uid]: validRegistryEntry(uid) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.deepEqual(candidates.map((c) => c.uid), [uid]);
});

test("missing cookie file -> rejected (fail-closed)", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-no-file";
  const registry = { [uid]: validRegistryEntry(uid) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("cookie file present but missing imei -> rejected", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-no-imei";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: "c=1" }), "utf8");
  const registry = { [uid]: validRegistryEntry(uid) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("cookie file present but missing cookie -> rejected", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-no-cookie";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ imei: "imei-1" }), "utf8");
  const registry = { [uid]: validRegistryEntry(uid) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("malformed JSON credential file -> rejected (fail-closed)", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-bad-json";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`), "{not-json", "utf8");
  const registry = { [uid]: validRegistryEntry(uid) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("empty cookie/imei in file -> rejected (fail-closed)", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-empty-creds";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: "", imei: "" }), "utf8");
  const registry = { [uid]: validRegistryEntry(uid) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("legacy inline credentials (no files) still work when projectRoot omitted", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const registry = {
    "bot-inline": validRegistryEntry("bot-inline", { credentials: { cookie: "c=1", imei: "i=1" } }),
  };
  const candidates = getAutoRestoreCandidates(registry);
  assert.deepEqual(candidates.map((c) => c.uid), ["bot-inline"]);
});

test("inline credentials take precedence over a broken credential file", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-inline-wins";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`), "{bad", "utf8");
  const registry = {
    [uid]: validRegistryEntry(uid, { credentials: { cookie: "c=1", imei: "i=1" } }),
  };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.deepEqual(candidates.map((c) => c.uid), [uid]);
});

test("trialStatus pending is skipped even with valid credential file", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-trial-pending";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: "c=1", imei: "i=1" }), "utf8");
  const registry = { [uid]: validRegistryEntry(uid, { trialStatus: "pending" }) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("disabled/rejected/deleted never restored even with valid file", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-disabled";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: "c=1", imei: "i=1" }), "utf8");
  const registry = { [uid]: validRegistryEntry(uid, { enabled: false }) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.equal(candidates.length, 0);
});

test("expiryAt '-1' stored as string is permanent and restored", async () => {
  const { getAutoRestoreCandidates } = await loadPolicy();
  const root = makeTmpRoot();
  const uid = "bot-permanent";
  fs.writeFileSync(path.join(root, "mybot", "credentials", `${uid}.json`),
    JSON.stringify({ cookie: "c=1", imei: "i=1" }), "utf8");
  const registry = { [uid]: validRegistryEntry(uid, { expiryAt: "-1" }) };
  const candidates = getAutoRestoreCandidates(registry, { projectRoot: root });
  assert.deepEqual(candidates.map((c) => c.uid), [uid]);
});
