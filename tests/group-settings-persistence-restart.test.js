import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

test("Group settings and data persist across restarts without being reset", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "group-settings-restart-"));
  const settingsPath = path.join(runtimeRoot, "group-settings.json");
  const configPath = path.join(runtimeRoot, "admin.json");

  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: settingsPath })
  );

  const ioJsonUrl = pathToFileURL(path.join(projectRoot, "src", "utils", "io-json.js")).href;
  const commandUrl = pathToFileURL(path.join(projectRoot, "src", "commands", "command.js")).href;

  // Step 1: Initialize group and change settings in process 1
  const script1 = `
    const { readGroupSettings, writeGroupSettings } = await import(${JSON.stringify(ioJsonUrl)});
    const { initGroupSettings } = await import(${JSON.stringify(commandUrl)});

    const threadId = "thread-persist-123";
    const groupName = "My Persistent Group";

    const settings = readGroupSettings();
    initGroupSettings(settings, threadId, groupName);

    settings[threadId].activeBot = true;
    settings[threadId].welcomeGroup = true;
    settings[threadId].antiLink = true;
    settings[threadId].filterBadWords = true;
    settings[threadId].muteList = { "user-1": { name: "Spammer", timeMute: -1 } };
    settings[threadId].whiteList = { "admin-1": { name: "Owner" } };

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
  assert.ok(stdout1.includes("__RESULT_1__"), "Process 1 should succeed");

  // Step 2: Restart fresh in a new process (simulating CMD restart)
  const script2 = `
    const { readGroupSettings } = await import(${JSON.stringify(ioJsonUrl)});
    const { initGroupSettings } = await import(${JSON.stringify(commandUrl)});

    const threadId = "thread-persist-123";
    const groupName = "My Persistent Group";

    // Read settings fresh
    const reloaded = readGroupSettings();

    // Call initGroupSettings as event-send-msg does on every incoming message
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
  assert.ok(match2, `Process 2 did not return expected result: ${stdout2}`);
  const result2 = JSON.parse(match2[1]);
  const group = result2.threadSettings;

  assert.ok(group, "Group settings should exist in restarted process");
  assert.equal(group.activeBot, true, "activeBot must remain true");
  assert.equal(group.welcomeGroup, true, "welcomeGroup must remain true");
  assert.equal(group.antiLink, true, "antiLink must remain true");
  assert.equal(group.filterBadWords, true, "filterBadWords must remain true");
  assert.ok(group.muteList["user-1"], "muteList must be preserved");
  assert.ok(group.whiteList["admin-1"], "whiteList must be preserved");
});
