import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

test("attemptStart child branch does not redeclare _listenerState inside the try block (TDZ fix)", () => {
  const src = fs.readFileSync(path.join(projectRoot, "src", "index.js"), "utf8");
  // Isolate the attemptStart function body between its signature and the
  // following standalone boot block.
  const start = src.indexOf("async function attemptStart(");
  const end = src.indexOf("if (process.env.SKIP_ENV_VALIDATION", start);
  assert.ok(start >= 0, "attemptStart must exist");
  assert.ok(end > start, "must be able to isolate attemptStart body");

  const body = src.slice(start, end);
  // The child-branch code must read getListenerRuntimeState() exactly once at
  // the top of attemptStart and must NOT shadow it with a second const inside
  // the try. A duplicate `const _listenerState` inside the child try branch
  // is exactly the Temporal Dead Zone crash we are fixing.
  const constCount = (body.match(/const\s+_listenerState/g) || []).length;
  assert.equal(constCount, 1, `expected exactly one '_listenerState' binding, found ${constCount}`);
});

test("child _listenerState is read at the top of attemptStart, before any use (no forward TDZ)", () => {
  const src = fs.readFileSync(path.join(projectRoot, "src", "index.js"), "utf8");
  const start = src.indexOf("async function attemptStart(");
  const end = src.indexOf("if (process.env.SKIP_ENV_VALIDATION", start);
  const body = src.slice(start, end);

  const bindPos = body.indexOf("const _listenerState");
  const firstUse = body.indexOf("_listenerState.setStartupPhase");
  assert.ok(bindPos >= 0, "must bind _listenerState");
  assert.ok(firstUse > bindPos, "must bind _listenerState before using it (no TDZ)");
});
