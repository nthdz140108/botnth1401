import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const testDataDir = path.join(projectRoot, ".cache", "test-qr-provisioning");

function setupTestEnv() {
  fs.mkdirSync(testDataDir, { recursive: true });
}

function cleanupTestEnv() {
  try {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  } catch {}
}

test("saveBotToMyBots saves new bot with stopped status and pending trial", async () => {
  setupTestEnv();
  try {
    const { saveBotToMyBots } = await import("../src/commands/mybot/System/pm2-manager.js");
    const testRegistryPath = path.join(testDataDir, "mybots.json");
    fs.writeFileSync(testRegistryPath, JSON.stringify({}, null, 2), "utf8");

    // Save bot using saveBotToMyBots
    const uid = "test-new-bot-123";
    const displayName = "Test User";
    const webPort = 5555;
    const expiryTime = null;

    await saveBotToMyBots(uid, displayName, webPort, expiryTime, "TestBot", "https://avatar.com/1.png", {
      registryPath: testRegistryPath,
    });

    const registry = JSON.parse(fs.readFileSync(testRegistryPath, "utf8"));
    const bot = registry[uid];

    assert.ok(bot, "Bot should exist in registry");
    assert.equal(bot.status, "stopped", "New bot status must be stopped");
    assert.equal(bot.pid, null, "pid must be null");
    assert.equal(bot.consolePid, null, "consolePid must be null");
    assert.equal(bot.trialStatus, "pending", "trialStatus must be pending");
    assert.equal(bot.trialStartedAt, null, "trialStartedAt must be null");
    assert.equal(bot.trialDurationMs, 3600000, "trialDurationMs must be 1 hour (3600000 ms)");
    assert.equal(bot.expiryAt, null, "expiryAt must be null before first start");
  } finally {
    cleanupTestEnv();
  }
});

test("existing stopped bot keeps stopped status when updated via QR", async () => {
  setupTestEnv();
  try {
    const { saveBotToMyBots } = await import("../src/commands/mybot/System/pm2-manager.js");
    const testRegistryPath = path.join(testDataDir, "mybots.json");
    
    const existing = {
      "bot-stopped-999": {
        name: "OldBot",
        displayName: "Old Name",
        status: "stopped",
        trialStatus: "pending",
        trialStartedAt: null,
        trialDurationMs: 3600000,
        expiryAt: null,
        webPort: "5556",
        database: "bot-stopped-999",
      }
    };
    fs.writeFileSync(testRegistryPath, JSON.stringify(existing, null, 2), "utf8");

    await saveBotToMyBots("bot-stopped-999", "New Name", 5556, null, "NewBotName", "https://avatar.com/new.png", {
      registryPath: testRegistryPath,
    });

    const registry = JSON.parse(fs.readFileSync(testRegistryPath, "utf8"));
    const bot = registry["bot-stopped-999"];

    assert.equal(bot.status, "stopped");
    assert.equal(bot.displayName, "New Name");
    assert.equal(bot.trialStatus, "pending");
    assert.equal(bot.expiryAt, null);
  } finally {
    cleanupTestEnv();
  }
});
