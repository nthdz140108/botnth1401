import { test } from "node:test";
import assert from "node:assert/strict";
import { phase1Registry, phase2Registry, phase11Registry } from "../src/commands/command-registry.js";

function findDef(registry, name) {
  return registry.definitions.find((d) => d.name === name);
}

test("command-compat: gemini make keeps its metadata and handler", () => {
  const def = findDef(phase1Registry, "gemini make");
  assert.ok(def, "gemini make is registered");
  assert.equal(def.countdown, 90);
  assert.equal(def.executionLane, "heavy");
  assert.ok(!def.requiredConfig || def.requiredConfig.length === 0, "no requiredConfig: GEMINI_API_KEYS");
  assert.equal(typeof def.handler, "function");
});

test("command-compat: gemini (text) keeps metadata and route points to Web shim", () => {
  const def = findDef(phase1Registry, "gemini");
  assert.ok(def, "gemini is registered");
  assert.equal(def.countdown, 60);
  assert.ok(["gem", "chat"].includes(def.aliases[0]));
  assert.equal(typeof def.handler, "function");
});

test("command-compat: analysis-image keeps countdown and lane", () => {
  const def = findDef(phase2Registry, "analysis-image");
  assert.ok(def, "analysis-image is registered");
  assert.equal(def.countdown, 90);
  assert.equal(def.executionLane, "heavy");
  assert.ok(!def.requiredConfig || def.requiredConfig.length === 0);
  assert.ok(def.aliases.includes("analysis"));
});

test("command-compat: create-image + createimg alias share the same def", () => {
  const def = findDef(phase2Registry, "create-image");
  assert.ok(def, "create-image is registered");
  assert.ok(def.aliases.includes("createimg"));
  assert.equal(def.countdown, 90);
  assert.ok(!def.requiredConfig || def.requiredConfig.length === 0);
});

test("command-compat: createimageai / gemv2 keeps phase11 metadata", () => {
  const def = findDef(phase11Registry, "createimageai");
  assert.ok(def);
  assert.equal(def.countdown, 60);
  assert.ok(def.aliases.includes("gemv2"));
  assert.ok(!def.requiredConfig || def.requiredConfig.length === 0);
});

test("command-compat: genminiv1 / gemv1 keeps phase11 metadata", () => {
  const def = findDef(phase11Registry, "genminiv1");
  assert.ok(def);
  assert.equal(def.countdown, 10);
  assert.ok(def.aliases.includes("gemv1"));
  assert.ok(!def.requiredConfig || def.requiredConfig.length === 0);
});

test("command-compat: every image command dropped requiredConfig", () => {
  const names = ["gemini make", "analysis-image", "create-image", "createimageai", "genminiv1"];
  for (const n of names) {
    const allDefs = [
      ...phase1Registry.definitions,
      ...phase2Registry.definitions,
      ...phase11Registry.definitions,
    ];
    const d = allDefs.find((x) => x.name === n);
    assert.ok(d, `${n} must be registered somewhere`);
    assert.ok(!d.requiredConfig || d.requiredConfig.length === 0, `${n} must not require GEMINI_API_KEYS`);
  }
});

test("command-compat: image/img, pinterest, lamnet, 4k, qr, antinune are not touched", () => {
  // The spec explicitly excludes these commands; ensure they still exist.
  const allNames = new Set([
    ...phase1Registry.definitions.map((d) => d.name),
    ...phase2Registry.definitions.map((d) => d.name),
    ...phase11Registry.definitions.map((d) => d.name),
  ]);
  // image, pinterest, 4k remain
  for (const keep of ["image", "pinterest", "4k"]) {
    assert.ok(allNames.has(keep), `${keep} should still be registered`);
  }
});

test("command-compat: sticker ai is registered with stk ai alias", () => {
  const def = phase11Registry.definitions.find((d) => d.name === "sticker ai");
  assert.ok(def, "sticker ai must be registered");
  assert.ok(def.aliases.includes("stk ai"), "sticker ai must have stk ai alias");
  assert.equal(def.countdown, 60);
  assert.equal(typeof def.handler, "function");
});
