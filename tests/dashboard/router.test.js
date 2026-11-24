import test from "node:test";
import assert from "node:assert/strict";
import { navigate, parseHashRoute, routeToHash } from "../../dashboard/src/app/router.js";

test("parses canonical and legacy dashboard hashes", () => {
  assert.deepEqual(parseHashRoute("#overview"), { workspace: "overview" });
  assert.deepEqual(parseHashRoute("#bots/fleet"), { workspace: "bots", tab: "fleet" });
  assert.deepEqual(parseHashRoute("#groups/settings"), { workspace: "chat-access", tab: "settings" });
  assert.deepEqual(parseHashRoute("#system/logs"), { workspace: "system", tab: "logs" });
  assert.deepEqual(parseHashRoute("#qr-login"), { workspace: "bots", tab: "qr-login" });
  assert.deepEqual(parseHashRoute("#automation/commands"), { workspace: "commands", tab: "commands" });
  assert.deepEqual(parseHashRoute("#security/policies"), { workspace: "system", tab: "flags" });
});

test("supports entity routes and safe hash navigation", () => {
  const route = { workspace: "bots", entityId: "bot/one", tab: "config" };
  assert.deepEqual(parseHashRoute(routeToHash(route)), route);
  const location = { hash: "" };
  assert.deepEqual(navigate({ workspace: "chat-access", entityId: "g 1", tab: "settings" }, location), { workspace: "chat-access", entityId: "g 1", tab: "settings" });
  assert.equal(location.hash, "#chat-access/g%201/settings");
});
