const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const file = path.join(__dirname, "../dashboard/src/components/command-workspace.jsx");

test("command workspace exposes all command scope options and effective scope", () => {
  const source = fs.readFileSync(file, "utf8");
  assert.match(source, /group/);
  assert.match(source, /private/);
  assert.match(source, /both/);
  assert.match(source, /effectiveScope/);
});

test("command workspace keeps override reset and apply-all scope actions", () => {
  const source = fs.readFileSync(file, "utf8");
  assert.match(source, /Reset override/);
  assert.match(source, /\/api\/commands\/apply-all/);
  assert.match(source, /scope/);
  assert.match(source, /effectiveScope/);
});
