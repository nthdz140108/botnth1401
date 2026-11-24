const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const routerUrl = pathToFileURL(path.join(__dirname, "../dashboard/public/js/core/router.js")).href;
const appRouterUrl = pathToFileURL(path.join(__dirname, "../dashboard/src/app/router.js")).href;

test("router maps legacy hashes to the six-workspace routes", async () => {
  const { resolveRoute } = await import(routerUrl);
  assert.deepEqual(resolveRoute("dashboard"), { route: "overview", page: "dashboard" });
  assert.deepEqual(resolveRoute("bot-management"), { route: "bots/fleet", page: "bot-management" });
  assert.deepEqual(resolveRoute("commands"), { route: "automation/commands", page: "commands" });
  assert.deepEqual(resolveRoute("sender"), { route: "messaging/compose", page: "sender" });
  assert.deepEqual(resolveRoute("anti"), { route: "groups/protection", page: "anti" });
  assert.deepEqual(resolveRoute("logs"), { route: "system/logs", page: "logs" });
});

test("router maps the chat access workspace", async () => {
  const { parseHashRoute, routeToHash } = await import(appRouterUrl);
  assert.deepEqual(parseHashRoute("#chat-access"), { workspace: "chat-access" });
  assert.equal(routeToHash({ workspace: "chat-access" }), "#chat-access");
});
