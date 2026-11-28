import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const testDataDir = path.join(projectRoot, ".cache", "test-auto-restore");

function setupTestEnv() {
  fs.mkdirSync(path.join(testDataDir, "mybot"), { recursive: true });
}

function cleanupTestEnv() {
  try {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  } catch {}
}

// NEW POLICY: previous `status` (including `stopped`) never excludes a bot;
// only validity (expiry, credentials, port, flags) does.
test("auto-restore selects valid running bots and preserves manual stops", async () => {
  setupTestEnv();
  try {
    const { getAutoRestoreCandidates } = await import("../src/commands/mybot/System/mybot-auto-restore.js");

    const future = new Date(Date.now() + 86400_000).toISOString();
    const creds = { cookie: "c=1", imei: "imei-1" };
    const registry = {
      admin: { status: "running", webPort: "2000", expiryAt: "-1", credentials: creds },
      "bot-running-1": { status: "running", webPort: "5001", expiryAt: future, credentials: creds },
      "bot-stopped": { status: "stopped", webPort: "5003", expiryAt: future, credentials: creds },
      "bot-pending": { status: "pending", trialStatus: "pending", webPort: "5004", expiryAt: future, credentials: creds },
      "bot-expired": { status: "expired", webPort: "5005", expiryAt: "2020-01-01T00:00:00Z", credentials: creds },
      "bot-trialExpired": { status: "trialExpired", webPort: "5006", expiryAt: "2020-01-01T00:00:00Z", credentials: creds },
      "bot-rejected": { status: "rejected", webPort: "5007", expiryAt: future, credentials: creds },
    };

    const candidates = getAutoRestoreCandidates(registry);
    assert.deepEqual(candidates.map(c => c.uid).sort(), ["bot-running-1"]);
  } finally {
    cleanupTestEnv();
  }
});

test("auto-restore restores bots independently so failure of one does not block others", async () => {
  setupTestEnv();
  try {
    const { executeAutoRestore } = await import("../src/commands/mybot/System/mybot-auto-restore.js");

    const creds = { cookie: "c=1", imei: "imei-1" };
    const future = new Date(Date.now() + 86400_000).toISOString();
    const registry = {
      "bot-ok-1": { status: "running", webPort: "5001", expiryAt: future, credentials: creds },
      "bot-fail-2": { status: "running", webPort: "5002", expiryAt: future, credentials: creds },
      "bot-ok-3": { status: "running", webPort: "5003", expiryAt: future, credentials: creds },
    };

    const launched = [];
    const launcherFn = async (uid) => {
      launched.push(uid);
      if (uid === "bot-fail-2") {
        throw new Error("Port conflict on bot-fail-2");
      }
      return { success: true, pid: 1234, consolePid: 5678 };
    };

    const report = await executeAutoRestore({
      registry,
      launcherFn,
      isPortInUseFn: async () => false,
    });

    assert.equal(report.attempted.length, 3);
    assert.equal(report.succeeded.length, 2);
    assert.equal(report.failed.length, 1);
    assert.deepEqual(report.succeeded, ["bot-ok-1", "bot-ok-3"]);
    assert.equal(report.failed[0].uid, "bot-fail-2");
  } finally {
    cleanupTestEnv();
  }
});
