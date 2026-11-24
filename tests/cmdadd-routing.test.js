import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { commandRegistry, createCommandRegistryForPhases, PHASE_11_COMMANDS } from "../src/commands/command-registry.js";
import { resolveCommand } from "../src/commands/command-router.js";
import { resolveCommandPartsToCustom } from "../src/commands/custom-commands/resolver.js";
import { createCustomCommand } from "../src/commands/custom-commands/store.js";
import { handleCmdaddCommand, invokeCustomCommand } from "../src/commands/custom-commands/cmdadd-command.js";
import { MEDIA_KIND_IMAGE } from "../src/commands/custom-commands/media-constants.js";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cmdadd-router-"));
}

test("cmdadd is registered as a main-only adminLevelHigh command", () => {
  const def = commandRegistry.definitions.find((d) => d.name === "cmdadd");
  assert.ok(def, "cmdadd must be in registry");
  assert.equal(def.permission, "adminLevelHigh");
  assert.equal(def.instanceScope, "main");
  assert.equal(def.scope, "both");
  assert.equal(def.countdown, 30);
  assert.ok(PHASE_11_COMMANDS.includes("cmdadd"));
});

test("cmdadd is present in the aggregate registry exactly once", () => {
  const names = commandRegistry.definitions.map((d) => d.name);
  assert.equal(names.filter((n) => n === "cmdadd").length, 1);
});

test("system command wins over a conflicting custom command", async () => {
  const root = makeRoot();
  try {
    await createCustomCommand({ name: "help", text: "custom text", createdBy: "u1", root });
    assert.fail("reserved name should be rejected");
  } catch (error) {
    assert.equal(error.code, "RESERVED_NAME");
  }
});

test("resolver only resolves UNKNOWN_COMMAND to a custom command", async () => {
  const root = makeRoot();
  await createCustomCommand({ name: "greet", text: "Xin chào", createdBy: "u1", root });

  const registryMatch = resolveCommand(["greet"], commandRegistry);
  assert.equal(registryMatch.code, "UNKNOWN_COMMAND");
  const custom = resolveCommandPartsToCustom(registryMatch, ["greet"], root);
  assert.equal(custom.code, "RESOLVED_CUSTOM");
  assert.equal(custom.custom.name, "greet");
});

test("resolver does not resolve known system commands or cmdadd", async () => {
  const root = makeRoot();
  const helpMatch = resolveCommand(["help"], commandRegistry);
  assert.equal(resolveCommandPartsToCustom(helpMatch, ["help"], root), null);
  const cmdaddMatch = resolveCommand(["cmdadd", "list"], commandRegistry);
  assert.equal(resolveCommandPartsToCustom(cmdaddMatch, ["cmdadd", "list"], root), null);
});

test("invokeCustomCommand sends styled text through api.sendMessage", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload, threadId, type) {
      sent.push({ payload, threadId, type });
      return { message: {} };
    },
  };
  const message = { threadId: "t1", type: 1, data: { uidFrom: "u1", senderName: "User" } };
  const custom = { name: "greet", text: "Xin chào mọi người", media: null };
  await invokeCustomCommand(api, message, custom, { root: makeRoot() });
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.msg, /Xin chào mọi người/);
});

test("handleCmdaddCommand rejects non-cmdadd create for reserved subcommand name", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload, threadId, type) {
      sent.push({ payload, threadId, type });
      return { message: {} };
    },
  };
  const message = { threadId: "t1", type: 1, data: { uidFrom: "u1" } };
  const result = await handleCmdaddCommand(api, message, ["cmdadd", "remove"], { root: makeRoot() });
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.msg, /Thiếu tên hoặc ID/);
  assert.equal(typeof result, "undefined");
});

function imageCommand() {
  return {
    name: "hinh",
    text: "ảnh đẹp nha",
    media: { kind: MEDIA_KIND_IMAGE, path: path.join(os.tmpdir(), "cmdadd-router-image.jpg") },
  };
}

test("image command sends styled text first, then a separate image-only message", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload, threadId, type) {
      sent.push({ payload, threadId, type });
      return { message: {} };
    },
  };
  const message = { threadId: "t1", type: 1, data: { uidFrom: "u1", senderName: "User" } };
  const ok = await invokeCustomCommand(api, message, imageCommand(), { root: makeRoot(), botName: "MyBot" });
  assert.equal(ok, true);
  assert.equal(sent.length, 2);

  const [textMsg, imageMsg] = sent.map((s) => s.payload);
  assert.match(textMsg.msg, /MyBot/);
  assert.match(textMsg.msg, /ảnh đẹp nha/);
  assert.ok(textMsg.style, "first message must carry styled payload");
  assert.equal(textMsg.quote, message);
  assert.equal(textMsg.attachments, undefined);

  assert.equal(imageMsg.msg, "");
  assert.deepEqual(imageMsg.attachments, [imageCommand().media.path]);
  assert.equal(imageMsg.quote, undefined);
  assert.equal(imageMsg.style, undefined);
  assert.equal(imageMsg.ttl, 180000);
});

test("image send failure keeps the styled text as the only content sent", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload, threadId, type) {
      sent.push({ payload, threadId, type });
      if (payload.attachments) throw new Error("upload failed");
      return { message: {} };
    },
  };
  const message = { threadId: "t1", type: 1, data: { uidFrom: "u1", senderName: "User" } };
  const ok = await invokeCustomCommand(api, message, imageCommand(), { root: makeRoot(), botName: "MyBot" });
  assert.equal(ok, true);
  assert.equal(sent.length, 2);
  const styledTexts = sent.filter((s) => s.payload.style);
  assert.equal(styledTexts.length, 1, "styled text must not be re-sent after image failure");
  assert.match(styledTexts[0].payload.msg, /ảnh đẹp nha/);
});

test("image command without media.path still returns styled text only", async () => {
  const sent = [];
  const api = {
    async sendMessage(payload, threadId, type) {
      sent.push({ payload, threadId, type });
      return { message: {} };
    },
  };
  const message = { threadId: "t1", type: 1, data: { uidFrom: "u1", senderName: "User" } };
  const custom = { name: "hinh", text: "ảnh đẹp nha", media: { kind: MEDIA_KIND_IMAGE } };
  const ok = await invokeCustomCommand(api, message, custom, { root: makeRoot(), botName: "MyBot" });
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].payload.style);
  assert.match(sent[0].payload.msg, /MyBot/);
  assert.match(sent[0].payload.msg, /ảnh đẹp nha/);
});
