import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  consumeRestartRequest,
  getRestartRequestPath,
  markRestartRequestNotified,
  readRestartRequest,
  writeRestartRequest,
} from "../src/utils/restart-request.js";
import { requestRestartForBot, resolveRestartBotId } from "../src/utils/util.js";

test("restart requests stay isolated per bot and are consumed once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "restart-request-"));
  writeRestartRequest("bot-a", { threadId: "thread-a" }, root);
  writeRestartRequest("bot-b", { threadId: "thread-b" }, root);

  assert.equal(readRestartRequest("bot-a", root).threadId, "thread-a");
  assert.equal(readRestartRequest("bot-b", root).threadId, "thread-b");

  const consumed = consumeRestartRequest("bot-a", root);
  assert.equal(consumed.status, "consumed");
  assert.equal(readRestartRequest("bot-a", root).status, "consumed");
  assert.equal(consumeRestartRequest("bot-a", root), null);
  assert.equal(markRestartRequestNotified("bot-a", root).status, "consumed");
  assert.equal(readRestartRequest("bot-a", root).notifiedAt !== undefined, true);
  await assert.doesNotReject(() => fs.stat(getRestartRequestPath("bot-b", root)));
});

test("command restart resolves the current bot instead of hard-coding admin", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "command-restart-"));
  const target = resolveRestartBotId({ is_main_bot: false }, { BOT_NAME: "bot-b" });
  assert.equal(target, "bot-b");
  assert.deepEqual(requestRestartForBot(target, { threadId: "thread-b" }, { root }), {
    uid: "bot-b",
    mode: "managed-process",
  });
  assert.equal(readRestartRequest("bot-b", root).threadId, "thread-b");

  assert.deepEqual(requestRestartForBot("admin", {}, { root }), {
    uid: "admin",
    mode: "launcher",
  });
  assert.equal(await fs.readFile(path.join(root, ".bot-action"), "utf8"), "restart");
});
