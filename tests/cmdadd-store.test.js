import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCmdaddInput } from "../src/commands/custom-commands/parser.js";
import {
  createCustomCommand,
  findCustomCommand,
  listCustomCommands,
  removeCustomCommand,
  normalizeName,
  isValidCustomName,
  isReservedCustomName,
  CUSTOM_COMMAND_PAGE_SIZE,
} from "../src/commands/custom-commands/store.js";

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmdadd-store-"));
  return root;
}

test("parser splits name and text at first pipe and preserves subsequent pipes", () => {
  const parsed = parseCmdaddInput("say | hello | world | end");
  assert.equal(parsed.kind, "create");
  assert.equal(parsed.name, "say");
  assert.equal(parsed.text, "hello | world | end");
});

test("parser accepts multiline text and lowercases name", () => {
  const parsed = parseCmdaddInput("Greeting | dòng 1\ndòng 2\nDòng 3");
  assert.equal(parsed.kind, "create");
  assert.equal(parsed.name, "greeting");
  assert.match(parsed.text, /dòng 2/);
});

test("parser rejects invalid names and reserved names", () => {
  assert.equal(parseCmdaddInput("123abc | text").kind, "invalid");
  assert.equal(parseCmdaddInput("has space | text").kind, "invalid");
  assert.equal(parseCmdaddInput("list").kind, "list");
  assert.equal(parseCmdaddInput("remove").kind, "invalid");
  assert.equal(parseCmdaddInput("help | text").kind, "invalid");
});

test("parser handles page input for list", () => {
  const parsed = parseCmdaddInput("list 2");
  assert.equal(parsed.kind, "list");
  assert.equal(parsed.page, 2);
});

test("store creates commands with stable incrementing IDs", async () => {
  const root = makeRoot();
  const first = await createCustomCommand({ name: "a", text: "x", createdBy: "u1", root });
  const second = await createCustomCommand({ name: "b", text: "y", createdBy: "u1", root });
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(findCustomCommand("a", root).id, 1);
});

test("store rejects duplicate and reserved/system names", async () => {
  const root = makeRoot();
  await createCustomCommand({ name: "hello", text: "x", createdBy: "u1", root });
  try {
    await createCustomCommand({ name: "HELLO", text: "y", createdBy: "u1", root });
    assert.fail("should reject duplicate");
  } catch (error) {
    assert.equal(error.code, "DUPLICATE_COMMAND");
  }
  try {
    await createCustomCommand({ name: "setcmd", text: "y", createdBy: "u1", root });
    assert.fail("should reject reserved name");
  } catch (error) {
    assert.equal(error.code, "RESERVED_NAME");
  }
  try {
    await createCustomCommand({ name: "123", text: "y", createdBy: "u1", root });
    assert.fail("should reject invalid name");
  } catch (error) {
    assert.equal(error.code, "INVALID_NAME");
  }
});

test("store removes by name and stable ID without reusing IDs", async () => {
  const root = makeRoot();
  const first = await createCustomCommand({ name: "a", text: "x", createdBy: "u1", root });
  await createCustomCommand({ name: "b", text: "y", createdBy: "u1", root });
  const removed = await removeCustomCommand(first.id, root);
  assert.equal(removed.id, 1);
  const third = await createCustomCommand({ name: "c", text: "z", createdBy: "u1", root });
  assert.equal(third.id, 3);
});

test("store lists commands paginated by pageSize 16", async () => {
  const root = makeRoot();
  for (let i = 0; i < 20; i++) {
    await createCustomCommand({ name: `cmd${i}`, text: `t${i}`, createdBy: "u1", root });
  }
  const page1 = listCustomCommands({ root });
  assert.equal(page1.commands.length, CUSTOM_COMMAND_PAGE_SIZE);
  assert.equal(page1.total, 20);
  assert.equal(page1.totalPages, 2);
  const page2 = listCustomCommands({ page: 2, root });
  assert.equal(page2.commands.length, 4);
});

test("normalization is Unicode NFKC and lowercase", () => {
  assert.equal(normalizeName(" ＦＯＯ "), "foo");
  assert.equal(normalizeName("Café"), "café");
  assert.equal(isValidCustomName("café_nội"), true);
});
