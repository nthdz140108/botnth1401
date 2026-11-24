import test from "node:test";
import assert from "node:assert/strict";
import {
  canProcessChat,
  isGroupBotActive,
} from "../src/automations/chat-access-policy.js";

test("group bot interaction requires an explicitly active group", () => {
  assert.equal(isGroupBotActive({ "group-1": { activeBot: false } }, "group-1"), false);
  assert.equal(isGroupBotActive({ "group-1": { activeBot: true } }, "group-1"), true);
});

test("ordinary members are blocked when private access is disabled", () => {
  assert.equal(canProcessChat({ chatScope: "private", privateEnabled: false }), false);
});

test("ordinary members are blocked when group access is disabled", () => {
  assert.equal(canProcessChat({ chatScope: "group", groupEnabled: false }), false);
});

test("global admins bypass both disabled chat scopes", () => {
  assert.equal(canProcessChat({ chatScope: "private", privateEnabled: false, isGlobalAdmin: true }), true);
  assert.equal(canProcessChat({ chatScope: "group", groupEnabled: false, isGlobalAdmin: true }), true);
});

test("bot and group admins bypass a disabled group scope", () => {
  assert.equal(canProcessChat({ chatScope: "group", groupEnabled: false, isBotAdmin: true }), true);
  assert.equal(canProcessChat({ chatScope: "group", groupEnabled: false, isGroupAdmin: true }), true);
});

test("command scope remains independent from chat access bypass", () => {
  assert.equal(canProcessChat({ chatScope: "group", groupEnabled: false, isGlobalAdmin: true }), true);
});
