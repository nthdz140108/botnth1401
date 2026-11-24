const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const file = path.join(__dirname, "../dashboard/src/components/command-workspace.jsx");
const source = () => fs.readFileSync(file, "utf8");

test("studio keeps legacy actions and adds behavior endpoints", () => {
  const s = source();
  assert.match(s, /apply-all/);
  assert.match(s, /copy-from-admin/);
  assert.match(s, /Reset override/);
  assert.match(s, /behavior/);
  assert.match(s, /command-config\/reload/);
});

test("studio renders five detail tabs from schema groups", () => {
  const s = source();
  for (const tab of ["Tổng quan", "Vận hành", "Phản hồi", "Tham số", "Giới hạn"]) {
    assert.ok(s.includes(tab), `missing tab ${tab}`);
  }
  assert.match(s, /SchemaGroup/);
});

test("studio tracks dirty state before saving", () => {
  assert.match(source(), /dirty/i);
});
