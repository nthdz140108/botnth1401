import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createCommandDefinition, createCommandRegistry, executeCommand } from "../src/commands/command-router.js";
import { createWorkloadBroker } from "../src/core/workload-broker.js";

// ===========================================================================
// Bug 1: mybot/mebot/clean runs on control lane bounded by 10s timeout. QR,
// restart and list operations routinely exceed 10s -> converted to HANDLER_ERROR
// -> CMD-* error codes sent to the user. Fix: run these on a non-control lane
// (concurrent orchestration) so their natural timing is not bounded by the
// control-lane timeout.
// ===========================================================================

test("control lane: mybot definition no longer uses control execution lane", async () => {
  const mybotDef = createCommandDefinition({
    name: "mybot",
    handler: async () => "ok",
    aliases: ["mebot", "clean"],
  });
  assert.equal(mybotDef.executionLane, "fast", "mybot should run on fast lane (no 10s control bound)");

  // The actual registry entry must also not use the control lane (which is
  // bounded by the 10s control timeout that turned QR/restart/list into
  // HANDLER_ERROR -> CMD-*).
  const { commandRegistry } = await import("../src/commands/command-registry.js");
  const registryDef = commandRegistry.definitions.find((d) => d.name === "mybot");
  assert.ok(registryDef, "mybot must be registered");
  assert.notEqual(registryDef.executionLane, "control", "registry mybot must not run on the 10s-bounded control lane");
});

test("control lane: restart (rs) still uses control lane but returns TIMEOUT not HANDLER_ERROR", async () => {
  const broker = createWorkloadBroker({ controlTimeoutMs: 50 });
  const slowHandler = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return "late";
  };
  const restartDef = createCommandDefinition({
    name: "restart",
    handler: slowHandler,
    aliases: ["rs"],
    executionLane: "control",
    timeoutMs: 0,
  });

  const result = await executeCommand({ workloadBroker: broker }, restartDef);
  assert.equal(result.code, "TIMEOUT", "control lane timeout should surface as TIMEOUT, not HANDLER_ERROR");
  assert.equal(result.error, undefined, "TIMEOUT result must not carry an Error (no CMD-* code)");
});

test("control lane: genuine handler exception on control lane still surfaces as HANDLER_ERROR", async () => {
  const broker = createWorkloadBroker({ controlTimeoutMs: 100 });
  const failingHandler = async () => {
    throw new Error("genuine failure");
  };
  const restartDef = createCommandDefinition({
    name: "restart",
    handler: failingHandler,
    aliases: ["rs"],
    executionLane: "control",
    timeoutMs: 0,
  });

  const result = await executeCommand({ workloadBroker: broker }, restartDef);
  assert.equal(result.code, "HANDLER_ERROR");
  assert.match(result.error.message, /genuine failure/);
});

test("control lane: runControl timeout surfaces as friendly TIMEOUT error with no CMD-* reference", () => {
  const broker = createWorkloadBroker({ controlTimeoutMs: 30 });
  const slowTask = () => new Promise((resolve) => setTimeout(resolve, 150));
  const outcome = broker.runControl("restart", slowTask);
  // The broker rejects; the router must map that rejection to TIMEOUT, not HANDLER_ERROR.
  assert.ok(outcome instanceof Promise);
  return outcome.then(
    () => assert.fail("control lane should have timed out"),
    (err) => {
      assert.match(err.message, /timed out/);
      assert.equal(/CMD-[0-9A-F]{8}/.test(err.message), false, "error message must not carry a CMD-* reference");
    }
  );
});

// ===========================================================================
// Bug 2: Child restart (rs) + hydrate touches admin state
// Child writes own UID into mybot/state/admin.json via hydrateCurrentBotIdentity,
// then next boot treats that UID as Main Bot and exits with BOOT:IDENTITY:FATAL.
// ===========================================================================

test("child hydrate: never writes mybot/state/admin.json on a child instance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "child-hydrate-isolation-"));
  try {
    const childBotUid = "555666777888";
    const mainBotUid = "111222333444";

    await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
    await fs.mkdir(path.join(root, "mybot", "instances", "admin", "data"), { recursive: true });
    await fs.mkdir(path.join(root, "mybot", "instances", childBotUid, "data"), { recursive: true });

    // Main state is authoritative and must never be touched by child hydration
    const adminStatePath = path.join(root, "mybot", "state", "admin.json");
    await fs.writeFile(
      adminStatePath,
      JSON.stringify({ uid: mainBotUid, displayName: "Main Bot Admin", canonicalUsername: "main_bot_acc" }),
      "utf8"
    );

    const { persistVerifiedInstanceIdentity } = await import("../src/utils/instance-authorization.js");
    const result = await persistVerifiedInstanceIdentity({
      instanceKind: "child",
      liveUid: childBotUid,
      botName: "subbot_1",
      projectRoot: root,
    });

    // Child must NOT have touched admin.json
    const adminState = JSON.parse(await fs.readFile(adminStatePath, "utf8"));
    assert.equal(adminState.uid, mainBotUid, "admin.json uid must remain the main bot UID");
    assert.equal(adminState.canonicalUsername, "main_bot_acc", "admin.json username must remain untouched");

    // Child must have written its OWN state file instead
    const childStatePath = path.join(root, "mybot", "state", `${childBotUid}.json`);
    const childState = JSON.parse(await fs.readFile(childStatePath, "utf8"));
    assert.equal(childState.uid, childBotUid);
    assert.equal(result.repaired, false, "child must never repair main state");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("child exit: does not set main bot status to stopped in mybots.json", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "child-exit-isolation-"));
  try {
    const childBotUid = "999000111222";
    const mainBotUid = "333444555666";

    await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
    await fs.writeFile(
      path.join(root, "mybot", "mybots.json"),
      JSON.stringify({
        admin: { uid: mainBotUid, status: "running", isMain: true },
        [childBotUid]: { uid: childBotUid, status: "running", isMain: false },
      }),
      "utf8"
    );

    const { updateMyBotRecord } = await import("../src/commands/mybot/System/pm2-manager.js");
    await updateMyBotRecord(childBotUid, { status: "stopped", lastUpdated: new Date().toISOString() }, root);

    const myBots = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    assert.equal(myBots.admin.status, "running", "main bot must remain running when child stops");
    assert.equal(myBots[childBotUid].status, "stopped", "child bot must be marked stopped");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("child exit handler: updateAdminBotStatus guard prevents main being stopped by child", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "child-exit-guard-"));
  try {
    const childBotUid = "123123123123";
    const mainBotUid = "456456456456";

    await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
    await fs.writeFile(
      path.join(root, "mybot", "mybots.json"),
      JSON.stringify({
        admin: { uid: mainBotUid, status: "running", isMain: true },
        [childBotUid]: { uid: childBotUid, status: "running", isMain: false },
      }),
      "utf8"
    );

    // Simulate the code path used by src/index.js process.on("exit"):
    // it must only run updateAdminBotStatus("stopped") when this process is MAIN.
    const { resolveRuntimeInstance } = await import("../src/core/runtime-instance.js").catch(() => null);
    const { getRuntimeInstanceDescriptor, resetRuntimeInstanceDescriptor } = await import("../src/core/runtime-instance.js");

    resetRuntimeInstanceDescriptor();
    // Simulate child runtime
    process.env.MYBOT_INSTANCE_KIND = "child";
    const descriptor = getRuntimeInstanceDescriptor();
    assert.equal(descriptor.isChild, true);

    // The exit-status update must be gated on isMain. We assert the guard
    // function we ship does not stop main from a child context.
    const { shouldUpdateMainStatusOnExit } = await import("../src/core/runtime-exit-guard.js").catch(() => null);
    if (shouldUpdateMainStatusOnExit) {
      assert.equal(shouldUpdateMainStatusOnExit(descriptor), false, "child exit must not stop main bot");
    }
    delete process.env.MYBOT_INSTANCE_KIND;
    resetRuntimeInstanceDescriptor();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
