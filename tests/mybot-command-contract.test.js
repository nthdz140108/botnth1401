import test from "node:test";
import assert from "node:assert/strict";
import { parseMyBotCommand } from "../src/commands/mybot/System/mybot-parser.js";

test("mybot command contract handles all standard subcommands and aliases", () => {
  // create / login
  const cmdCreate = parseMyBotCommand({ content: "!mybot create imei_123 session_456" });
  assert.equal(cmdCreate.action, "create");
  assert.equal(cmdCreate.valid, true);

  // active
  const cmdActive = parseMyBotCommand({ content: "!mybot active" });
  assert.equal(cmdActive.action, "active");
  assert.equal(cmdActive.valid, true);

  // showinfo
  const cmdShowinfo = parseMyBotCommand({ content: "!mybot showinfo" });
  assert.equal(cmdShowinfo.action, "showinfo");
  assert.equal(cmdShowinfo.valid, true);

  // shutdown / stop
  const cmdShutdown = parseMyBotCommand({ content: "!mybot shutdown" });
  assert.equal(cmdShutdown.action, "stop");
  assert.equal(cmdShutdown.valid, true);

  // set field aliases
  const setPlatform = parseMyBotCommand({ content: "!mybot set platform zalo" });
  assert.equal(setPlatform.action, "set");
  assert.equal(setPlatform.setField, "typePlatform");
  assert.equal(setPlatform.setValue, "zalo");

  const setInfo = parseMyBotCommand({ content: "!mybot set info Bot VIP 2026" });
  assert.equal(setInfo.action, "set");
  assert.equal(setInfo.setField, "botInfo");
  assert.equal(setInfo.setValue, "Bot VIP 2026");

  // invalid subcommand
  const invalidSub = parseMyBotCommand({ content: "!mybot unknownCommand" });
  assert.equal(invalidSub.valid, false);
  assert.equal(invalidSub.action, "unknown");
});

test("mybot active command parser only accepts self selector or parses selector for enforcement", () => {
  const activeSelf = parseMyBotCommand({ content: "!mybot active" });
  assert.equal(activeSelf.action, "active");
  assert.equal(activeSelf.selector.type, "self");

  const activeExplicit = parseMyBotCommand({ content: "!mybot active 1" });
  assert.equal(activeExplicit.action, "active");
  assert.equal(activeExplicit.selector.type, "index");
  assert.equal(activeExplicit.selector.value, 1);

  const activeAll = parseMyBotCommand({ content: "!mybot active all" });
  assert.equal(activeAll.action, "active");
  assert.equal(activeAll.selector.type, "all");
});
