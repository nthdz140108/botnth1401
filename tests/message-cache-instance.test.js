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

test("message cache writes inside the current bot instance", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "message-cache-instance-"));
  await fs.mkdir(path.join(runtimeRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "assets"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "logs"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "mybot", "bots"), { recursive: true });
  await fs.writeFile(
    path.join(runtimeRoot, "mybot", "bots", "bot-a.json"),
    JSON.stringify({ uid: "bot-a", name: "bot-a" })
  );

  const moduleUrl = pathToFileURL(path.join(projectRoot, "src/utils/message-cache.js")).href;
  const instancePath = path.join(
    runtimeRoot,
    "mybot",
    "instances",
    "bot-a",
    "logs",
    "message.json"
  );
  const globalPath = path.join(runtimeRoot, "logs", "message.json");
  const script = `
    const fs = await import("node:fs");
    const module = await import(${JSON.stringify(moduleUrl)});
    module.writeMessageJson({ cached: true });
    process.stdout.write("__RESULT__" + JSON.stringify({
      instanceExists: fs.existsSync(${JSON.stringify(instancePath)}),
      globalExists: fs.existsSync(${JSON.stringify(globalPath)})
    }) + "__END__");
    setTimeout(() => process.exit(0), 20);
  `;

  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PROJECT_ROOT: runtimeRoot,
      BOT_ID: "bot-a",
      SKIP_ENV_VALIDATION: "1",
    },
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  const match = stdout.match(/__RESULT__(.*?)__END__/s);
  assert.ok(match, `message cache subprocess did not return a result: ${stdout}`);
  const result = JSON.parse(match[1]);

  assert.equal(result.instanceExists, true);
  assert.equal(result.globalExists, false);
});

test("message cache write-behind preserves >5,000 messages on LRU eviction and allows disk undo", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "message-cache-eviction-"));
  const messageJsonPath = path.join(runtimeRoot, "message.json");
  const { createMessageCacheStore } = await import("../src/utils/message-cache.js");

  // Create child bot store (limit 5,000 entries)
  const store = createMessageCacheStore({
    uid: "test-child",
    botName: "test-child",
    messageJsonPath,
    maxEntries: 5000,
  });

  assert.equal(store.lru.max, 5000);

  // Insert 5,200 messages before any flush
  const baseTs = Date.now() - 60_000;
  for (let i = 1; i <= 5200; i++) {
    store.update({
      data: {
        msgId: `msg-${i}`,
        cliMsgId: `cli-${i}`,
        content: `Hello ${i}`,
        ts: baseTs + i,
      },
      threadId: "thread-1",
    });
  }

  // LRU holds 5,000 messages; messages 1..200 have been evicted from LRU
  assert.equal(store.lru.size, 5000);
  assert.equal(store.lru.has("cli-1"), false);

  // Flush to disk
  store.flush();

  // Disk must contain all 5,200 messages!
  const disk = store.readDisk();
  assert.equal(Object.keys(disk).length, 5200);
  assert.ok(disk["cli-1"]);
  assert.equal(disk["cli-1"].content, "Hello 1");

  // Create a fresh store to simulate bot restart or cache reload
  const freshStore = createMessageCacheStore({
    uid: "test-child-fresh",
    botName: "test-child-fresh",
    messageJsonPath,
    maxEntries: 5000,
  });

  // Verify message 1 (evicted in previous store) is retrieved from disk
  const msg1 = freshStore.getByMsgId("msg-1");
  assert.ok(msg1, "message-1 must be retrievable from disk");
  assert.equal(msg1.content, "Hello 1");
  assert.equal(msg1.isUndo, false);

  // Perform markUndo on the old message
  const undoResult = freshStore.markUndo("msg-1");
  assert.equal(undoResult, true);
  freshStore.flush();

  // Read back from disk to verify undo was persisted
  const updatedDisk = freshStore.readDisk();
  assert.equal(updatedDisk["cli-1"].isUndo, true);

  await fs.rm(runtimeRoot, { recursive: true, force: true });
});
