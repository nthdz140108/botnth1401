import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const testDataDir = path.join(projectRoot, ".cache", "test-persist-prefix");

function setupTestEnv() {
  fs.mkdirSync(path.join(testDataDir, "mybot", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(testDataDir, "mybot", "bots"), { recursive: true });
}

function cleanupTestEnv() {
  try {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  } catch {}
}

test("persistBotPrefix saves prefix to command config without reload, restart, or launcher invocation", async () => {
  setupTestEnv();
  try {
    const { persistBotPrefix } = await import("../src/utils/qr-login-prefix-workflow.js");
    
    const botUid = "test-prefix-bot-1";
    const commandConfigPath = path.join(testDataDir, "mybot", "json-data", `command-${botUid}.json`);
    const botConfigPath = path.join(testDataDir, "mybot", "bots", `${botUid}.json`);

    fs.writeFileSync(botConfigPath, JSON.stringify({
      name: botUid,
      commandFilePath: `mybot/json-data/command-${botUid}.json`,
    }, null, 2));

    fs.writeFileSync(commandConfigPath, JSON.stringify({
      prefix: "!",
    }, null, 2));

    // Call persistBotPrefix
    const resultPrefix = await persistBotPrefix(botUid, "?", {
      projectRoot: testDataDir,
    });

    assert.equal(resultPrefix, "?");

    const updated = JSON.parse(fs.readFileSync(commandConfigPath, "utf8"));
    assert.equal(updated.prefix, "?");
  } finally {
    cleanupTestEnv();
  }
});

test("persistBotPrefix rejects empty or whitespace-only prefix", async () => {
  const { persistBotPrefix } = await import("../src/utils/qr-login-prefix-workflow.js");
  await assert.rejects(async () => {
    await persistBotPrefix("some-bot", "   ");
  }, /Prefix không được rỗng/);
});
