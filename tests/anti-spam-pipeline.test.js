import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

test("antispam reports handled after detecting spam", async () => {
  const moduleUrl = pathToFileURL(
    path.join(projectRoot, "src/service-debug/anti-service/anti-spam.js")
  ).href;
  const script = `
    const module = await import(${JSON.stringify(moduleUrl)});
    const api = {
      sendMessage: async () => undefined
    };
    const groupSettings = {
      "group-1": {
        antiSpam: true,
        whiteList: {}
      }
    };
    const now = Date.now();
    const makeMessage = (index) => ({
      threadId: "group-1",
      type: "group",
      data: {
        uidFrom: "user-1",
        dName: "tester",
        content: "message-" + index,
        ts: now + index
      }
    });
    const results = [];
    for (let index = 0; index < 3; index += 1) {
      results.push(await module.antiSpam(
        api,
        makeMessage(index),
        false,
        groupSettings,
        true,
        false
      ));
    }
    process.stdout.write("__RESULT__" + JSON.stringify(results) + "__END__");
    setTimeout(() => process.exit(0), 20);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      SKIP_ENV_VALIDATION: "1",
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `antispam subprocess did not return a result: ${stdout}`);
  const results = JSON.parse(match[1]);

  assert.deepEqual(results, [false, false, true]);
});
