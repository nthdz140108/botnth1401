import test from "node:test";
import assert from "node:assert/strict";
import { commandRegistry } from "../src/commands/command-registry.js";

const ADMIN_BOX_ANTI_COMMANDS = [
  "antibadword",
  "antisetup",
  "antibot",
  "antiblockall",
  "antisdt",
  "antilink",
  "antijoin",
  "antiforward",
  "antitag",
  "antistickerlag",
  "antisticker",
  "antispam",
  "antinude",
  "antiundo",
  "antiall",
  "antitext",
  "antifile",
  "antiphoto",
  "antivoice",
  "onlytext",
  "mute",
  "unmute",
  "whitelist",
];

test("anti management commands require adminBox (group-scoped tier)", () => {
  for (const command of ADMIN_BOX_ANTI_COMMANDS) {
    const definition = commandRegistry.definitions.find((item) => item.name === command);

    assert.ok(definition, command);
    assert.equal(definition.permission, "adminBox", command);
  }
});
