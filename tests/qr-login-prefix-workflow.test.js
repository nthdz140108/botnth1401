import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  extractPrefixFromReply,
  isValidPrefix,
} from "../src/utils/qr-login-prefix-state.js";
import {
  persistBotPrefix,
  applyPrefixAndRestart,
} from "../src/utils/qr-login-prefix-workflow.js";

test("prefix parser: extracts prefix correctly when reply contains mention prefix metadata (@ThanhHung?)", () => {
  const message = {
    data: {
      content: "@ThanhHung?",
      mentions: [
        { pos: 0, len: 10, uid: "1234567890" },
      ],
    },
  };

  const res = extractPrefixFromReply(message);
  assert.equal(res.valid, true);
  assert.equal(res.prefix, "?");
});

test("prefix parser: handles mentions in front, middle, and end without offset distortion", () => {
  // Mention in middle: "! @BotName ?" -> "! ?" (fails whitespace check)
  const messageWithMiddleMention = {
    data: {
      content: "@BotUser1 / @BotUser2",
      mentions: [
        { pos: 0, len: 9, uid: "111" },
        { pos: 12, len: 9, uid: "222" },
      ],
    },
  };

  const resMiddle = extractPrefixFromReply(messageWithMiddleMention);
  assert.equal(resMiddle.valid, true);
  assert.equal(resMiddle.prefix, "/");

  // Mention at end: "!@BotUser"
  const messageWithEndMention = {
    data: {
      content: "!@BotUser",
      mentions: [
        { pos: 1, len: 8, uid: "333" },
      ],
    },
  };

  const resEnd = extractPrefixFromReply(messageWithEndMention);
  assert.equal(resEnd.valid, true);
  assert.equal(resEnd.prefix, "!");
});

test("prefix parser: rejects reply that only contains mentions (empty_or_mention_only)", () => {
  const messageOnlyMention = {
    data: {
      content: "@ThanhHung",
      mentions: [
        { pos: 0, len: 10, uid: "1234567890" },
      ],
    },
  };

  const res = extractPrefixFromReply(messageOnlyMention);
  assert.equal(res.valid, false);
  assert.equal(res.reason, "empty_or_mention_only");

  // Empty string
  const emptyMsg = { data: { content: "   " } };
  const resEmpty = extractPrefixFromReply(emptyMsg);
  assert.equal(resEmpty.valid, false);
  assert.equal(resEmpty.reason, "empty_or_mention_only");
});

test("prefix parser: rejects alphanumeric characters, whitespace, and excessive length", () => {
  // Letters
  assert.equal(extractPrefixFromReply({ data: { content: "bot" } }).valid, false);
  assert.equal(extractPrefixFromReply({ data: { content: "bot" } }).reason, "invalid_characters");

  // Numbers
  assert.equal(extractPrefixFromReply({ data: { content: "123" } }).valid, false);
  assert.equal(extractPrefixFromReply({ data: { content: "123" } }).reason, "invalid_characters");

  // Whitespace
  assert.equal(extractPrefixFromReply({ data: { content: "! ?" } }).valid, false);
  assert.equal(extractPrefixFromReply({ data: { content: "! ?" } }).reason, "contains_whitespace");

  // Too long (> 3 chars)
  assert.equal(extractPrefixFromReply({ data: { content: "!!!!" } }).valid, false);
  assert.equal(extractPrefixFromReply({ data: { content: "!!!!" } }).reason, "too_long");
});

test("prefix parser: accepts valid command symbols (1-3 chars)", () => {
  const validPrefixes = ["!", "?", "!!", "??", ".", "/", "#", "$", "%", "&", "*", "-", "_", "+", "!?"];
  for (const p of validPrefixes) {
    const res = extractPrefixFromReply({ data: { content: p } });
    assert.equal(res.valid, true, `Prefix "${p}" should be valid`);
    assert.equal(res.prefix, p);
    assert.equal(isValidPrefix(p), true);
  }
});

test("persistBotPrefix: rejects invalid prefixes and writes valid prefixes to command file", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prefix-test-"));
  try {
    const botUid = "test_bot_prefix";
    const botInfoDir = path.join(tmpDir, "mybot", "bots");
    await fs.mkdir(botInfoDir, { recursive: true });
    await fs.writeFile(
      path.join(botInfoDir, `${botUid}.json`),
      JSON.stringify({ commandFilePath: `mybot/instances/${botUid}/data/command.json` }, null, 2),
      "utf8"
    );

    // Invalid prefix throws
    await assert.rejects(async () => {
      await persistBotPrefix(botUid, "abc", { projectRoot: tmpDir });
    }, /Prefix không hợp lệ/);

    // Valid prefix writes file
    const applied = await persistBotPrefix(botUid, "?", { projectRoot: tmpDir });
    assert.equal(applied, "?");

    const cmdPath = path.join(tmpDir, "mybot", "instances", botUid, "data", "command.json");
    const cmdContent = JSON.parse(await fs.readFile(cmdPath, "utf8"));
    assert.equal(cmdContent.prefix, "?");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
