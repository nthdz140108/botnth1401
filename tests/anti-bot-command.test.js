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

async function runHandler(content, initialSettings = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anti-bot-command-"));
  const moduleUrl = pathToFileURL(
    path.join(projectRoot, "src/service-debug/anti-service/anti-bot.js")
  ).href;
  const outputPath = path.join(cwd, "groupSettings.json");
  const script = `
    const fs = await import("node:fs");
    const module = await import(${JSON.stringify(moduleUrl)});
    const groupSettings = ${JSON.stringify(initialSettings)};
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
    const value = await module.handleAntiBotCommand(api, message, groupSettings);
    process.stdout.write("__RESULT__" + JSON.stringify({
      value,
      groupSettings,
      fileExists: fs.existsSync(${JSON.stringify(outputPath)})
    }) + "__END__");
    setTimeout(() => process.exit(0), 20);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      SKIP_ENV_VALIDATION: "1",
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `antibot subprocess did not return a result: ${stdout}`);
  return JSON.parse(match[1]);
}

test("antibot supports explicit on and does not persist outside the router", async () => {
  const result = await runHandler("!antibot on");

  assert.equal(result.value, true);
  assert.equal(result.groupSettings["group-1"].enableAntiBot, true);
  assert.equal(result.fileExists, false);
});

test("antibot rejects invalid syntax without changing settings", async () => {
  const initialSettings = {
    "group-1": {
      enableAntiBot: false,
    },
  };
  const result = await runHandler("!antibot maybe", initialSettings);

  assert.equal(result.value, false);
  assert.deepEqual(result.groupSettings, initialSettings);
  assert.equal(result.fileExists, false);
});

test("antibot exempts configured admins and whitelisted members", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anti-bot-enforcement-"));
  const moduleUrl = pathToFileURL(
    path.join(projectRoot, "src/service-debug/anti-service/anti-bot.js")
  ).href;
  const script = `
    const module = await import(${JSON.stringify(moduleUrl)});
    let blocks = 0;
    const api = {
      appContext: { uid: "bot-1" },
      getGroupInfo: async () => ({
        gridInfoMap: {
          "group-1": {
            creatorId: "owner-1",
            adminIds: []
          }
        }
      }),
      sendMessage: async () => undefined,
      blockUsers: async () => {
        blocks += 1;
      }
    };
    const makeMessage = (uidFrom) => ({
      threadId: "group-1",
      type: "group",
      data: {
        content: "hello",
        msgType: "webchat",
        dName: "tester",
        uidFrom,
        ttl: 5000
      }
    });
    const groupSettings = {
      "group-1": {
        enableAntiBot: true,
        whiteList: {
          "white-1": { name: "white" }
        }
      }
    };
    const adminResult = await module.antiBotCheck(
      api,
      makeMessage("admin-1"),
      groupSettings,
      true,
      false
    );
    const whitelistResult = await module.antiBotCheck(
      api,
      makeMessage("white-1"),
      groupSettings,
      false,
      false
    );
    process.stdout.write("__RESULT__" + JSON.stringify({
      adminResult,
      whitelistResult,
      blocks
    }) + "__END__");
    setTimeout(() => process.exit(0), 20);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd,
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      SKIP_ENV_VALIDATION: "1",
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `antibot enforcement subprocess did not return a result: ${stdout}`);
  const result = JSON.parse(match[1]);

  assert.equal(result.adminResult, false);
  assert.equal(result.whitelistResult, false);
  assert.equal(result.blocks, 0);
});
