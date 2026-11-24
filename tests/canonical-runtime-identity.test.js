import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  RuntimeInstanceDescriptor,
  resolveLaunchDescriptor,
  createRuntimeInstanceDescriptor,
  getRuntimeInstanceDescriptor,
  verifyRuntimeIdentity,
  resetRuntimeInstanceDescriptor,
} from "../src/core/runtime-instance.js";
import { resolveInstanceKind } from "../src/bootstrap.js";

test("resolveLaunchDescriptor: explicit child always wins over BOT_NAME, legacy env, and registry", () => {
  const descriptor = resolveLaunchDescriptor({
    kind: "child",
    botName: "admin",
    botKey: "subbot_1",
    env: {
      BOT_NAME: "admin",
      MYBOT_INSTANCE_KIND: "child",
    },
  });

  assert.equal(descriptor.kind, "child");
  assert.equal(descriptor.isChild, true);
  assert.equal(descriptor.isMain, false);
  assert.equal(descriptor.botKey, "subbot_1");
  assert.equal(descriptor.supervisor, "child-terminal");
});

test("resolveLaunchDescriptor: explicit main always has logical botKey='admin'", () => {
  const descriptor = resolveLaunchDescriptor({
    kind: "main",
    botName: "some_other_name",
    botKey: "custom_main_key",
    env: {
      MYBOT_INSTANCE_KIND: "main",
    },
  });

  assert.equal(descriptor.kind, "main");
  assert.equal(descriptor.isMain, true);
  assert.equal(descriptor.isChild, false);
  assert.equal(descriptor.botKey, "admin");
  assert.equal(descriptor.supervisor, "main-supervisor");
});

test("resolveLaunchDescriptor: configuredUid and liveZaloUid are never used in place of botKey", () => {
  const descriptor = resolveLaunchDescriptor({
    kind: "child",
    botKey: "my_child_bot",
    botUid: "1234567890",
    configuredUid: "1234567890",
    liveZaloUid: "9876543210",
  });

  assert.equal(descriptor.kind, "child");
  assert.equal(descriptor.botKey, "my_child_bot");
  assert.equal(descriptor.configuredUid, "1234567890");
  assert.equal(descriptor.liveZaloUid, "9876543210");
});

test("resolveLaunchDescriptor: Main-config and Child-config conflict fails-closed bidirectionally", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-desc-test-"));
  try {
    // 1. Child pointing to main config -> fails closed
    assert.throws(
      () => {
        resolveLaunchDescriptor({
          kind: "child",
          botKey: "child_bot_1",
          configPath: path.join(tmpDir, "assets", "config.json"),
          projectRoot: tmpDir,
        });
      },
      (err) => {
        return err.code === "INVALID_CHILD_CONFIG";
      }
    );

    // 2. Main pointing to child config -> fails closed
    assert.throws(
      () => {
        resolveLaunchDescriptor({
          kind: "main",
          botKey: "admin",
          configPath: path.join(tmpDir, "mybot", "bots", "child_1.json"),
          projectRoot: tmpDir,
        });
      },
      (err) => {
        return err.code === "INVALID_MAIN_CONFIG";
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("resolveLaunchDescriptor: pure function does not mutate or depend on singleton descriptor", () => {
  resetRuntimeInstanceDescriptor();

  // Create an active descriptor
  const activeDesc = createRuntimeInstanceDescriptor({
    kind: "main",
    botKey: "admin",
  });
  assert.equal(getRuntimeInstanceDescriptor().kind, "main");

  // Call pure resolver with child options
  const pureDesc = resolveLaunchDescriptor({
    kind: "child",
    botKey: "child_isolated",
  });
  assert.equal(pureDesc.kind, "child");
  assert.equal(pureDesc.botKey, "child_isolated");

  // Active descriptor remains unchanged
  assert.equal(getRuntimeInstanceDescriptor().kind, "main");
  assert.equal(getRuntimeInstanceDescriptor().botKey, "admin");

  // resolveInstanceKind with child options uses pure resolver
  const kind = resolveInstanceKind({
    explicitKind: "child",
    botName: "child_isolated",
  });
  assert.equal(kind, "child");
  assert.equal(getRuntimeInstanceDescriptor().kind, "main");

  resetRuntimeInstanceDescriptor();
});

test("verifyRuntimeIdentity: child bot mismatch triggers exit recommendation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-identity-test-"));
  try {
    await fs.mkdir(path.join(tmpDir, "mybot", "state"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "111222333" }),
      "utf8"
    );

    const childDescriptor = resolveLaunchDescriptor({
      kind: "child",
      botKey: "sub_bot",
      projectRoot: tmpDir,
    });

    // Case 1: Child logs in as main bot UID -> conflict mismatch
    const resultConflict = verifyRuntimeIdentity(childDescriptor, "111222333", { projectRoot: tmpDir });
    assert.equal(resultConflict.verified, false);
    assert.equal(resultConflict.action, "exit");
    assert.equal(resultConflict.code, 13);

    // Case 2: Child logs in with valid child UID -> verified
    const resultOk = verifyRuntimeIdentity(childDescriptor, "999888777", { projectRoot: tmpDir });
    assert.equal(resultOk.verified, true);
    assert.equal(resultOk.action, "continue");

    // Case 3: Main bot logs in -> repaired / synced
    const mainDescriptor = resolveLaunchDescriptor({
      kind: "main",
      botKey: "admin",
      projectRoot: tmpDir,
    });
    const resultMain = verifyRuntimeIdentity(mainDescriptor, "111222333", { projectRoot: tmpDir });
    assert.equal(resultMain.verified, true);
    assert.equal(resultMain.action, "continue");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
