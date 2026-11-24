import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMAND_BEHAVIOR_SCHEMA,
  defaultBehaviorProfile,
  RESPONSE_TEMPLATE_VARIABLES,
} from "../src/dashboard/command-behavior-schema.js";

const FIELD_TYPES = new Set(["select", "number", "boolean", "text", "template", "emoji", "table"]);

function collectFields(schema) {
  return schema.groups.flatMap((group) => group.fields);
}

test("schema exposes groups operation/responses/params/restrictions", () => {
  const ids = COMMAND_BEHAVIOR_SCHEMA.groups.map((g) => g.id);
  assert.deepEqual(ids, ["operation", "responses", "params", "restrictions"]);
});

test("every field has valid type, key, label, default-compatible shape", () => {
  for (const field of collectFields(COMMAND_BEHAVIOR_SCHEMA)) {
    assert.ok(field.key, "field.key required");
    assert.ok(field.label, "field.label required");
    assert.ok(FIELD_TYPES.has(field.type), `invalid type ${field.type} for ${field.key}`);
    if (field.type === "select") assert.ok(Array.isArray(field.options) && field.options.length > 0);
    if (field.type === "table") {
      assert.ok(Array.isArray(field.columns) && field.columns.every((c) => c.key && c.label));
    }
  }
});

test("enum fields use select type (cooldownMode, logLevel, restriction mode)", () => {
  const fields = Object.fromEntries(collectFields(COMMAND_BEHAVIOR_SCHEMA).map((f) => [f.key, f]));
  assert.equal(fields["operation.cooldownMode"].type, "select");
  assert.deepEqual(fields["operation.cooldownMode"].options, ["perUser", "perThread", "global"]);
  assert.equal(fields["operation.logLevel"].options.includes("info"), true);
  assert.equal(fields["restrictions.mode"].options, undefined === null ? null : fields["restrictions.mode"].options);
  assert.deepEqual(fields["restrictions.mode"].options, ["all", "whitelist", "blacklist"]);
});

test("params group declares a dynamic table field with typed columns", () => {
  const paramsField = collectFields(COMMAND_BEHAVIOR_SCHEMA).find((f) => f.key === "params.items");
  assert.equal(paramsField.type, "table");
  const colKeys = paramsField.columns.map((c) => c.key);
  for (const expected of ["key", "type", "value", "defaultValue", "min", "max", "options", "description"]) {
    assert.ok(colKeys.includes(expected), `missing column ${expected}`);
  }
  assert.equal(paramsField.columns.find((c) => c.key === "type").control, "select");
});

test("defaultBehaviorProfile returns fresh deep defaults matching schema", () => {
  const a = defaultBehaviorProfile();
  const b = defaultBehaviorProfile();
  assert.notEqual(a, b);
  assert.notEqual(a.operation, b.operation);
  assert.equal(a.version, 1);
  assert.equal(a.operation.cooldownMode, "perUser");
  assert.equal(a.operation.killSwitch, false);
  assert.equal(a.responses.useCustomTemplates, false);
  assert.deepEqual(a.params.items, []);
  assert.equal(a.restrictions.mode, "all");
  for (const v of RESPONSE_TEMPLATE_VARIABLES) {
    assert.match(v, /^\{[a-zA-Z]+\}$/);
  }
});
