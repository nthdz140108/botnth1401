const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const fieldsFile = path.join(__dirname, "../dashboard/src/components/fields.jsx");
const schemaFile = path.join(__dirname, "../dashboard/src/app/command-schema.js");

test("fields component covers every schema control type", () => {
  const source = fs.readFileSync(fieldsFile, "utf8");
  for (const marker of ['"select"', '"number"', '"boolean"', '"text"', '"template"', '"emoji"', '"table"']) {
    assert.ok(source.includes(marker), `missing control ${marker}`);
  }
  assert.match(source, /render-preview/);
  assert.match(source, /setValueAtPath/);
});

test("schema client caches and can force refresh", () => {
  const source = fs.readFileSync(schemaFile, "utf8");
  assert.match(source, /behavior-schema/);
  assert.match(source, /force/);
});
