import test from "node:test";
import assert from "node:assert/strict";
import { parseMyBotCommand } from "../src/commands/mybot/System/mybot-parser.js";

test("parseMyBotCommand parses valid cmd with index selector", () => {
  const res = parseMyBotCommand({ content: "!mybot cmd 2 <admin add qtv @user>" });
  assert.equal(res.action, "cmd");
  assert.equal(res.valid, true);
  assert.deepEqual(res.selector, { type: "index", value: 2 });
  assert.equal(res.commandText, "admin add qtv @user");
  assert.equal(res.rawCommandText, "<admin add qtv @user>");
});

test("parseMyBotCommand parses valid cmd with UID selector", () => {
  const res = parseMyBotCommand({ content: "!mebot cmd 123456789012345 <help>", aliasCommand: "mebot" });
  assert.equal(res.action, "cmd");
  assert.equal(res.valid, true);
  assert.deepEqual(res.selector, { type: "uid", value: "123456789012345" });
  assert.equal(res.commandText, "help");
  assert.equal(res.rawCommandText, "<help>");
});

test("parseMyBotCommand rejects cmd without brackets", () => {
  const res = parseMyBotCommand({ content: "!mybot cmd 2 admin add qtv @user" });
  assert.equal(res.action, "cmd");
  assert.equal(res.valid, false);
  assert.equal(res.errorReason, "missing_or_invalid_brackets");
});

test("parseMyBotCommand rejects cmd missing closing bracket", () => {
  const res = parseMyBotCommand({ content: "!mybot cmd 2 <admin add qtv @user" });
  assert.equal(res.action, "cmd");
  assert.equal(res.valid, false);
  assert.equal(res.errorReason, "missing_or_invalid_brackets");
});

test("parseMyBotCommand rejects cmd missing opening bracket", () => {
  const res = parseMyBotCommand({ content: "!mybot cmd 2 admin add qtv @user>" });
  assert.equal(res.action, "cmd");
  assert.equal(res.valid, false);
  assert.equal(res.errorReason, "missing_or_invalid_brackets");
});

test("parseMyBotCommand rejects cmd missing selector", () => {
  const res = parseMyBotCommand({ content: "!mybot cmd <admin add qtv @user>" });
  assert.equal(res.action, "cmd");
  assert.equal(res.valid, false);
  assert.equal(res.errorReason, "missing_selector");
});

test("parseMyBotCommand rejects empty payload", () => {
  const res1 = parseMyBotCommand({ content: "!mybot cmd 2 <>" });
  assert.equal(res1.action, "cmd");
  assert.equal(res1.valid, false);
  assert.equal(res1.errorReason, "empty_payload");

  const res2 = parseMyBotCommand({ content: "!mybot cmd 2 <   >" });
  assert.equal(res2.action, "cmd");
  assert.equal(res2.valid, false);
  assert.equal(res2.errorReason, "empty_payload");
});
