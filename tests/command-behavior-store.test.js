import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BehaviorStore, validateBehaviorProfile } from "../src/dashboard/command-behavior-store.js";
import { defaultBehaviorProfile } from "../src/dashboard/command-behavior-schema.js";

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-store-"));
  fs.mkdirSync(path.join(root, "assets", "json-data"), { recursive: true });
  fs.mkdirSync(path.join(root, "mybot", "command-overrides"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    prefix: "!",
    commands: [{ name: "help", permission: "all", active: true }, { name: "kick", permission: "adminBox", active: true }],
  }));
  return root;
}

test("valid profile passes and unknown field rejected", () => {
  const profile = defaultBehaviorProfile();
  profile.operation.cooldownMode = "perThread";
  const result = validateBehaviorProfile(profile);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.operation.cooldownMode, "perThread");

  const bad = validateBehaviorProfile({ ...profile, whatIsThis: 1 });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path === "whatIsThis"));
});

test("select/number/boolean rules enforced", () => {
  const p1 = defaultBehaviorProfile();
  p1.operation.cooldownMode = "nonsense";
  assert.equal(validateBehaviorProfile(p1).ok, false);

  const p2 = defaultBehaviorProfile();
  p2.operation.timeoutMs = 10; // dưới min 1000
  assert.equal(validateBehaviorProfile(p2).ok, false);

  const p3 = defaultBehaviorProfile();
  p3.operation.cooldownOverride = null; // nullable OK
  assert.equal(validateBehaviorProfile(p3).ok, true);

  const p4 = defaultBehaviorProfile();
  p4.operation.killSwitch = "yes";
  assert.equal(validateBehaviorProfile(p4).ok, false);
});

test("params items require unique non-empty keys and typed rows", () => {
  const ok = defaultBehaviorProfile();
  ok.params.items = [{ key: "limit", type: "number", value: 10, defaultValue: 5 }];
  assert.equal(validateBehaviorProfile(ok).ok, true);

  const dup = defaultBehaviorProfile();
  dup.params.items = [{ key: "a", type: "number" }, { key: "a", type: "string" }];
  assert.equal(validateBehaviorProfile(dup).ok, false);

  const empty = defaultBehaviorProfile();
  empty.params.items = [{ key: "", type: "number" }];
  assert.equal(validateBehaviorProfile(empty).ok, false);
});

test("effective() merges override over global leaf-wise", () => {
  const globalP = defaultBehaviorProfile();
  globalP.operation.cooldownMode = "perUser";
  globalP.operation.maxUsesPerHour = 5;
  const overrideP = { operation: { maxUsesPerHour: 20 } };
  const merged = BehaviorStore.effective(globalP, overrideP);
  assert.equal(merged.operation.cooldownMode, "perUser");
  assert.equal(merged.operation.maxUsesPerHour, 20);
});

test("setGlobal writes behavior into command entry with backup; reset removes it", async () => {
  const root = tmpRoot();
  const store = new BehaviorStore({ root });
  const profile = defaultBehaviorProfile();
  profile.responses.reactionOnReceive = "👀";
  const result = await store.setGlobal("help", profile);
  assert.ok(result.backup);
  const raw = JSON.parse(fs.readFileSync(path.join(root, "assets/json-data/command.json"), "utf8"));
  assert.equal(raw.commands.find((c) => c.name === "help").behavior.responses.reactionOnReceive, "👀");

  await store.resetGlobal("help");
  const after = JSON.parse(fs.readFileSync(path.join(root, "assets/json-data/command.json"), "utf8"));
  assert.equal(after.commands.find((c) => c.name === "help").behavior, undefined);
});

test("setForBot writes override file; unknown command rejected with 404-style error", async () => {
  const root = tmpRoot();
  const store = new BehaviorStore({ root });
  await assert.rejects(() => store.setGlobal("ghost", defaultBehaviorProfile()), /COMMAND_NOT_FOUND/);

  const profile = defaultBehaviorProfile();
  profile.operation.killSwitch = true;
  await store.setForBot("bot01", "kick", profile);
  const overrides = JSON.parse(fs.readFileSync(path.join(root, "mybot/command-overrides/bot01.json"), "utf8"));
  assert.equal(overrides.kick.behavior.operation.killSwitch, true);
  assert.deepEqual(await store.getForBot("bot01", "kick"), { override: profile });
  assert.deepEqual(await store.getForBot("bot404", "kick"), { override: null });
});
