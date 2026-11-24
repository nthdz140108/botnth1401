import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());

async function runHandler(content) {
  const moduleUrl = pathToFileURL(path.join(projectRoot, "src/service-debug/anti-service/anti-all.js")).href;
  const script = `
    const module = await import(${JSON.stringify(moduleUrl)});
    const groupSettings = {
      "group-1": {
        antiPhotoVideo: false,
        antiVoice: false,
        antiText: false,
        antiFile: false,
        antiSpam: false,
        removeLinks: false,
        enableAntiBot: false,
        filterBadWords: false,
        antiNude: false,
        enableSetup: false,
        antiMention: false,
        antiJoinLeave: false,
        onlyText: true
      }
    };
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
    try {
      const value = await module.handleAntiAll(api, message, groupSettings);
      process.stdout.write("__RESULT__" + JSON.stringify({ ok: true, value, groupSettings }) + "__END__");
    } catch (error) {
      process.stdout.write("__RESULT__" + JSON.stringify({ ok: false, error: error.message, groupSettings }) + "__END__");
    }
    process.exit(0);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROJECT_ROOT: projectRoot,
      SKIP_ENV_VALIDATION: "1",
    },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `handler subprocess did not return a result: ${stdout}`);
  return JSON.parse(match[1]);
}

test("antiall only toggles the combined anti rules and leaves antitext-onlytext untouched", async () => {
  const result = await runHandler("!antiall on");

  assert.equal(result.ok, true);
  assert.equal(result.value, true);
  assert.equal(result.groupSettings["group-1"].antiPhotoVideo, true);
  assert.equal(result.groupSettings["group-1"].antiVoice, true);
  assert.equal(result.groupSettings["group-1"].antiText, false);
  assert.equal(result.groupSettings["group-1"].onlyText, true);
});
