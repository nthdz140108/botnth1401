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

async function runHandler(modulePath, exportName, content) {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anti-command-persistence-"));
  const moduleUrl = pathToFileURL(path.join(projectRoot, modulePath)).href;
  const settingsPath = path.join(runtimeRoot, "group-settings.json");
  const configPath = path.join(runtimeRoot, "admin.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ uid: "admin", name: "admin", groupSettingsPath: settingsPath })
  );
  const script = `
    const fs = await import("node:fs");
    const module = await import(${JSON.stringify(moduleUrl)});
    fs.rmSync(${JSON.stringify(settingsPath)}, { force: true });
    const groupSettings = {};
    const message = {
      threadId: "group-1",
      type: "group",
      data: {
        content: ${JSON.stringify(content)},
        mentions: [],
        dName: "tester",
        uidFrom: "user-1"
      }
    };
    const api = {
      sendMessage: async () => undefined
    };
    const value = await module[${JSON.stringify(exportName)}](api, message, groupSettings);
    process.stdout.write("__RESULT__" + JSON.stringify({
      value,
      groupSettings,
      fileExists: fs.existsSync(${JSON.stringify(settingsPath)})
    }) + "__END__");
    setTimeout(() => process.exit(0), 20);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      CONFIG_PATH: configPath,
      BOT_ID: "admin",
      SKIP_ENV_VALIDATION: "1",
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `handler subprocess did not return a result: ${stdout}`);
  return JSON.parse(match[1]);
}

for (const [modulePath, exportName, content, setting] of [
  [
    "src/service-debug/anti-service/anti-join-leave.js",
    "handleAntiJoinLeaveCommand",
    "!antijoin on",
    "antiJoinLeave",
  ],
  [
    "src/service-debug/anti-service/anti-kick-all.js",
    "handleAntiKickBlockCommand",
    "!antiblockall on",
    "antiKickBlock",
  ],
]) {
  test(`${exportName} mutates settings without persisting them directly`, async () => {
    const result = await runHandler(modulePath, exportName, content);

    assert.equal(result.value, true);
    assert.equal(result.groupSettings["group-1"][setting], true);
    assert.equal(result.fileExists, false);
  });
}
