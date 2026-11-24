const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "../../dashboard/src/components/system-workspace.jsx"), "utf8");

test("system workspace uses the provider config contract without binding masked values to inputs", () => {
  assert.match(source, /\/api\/provider-config/);
  assert.match(source, /type=["']password["']/);
  assert.match(source, /restartRequired/);
  assert.match(source, /changedKeys|dirty/);
  assert.doesNotMatch(source, /value=\{[^}]*masked/);
});

test("system workspace keeps health and backup controls", () => {
  assert.match(source, /\/api\/system\/health/);
  assert.match(source, /\/api\/system\/backup/);
  assert.match(source, /\/api\/system\/restore/);
});
