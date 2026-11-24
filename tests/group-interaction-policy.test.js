import test from "node:test";
import assert from "node:assert/strict";
import {
  canInteractWithGroup,
  isGroupBotToggle,
  resolveGroupCommandPermission,
  shouldPersistGroupSettings,
} from "../src/commands/group-interaction-policy.js";

test("allows normal members when the current group is on", () => {
  assert.equal(canInteractWithGroup({ activeBot: true, isAdminBot: false }), true);
});

test("denies normal members when the current group is off", () => {
  assert.equal(canInteractWithGroup({ activeBot: false, isAdminBot: false }), false);
});

test("allows bot admins when the current group is off", () => {
  assert.equal(canInteractWithGroup({ activeBot: false, isAdminBot: true }), true);
});

test("denies group admins when the current group is off", () => {
  assert.equal(
    canInteractWithGroup({
      activeBot: false,
      isAdminBot: false,
      isAdminBox: true,
      commandParts: ["antiall", "on"],
    }),
    false,
  );
});

test("does not let group admins run normal commands while the current group is off", () => {
  assert.equal(
    canInteractWithGroup({
      activeBot: false,
      isAdminBot: false,
      isAdminBox: true,
      commandParts: ["google", "test"],
    }),
    false,
  );
});

test("anti command permission preserves adminBot runtime metadata", () => {
  assert.equal(resolveGroupCommandPermission("antibot", "adminBot"), "adminBot");
  assert.equal(resolveGroupCommandPermission("google", "adminBot"), "adminBot");
});

test("keeps group state independent because the policy only reads the current state", () => {
  const groupA = { activeBot: false };
  const groupB = { activeBot: true };

  assert.equal(canInteractWithGroup({ ...groupA, isAdminBot: false }), false);
  assert.equal(canInteractWithGroup({ ...groupB, isAdminBot: false }), true);
});

test("recognizes only group bot toggle commands", () => {
  assert.equal(isGroupBotToggle(["bot"]), true);
  assert.equal(isGroupBotToggle(["bot", "on"]), true);
  assert.equal(isGroupBotToggle(["bot", "off"]), true);
  assert.equal(isGroupBotToggle(["bot", "privatebot", "on"]), false);
  assert.equal(isGroupBotToggle(["bot", "privategame", "off"]), false);
});

test("persists registry settings only for handled changes and group bot toggles", () => {
  assert.equal(
    shouldPersistGroupSettings(["autodownload", "on"], { code: "HANDLED", value: true }),
    true,
  );
  assert.equal(
    shouldPersistGroupSettings(["autodownload", "off"], { code: "HANDLED", value: false }),
    false,
  );
  assert.equal(
    shouldPersistGroupSettings(["bot", "on"], { code: "HANDLED" }),
    true,
  );
  assert.equal(
    shouldPersistGroupSettings(["autodownload", "on"], { code: "HANDLER_ERROR" }),
    false,
  );
  assert.equal(
    shouldPersistGroupSettings(["autodownload", "on"], { code: "PERMISSION_DENIED" }),
    false,
  );
  assert.equal(
    shouldPersistGroupSettings(["autodownload", "on"], { code: "HANDLED", value: 1 }),
    false,
  );
});
