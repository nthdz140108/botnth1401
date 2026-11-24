import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

import fs from "node:fs/promises";
import os from "node:os";

async function runHandler(modulePath, exportName, content) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "phase-8-test-"));
  const settingsPath = path.join(runtimeRoot, "group-settings.json");
  const configPath = path.join(runtimeRoot, "test-bot.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "test-bot", name: "test-bot", groupSettingsPath: settingsPath })
  );

  const moduleUrl = pathToFileURL(path.join(projectRoot, modulePath)).href;
  const script = `
    const module = await import(${JSON.stringify(moduleUrl)});
    const groupSettings = {};
    const message = {
      threadId: "phase-8-thread",
      type: "group",
      data: {
        content: ${JSON.stringify(content)},
        mentions: [],
        dName: "tester",
        uidFrom: "phase-8-user",
      },
    };
    const api = {
      sendMessage: async () => undefined,
      handleGroupPendingMembers: async () => undefined,
    };
    try {
      const value = await module[${JSON.stringify(exportName)}](api, message, groupSettings);
      process.stdout.write("__PHASE8_RESULT__" + JSON.stringify({ ok: true, value, groupSettings }) + "__PHASE8_END__");
    } catch (error) {
      process.stdout.write("__PHASE8_RESULT__" + JSON.stringify({ ok: false, error: error.message, groupSettings }) + "__PHASE8_END__");
    }
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SKIP_ENV_VALIDATION: "1",
      PROJECT_ROOT: projectRoot,
      CONFIG_PATH: configPath,
      BOT_ID: "test-bot",
    },
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__PHASE8_RESULT__(.*?)__PHASE8_END__/s);
  assert.ok(match, `handler subprocess did not return a result: ${stdout}`);
  return JSON.parse(match[1]);
}

const toggleHandlers = [
  ["src/service-debug/anti-service/anti-text.js", "handleAntiText", "!antitext", "antiText"],
  ["src/service-debug/anti-service/anti-file.js", "handleAntiFile", "!antifile", "antiFile"],
  ["src/service-debug/anti-service/anti-photo.js", "handleAntiPhotoVideo", "!antiphoto", "antiPhotoVideo"],
  ["src/service-debug/anti-service/anti-voice.js", "handleAntiVoice", "!antivoice", "antiVoice"],
  ["src/service-debug/anti-service/anti-not-text.js", "handleOnlyText", "!onlytext", "onlyText"],
];

test("Phase 8 toggle handlers initialize a missing group settings entry", async () => {
  for (const [modulePath, exportName, command, setting] of toggleHandlers) {
    const result = await runHandler(modulePath, exportName, command);

    assert.equal(result.ok, true, command);
    assert.equal(result.value, true, command);
    assert.equal(result.groupSettings["phase-8-thread"][setting], true, command);
  }
});

const syntaxHandlers = [
  ["src/service-debug/anti-service/anti-all.js", "handleAntiAll", "!antiall bad"],
  ["src/service-debug/anti-service/anti-text.js", "handleAntiText", "!antitext bad"],
  ["src/service-debug/anti-service/anti-file.js", "handleAntiFile", "!antifile bad"],
  ["src/service-debug/anti-service/anti-photo.js", "handleAntiPhotoVideo", "!antiphoto bad"],
  ["src/service-debug/anti-service/anti-voice.js", "handleAntiVoice", "!antivoice bad"],
];

test("Phase 8 anti syntax errors return false instead of throwing", async () => {
  for (const [modulePath, exportName, command] of syntaxHandlers) {
    const result = await runHandler(modulePath, exportName, command);

    assert.equal(result.ok, true, command);
    assert.equal(result.value, false, command);
  }
});

test("approve initializes settings before toggling a fresh group", async () => {
  const result = await runHandler(
    "src/commands/bot-manager/welcome-bye.js",
    "handleApprove",
    "!approve",
  );

  assert.equal(result.ok, true);
  assert.equal(result.value, true);
  assert.equal(result.groupSettings["phase-8-thread"].memberApprove, true);
});

test("handleActiveBotUser turns bot on and off without errors", async () => {
  const resultOn = await runHandler(
    "src/commands/bot-manager/active-bot.js",
    "handleActiveBotUser",
    "!bot on",
  );
  assert.equal(resultOn.ok, true);
  assert.equal(resultOn.value, true);
  assert.equal(resultOn.groupSettings["phase-8-thread"].activeBot, true);

  const resultOff = await runHandler(
    "src/commands/bot-manager/active-bot.js",
    "handleActiveBotUser",
    "!bot off",
  );
  assert.equal(resultOff.ok, true);
  assert.equal(resultOff.value, true);
  assert.equal(resultOff.groupSettings["phase-8-thread"].activeBot, false);
});
