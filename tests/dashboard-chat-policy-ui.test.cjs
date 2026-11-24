const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const root = path.join(__dirname, "../dashboard/src");

test("chat access navigation and components are present", async () => {
  const navigation = await import(pathToFileURL(path.join(root, "app/navigation.js")).href);
  assert.ok(navigation.DASHBOARD_VIEWS.some((item) => item.id === "chat-access"));
  assert.ok(fs.existsSync(path.join(root, "components/chat-policy-panel.jsx")));
  assert.ok(fs.existsSync(path.join(root, "components/chat-access-workspace.jsx")));
});

test("shared chat policy panel owns refresh, save, validation, and restart states", () => {
  const source = fs.readFileSync(path.join(root, "components/chat-policy-panel.jsx"), "utf8");
  assert.match(source, /\/api\/bots\/\$\{encodeURIComponent\(botId\)\}\/chat-policy/);
  assert.match(source, /groupEnabled/);
  assert.match(source, /privateEnabled/);
  assert.match(source, /restartRequired/);
  assert.match(source, /role="alert"/);
});

test("chat policy panel is embedded in dedicated and bot workspaces", () => {
  const main = fs.readFileSync(path.join(root, "main.jsx"), "utf8");
  const botWorkspace = fs.readFileSync(path.join(root, "components/bot-workspace.jsx"), "utf8");
  assert.match(main, /ChatAccessWorkspace/);
  assert.match(botWorkspace, /ChatPolicyPanel/);
});
