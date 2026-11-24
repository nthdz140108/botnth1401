process.env.SKIP_ENV_VALIDATION = "1";

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  getGroupSettings,
  readGroupSettings,
  writeGroupSettings,
  updateGroupSettings,
  loadCanonicalGroupSettings,
  clearGroupSettingsCache,
  getCanonicalGroupSettingsPath,
} from "../src/utils/group-settings-store.js";
import { createBotRuntimeContext } from "../src/utils/bot-runtime-context.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

test("group-settings-store: preserves all representative fields across process restarts", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "group-settings-store-restart-"));
  const settingsPath = path.join(runtimeRoot, "data", "group-settings.json");
  const configPath = path.join(runtimeRoot, "admin.json");

  await fs.mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: settingsPath })
  );

  const ioJsonUrl = pathToFileURL(path.join(projectRoot, "src", "utils", "io-json.js")).href;
  const commandUrl = pathToFileURL(path.join(projectRoot, "src", "commands", "command.js")).href;

  const script1 = `
    const { readGroupSettings, writeGroupSettings } = await import(${JSON.stringify(ioJsonUrl)});
    const { initGroupSettings } = await import(${JSON.stringify(commandUrl)});

    const threadId = "thread-persist-456";
    const groupName = "Production Group";

    const settings = readGroupSettings();
    initGroupSettings(settings, threadId, groupName);

    settings[threadId].activeBot = true;
    settings[threadId].welcomeGroup = true;
    settings[threadId].antiSpam = true;
    settings[threadId].filterBadWords = true;
    settings[threadId].removeLinks = true;
    settings[threadId].muteList = { "spammer-1": { name: "Spammer", timeMute: -1 } };
    settings[threadId].whiteList = { "admin-99": { name: "VIP Owner" } };

    writeGroupSettings(settings);

    process.stdout.write("__RESULT_1__" + JSON.stringify({ ok: true }) + "__END_1__");
    setTimeout(() => process.exit(0), 50);
  `;

  const runEnv = {
    ...process.env,
    PROJECT_ROOT: projectRoot,
    CONFIG_PATH: configPath,
    BOT_ID: "admin",
    SKIP_ENV_VALIDATION: "1",
  };

  const { stdout: stdout1 } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script1], {
    cwd: projectRoot,
    env: runEnv,
    timeout: 10000,
  });
  assert.ok(stdout1.includes("__RESULT_1__"), "Process 1 should write settings");

  // Step 2: Fresh process simulating restart
  const script2 = `
    const { readGroupSettings } = await import(${JSON.stringify(ioJsonUrl)});
    const { initGroupSettings } = await import(${JSON.stringify(commandUrl)});

    const threadId = "thread-persist-456";
    const groupName = "Production Group";

    const reloaded = readGroupSettings();
    initGroupSettings(reloaded, threadId, groupName);

    process.stdout.write("__RESULT_2__" + JSON.stringify({
      threadSettings: reloaded[threadId]
    }) + "__END_2__");
    setTimeout(() => process.exit(0), 50);
  `;

  const { stdout: stdout2 } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script2], {
    cwd: projectRoot,
    env: runEnv,
    timeout: 10000,
  });

  const match2 = stdout2.match(/__RESULT_2__(.*?)__END_2__/s);
  assert.ok(match2, `Process 2 output: ${stdout2}`);
  const result2 = JSON.parse(match2[1]);
  const group = result2.threadSettings;

  assert.equal(group.activeBot, true);
  assert.equal(group.welcomeGroup, true);
  assert.equal(group.antiSpam, true);
  assert.equal(group.filterBadWords, true);
  assert.equal(group.removeLinks, true);
  assert.ok(group.muteList["spammer-1"]);
  assert.ok(group.whiteList["admin-99"]);
});

test("group-settings-store: concurrent updates do not overwrite with stale snapshot", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-settings-concurrent-"));
  const settingsPath = path.join(tempDir, "group-settings.json");
  const ctx = createBotRuntimeContext({ uid: "test-bot-conc", groupSettingsPath: settingsPath });

  clearGroupSettingsCache(ctx);

  // Initialize group 1 and group 2
  const initial = readGroupSettings(ctx);
  initial["group-A"] = { activeBot: false, antiSpam: false };
  initial["group-B"] = { activeBot: false, antiSpam: false };
  writeGroupSettings(initial, ctx);

  // Simulate two concurrent updates in parallel
  const update1 = Promise.resolve().then(() => {
    return updateGroupSettings((settings) => {
      settings["group-A"].activeBot = true;
      settings["group-A"].welcomeGroup = true;
      return settings;
    }, ctx);
  });

  const update2 = Promise.resolve().then(() => {
    return updateGroupSettings((settings) => {
      settings["group-B"].antiSpam = true;
      settings["group-B"].filterBadWords = true;
      return settings;
    }, ctx);
  });

  await Promise.all([update1, update2]);

  const finalSettings = readGroupSettings(ctx);
  assert.equal(finalSettings["group-A"].activeBot, true, "group-A activeBot should be true");
  assert.equal(finalSettings["group-A"].welcomeGroup, true, "group-A welcomeGroup should be true");
  assert.equal(finalSettings["group-B"].antiSpam, true, "group-B antiSpam should be true");
  assert.equal(finalSettings["group-B"].filterBadWords, true, "group-B filterBadWords should be true");

  // Read directly from disk file to confirm persistence
  const diskRaw = await fs.readFile(settingsPath, "utf8");
  const diskSettings = JSON.parse(diskRaw);
  assert.equal(diskSettings["group-A"].activeBot, true);
  assert.equal(diskSettings["group-B"].antiSpam, true);
});

test("group-settings-store: initGroupSettings only fills missing fields and preserves configured values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-settings-defaults-"));
  const tempSettingsPath = path.join(tempDir, "group-settings.json");
  const botsDir = path.join(tempDir, "mybot", "bots");
  await fs.mkdir(botsDir, { recursive: true });
  const configPath = path.join(botsDir, "test-bot-defaults.json");
  await fs.writeFile(configPath, JSON.stringify({ uid: "test-bot-defaults", groupSettingsPath: tempSettingsPath }));

  const commandUrl = pathToFileURL(path.join(projectRoot, "src", "commands", "command.js")).href;

  const script = `
    const { initGroupSettings } = await import(${JSON.stringify(commandUrl)});

    const settings = {
      "group-1": {
        nameGroup: "Custom Group",
        activeBot: true,
        antiSpam: true,
        activeGame: false,
        muteList: { "user-x": { name: "User X" } },
      }
    };

    initGroupSettings(settings, "group-1", "Custom Group");

    process.stdout.write("__RESULT_DEFAULTS__" + JSON.stringify({
      group1: settings["group-1"]
    }) + "__END_DEFAULTS__");
    setTimeout(() => process.exit(0), 50);
  `;

  const runEnv = {
    ...process.env,
    PROJECT_ROOT: projectRoot,
    CONFIG_PATH: configPath,
    BOT_ID: "test-bot-defaults",
    SKIP_ENV_VALIDATION: "1",
  };

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: runEnv,
    timeout: 10000,
  });

  const match = stdout.match(/__RESULT_DEFAULTS__(.*?)__END_DEFAULTS__/s);
  assert.ok(match, `Process defaults output: ${stdout}`);
  const result = JSON.parse(match[1]);
  const group = result.group1;

  assert.equal(group.activeBot, true, "Configured activeBot must remain true");
  assert.equal(group.antiSpam, true, "Configured antiSpam must remain true");
  assert.equal(group.activeGame, false, "Configured activeGame must remain false");
  assert.ok(group.muteList["user-x"], "muteList must be preserved");
  assert.equal(group.welcomeGroup, false, "Missing field welcomeGroup must be populated with default false");
  assert.equal(group.filterBadWords, false, "Missing field filterBadWords must be populated with default false");
});

test("group-settings-store: strict isolation between admin bot and child bots", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "group-settings-isolation-"));
  const adminSettingsPath = path.join(tempDir, "admin", "group-settings.json");
  const childSettingsPath = path.join(tempDir, "child-1", "group-settings.json");

  const adminCtx = createBotRuntimeContext({ uid: "admin", groupSettingsPath: adminSettingsPath });
  const childCtx = createBotRuntimeContext({ uid: "child-1", groupSettingsPath: childSettingsPath });

  clearGroupSettingsCache(adminCtx);
  clearGroupSettingsCache(childCtx);

  writeGroupSettings({ "admin-group": { activeBot: true } }, adminCtx);
  writeGroupSettings({ "child-group": { activeBot: false, antiSpam: true } }, childCtx);

  const adminRead = readGroupSettings(adminCtx);
  const childRead = readGroupSettings(childCtx);

  assert.ok(adminRead["admin-group"], "Admin settings should have admin-group");
  assert.equal(adminRead["child-group"], undefined, "Admin settings should NOT contain child-group");

  assert.ok(childRead["child-group"], "Child settings should have child-group");
  assert.equal(childRead["admin-group"], undefined, "Child settings should NOT contain admin-group");
});
