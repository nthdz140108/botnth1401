import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const testDataDir = path.join(projectRoot, ".cache", "test-trial-lifecycle");

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

test("activatePendingTrial transitions pending trial to active and sets 1 hour expiryAt atomically", async () => {
  setupTestEnv();
  try {
    const { activatePendingTrial } = await import("../src/commands/mybot/System/mybot-trial.js");
    const testRegistryPath = path.join(testDataDir, "mybot", "mybots.json");

    const now = 1700000000000;
    const initialRegistry = {
      "bot-trial-1": {
        name: "TrialBot",
        displayName: "Trial Bot",
        status: "stopped",
        trialStatus: "pending",
        trialStartedAt: null,
        trialDurationMs: 3600000,
        expiryAt: null,
      }
    };
    fs.writeFileSync(testRegistryPath, JSON.stringify(initialRegistry, null, 2), "utf8");

    const updated = await activatePendingTrial("bot-trial-1", {
      registryPath: testRegistryPath,
      now,
    });

    assert.equal(updated.trialStatus, "active");
    assert.equal(updated.status, "running");
    assert.equal(updated.trialStartedAt, new Date(now).toISOString());
    assert.equal(updated.expiryAt, new Date(now + 3600000).toISOString());

    const onDisk = JSON.parse(fs.readFileSync(testRegistryPath, "utf8"))["bot-trial-1"];
    assert.equal(onDisk.trialStatus, "active");
    assert.equal(onDisk.status, "running");
    assert.equal(onDisk.expiryAt, new Date(now + 3600000).toISOString());
  } finally {
    cleanupTestEnv();
  }
});

test("revertFailedTrialReactivation restores trialStatus to pending and expiryAt to null on start failure", async () => {
  setupTestEnv();
  try {
    const { revertFailedTrialReactivation } = await import("../src/commands/mybot/System/mybot-trial.js");
    const testRegistryPath = path.join(testDataDir, "mybot", "mybots.json");

    const initialRegistry = {
      "bot-failed-trial": {
        name: "FailedTrialBot",
        displayName: "Failed Trial Bot",
        status: "starting",
        trialStatus: "activating",
        trialStartedAt: null,
        trialDurationMs: 3600000,
        expiryAt: null,
      }
    };
    fs.writeFileSync(testRegistryPath, JSON.stringify(initialRegistry, null, 2), "utf8");

    const updated = await revertFailedTrialReactivation("bot-failed-trial", {
      registryPath: testRegistryPath,
    });

    assert.equal(updated.trialStatus, "pending");
    assert.equal(updated.status, "stopped");
    assert.equal(updated.expiryAt, null);

    const onDisk = JSON.parse(fs.readFileSync(testRegistryPath, "utf8"))["bot-failed-trial"];
    assert.equal(onDisk.trialStatus, "pending");
    assert.equal(onDisk.status, "stopped");
    assert.equal(onDisk.expiryAt, null);
  } finally {
    cleanupTestEnv();
  }
});

test("existing bot with expiryAt preserves its expiry duration and does not re-migrate trial", async () => {
  setupTestEnv();
  try {
    const { activatePendingTrial } = await import("../src/commands/mybot/System/mybot-trial.js");
    const testRegistryPath = path.join(testDataDir, "mybot", "mybots.json");

    const fixedExpiry = "2026-12-31T23:59:59.000Z";
    const initialRegistry = {
      "bot-legacy-paid": {
        name: "PaidBot",
        displayName: "Paid Bot",
        status: "stopped",
        expiryAt: fixedExpiry,
      }
    };
    fs.writeFileSync(testRegistryPath, JSON.stringify(initialRegistry, null, 2), "utf8");

    const updated = await activatePendingTrial("bot-legacy-paid", {
      registryPath: testRegistryPath,
      now: Date.now(),
    });

    assert.equal(updated.expiryAt, fixedExpiry, "Existing expiryAt must be preserved");
    assert.equal(updated.status, "running");
  } finally {
    cleanupTestEnv();
  }
});
