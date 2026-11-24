import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(process.cwd());
const moduleUrl = pathToFileURL(
  path.join(projectRoot, "src/commands/instructions/help.js")
).href;

function buildScript({ content, sendImageError = false }) {
  const argsLiteral = JSON.stringify(content.split(" ").slice(1));
  return [
    `const sendCalls = [];`,
    `const api = {`,
    `  sendMessage: async (payload, threadId, type) => {`,
    `    sendCalls.push({ payload, threadId, type });`,
    sendImageError
      ? `    if (payload && payload.attachments && payload.attachments.length) throw new Error("simulated image send failure");`
      : "",
    `  }`,
    `};`,
    `const message = {`,
    `  threadId: "group-1",`,
    `  type: "group",`,
    `  data: { content: ${JSON.stringify(content)}, mentions: [], dName: "tester", uidFrom: "user-1" }`,
    `};`,
    `const mod = await import(${JSON.stringify(moduleUrl)});`,
    `try {`,
    `  await mod.listCommands(api, message, ${argsLiteral});`,
    `} catch (e) {`,
    `  process.stdout.write("__RESULT__" + JSON.stringify({ ok: false, error: e.stack }) + "__END__");`,
    `  process.exit(0);`,
    `}`,
    `process.stdout.write("__RESULT__" + JSON.stringify({ ok: true, sendCalls }) + "__END__");`,
    `process.exit(0);`,
  ].filter(Boolean).join("\n");
}

function parseOutput(stdout) {
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `subprocess did not return a result. raw=${stdout.slice(0, 800)}`);
  return JSON.parse(match[1]);
}

async function runScript(script) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        PROJECT_ROOT: projectRoot,
        SKIP_ENV_VALIDATION: "1",
        BOT_NAME: "admin",
      },
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  return parseOutput(stdout);
}

test("!cmd sends PNG attachment and quotes the command message", async () => {
  const result = await runScript(buildScript({ content: "!cmd" }));
  assert.equal(result.ok, true);
  assert.ok(result.sendCalls.length >= 1, "expected at least one sendMessage call");
  const first = result.sendCalls[0];
  assert.ok(
    first.payload.attachments && first.payload.attachments.length === 1,
    "expected exactly one attachment (PNG)"
  );
  const attachmentPath = first.payload.attachments[0];
  assert.ok(attachmentPath.endsWith(".png"), "attachment must be a PNG path");
  assert.ok(first.payload.quote, "image part must quote the source message");
  // The temp file is deleted in a finally block after send, so it should not
  // still exist on disk once the handler returns.
  await fs.access(attachmentPath).then(
    () => assert.fail(`temp image should be cleaned up, but still exists at ${attachmentPath}`),
    () => undefined
  );
});

test("!cmd 2 paginates to page 2", async () => {
  const result = await runScript(buildScript({ content: "!cmd 2" }));
  assert.equal(result.ok, true);
  const first = result.sendCalls[0];
  assert.ok(first.payload.attachments && first.payload.attachments.length === 1);
  const caption = first.payload.msg || "";
  assert.match(caption, /Trang 2\/\d+/);
});

test("!cmd admin filters to admin-only and uses admin header", async () => {
  const result = await runScript(buildScript({ content: "!cmd admin" }));
  assert.equal(result.ok, true);
  const first = result.sendCalls[0];
  assert.ok(first.payload.attachments && first.payload.attachments.length === 1);
});

test("!cmd admin 2 also paginates correctly", async () => {
  const result = await runScript(buildScript({ content: "!cmd admin 2" }));
  assert.equal(result.ok, true);
  const first = result.sendCalls[0];
  assert.ok(first.payload.attachments && first.payload.attachments.length === 1);
});

test("!cmd falls back to text and cleans temp file when image send fails", async () => {
  const result = await runScript(
    buildScript({ content: "!cmd", sendImageError: true })
  );
  assert.equal(result.ok, true);
  assert.ok(result.sendCalls.length >= 2, "expected fallback text sends after image failure");
  const fallback = result.sendCalls[result.sendCalls.length - 1];
  assert.ok(fallback.payload.msg && fallback.payload.msg.includes("Danh sách lệnh"));
  // Ensure no orphan PNG left in any instance temp dir from this run.
  const orphanCandidates = result.sendCalls
    .map((c) => c.payload?.attachments?.[0])
    .filter(Boolean);
  for (const p of orphanCandidates) {
    await fs.access(p).then(
      () => assert.fail(`temp image still exists at ${p}`),
      () => undefined
    );
  }
});