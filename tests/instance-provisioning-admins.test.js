import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getInitialAdminList, seedRuntimeFiles } from "../src/utils/bot-runtime-context.js";
import { resolveInstanceAuthorization } from "../src/utils/instance-authorization.js";

async function makeProvisionRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-auth-"));
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "instances", "admin", "data"), { recursive: true });
  // main instance workspace present (normal deployment) — no global-high inside
  await fs.writeFile(
    path.join(root, "mybot", "instances", "admin", "data", "admin-list.json"),
    JSON.stringify(["main-1"]),
    "utf8",
  );
  // main bot identity + polluted global high lists
  await fs.writeFile(path.join(root, "mybot", "state", "admin.json"), JSON.stringify({ uid: "main-1" }), "utf8");
  await fs.writeFile(path.join(root, "assets", "data", "list_admin_high.json"), JSON.stringify(["global-high"]), "utf8");
  await fs.writeFile(path.join(root, "assets", "data", "list_admin_high_command.json"), JSON.stringify(["cmd-high"]), "utf8");
  return {
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function buildContext(root, uid) {
  const workspaceRoot = path.join(root, "mybot", "instances", uid);
  const dataDir = path.join(workspaceRoot, "data");
  return {
    uid,
    projectRoot: root,
    workspaceRoot,
    instanceRoot: workspaceRoot,
    dataDir,
    logsDir: path.join(workspaceRoot, "logs"),
    tempDir: path.join(workspaceRoot, "temp"),
    resourcesDir: path.join(workspaceRoot, "resources"),
    generatedDir: path.join(workspaceRoot, "generated"),
    stateDir: path.join(workspaceRoot, "state"),
    adminFilePath: path.join(root, "mybot", "configs", `list_admin-${uid}.json`),
    commandConfigPath: path.join(dataDir, "command.json"),
    groupSettingsPath: path.join(dataDir, "group-settings.json"),
    adminListPath: path.join(dataDir, "admin-list.json"),
  };
}

test("provisioning seeds child with only its own UID — foreign main/global admins are NOT inherited (fail-closed)", async (t) => {
  const world = await makeProvisionRoot();
  try {
    const initial = getInitialAdminList("child-1", world.root).sort();
    // Fail-closed: a child with no local verified admin list has NO seeded
    // foreign admins. The main bot UID is NOT copied into the child admin list.
    assert.deepEqual(initial, []);
    assert.equal(initial.includes("main-1"), false, "main bot UID must not be auto-copied into child admin list");
    assert.equal(initial.includes("global-high"), false);
    assert.equal(initial.includes("cmd-high"), false);
  } finally {
    await world.cleanup();
  }
});

test("seeded child resolves only its own UID as supreme via the authorization snapshot", async (t) => {
  const world = await makeProvisionRoot();
  try {
    const context = buildContext(world.root, "child-1");
    seedRuntimeFiles(context);
    const stored = JSON.parse(await fs.readFile(context.adminListPath, "utf8")).sort();
    // No foreign admin is seeded; an existing list is not fabricated for a child
    assert.deepEqual(stored, []);

    const childSnapshot = resolveInstanceAuthorization({
      senderId: "child-1",
      instanceUid: "child-1",
      instanceKind: "child",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
        botAdminsPath: context.adminListPath,
      },
    });
    assert.equal(childSnapshot.role, "adminLevelHigh", "child self must be supreme (self UID)");

    // Main bot UID is not in the child admin list; it must NOT be granted
    // adminLevelHigh merely because it appears in main state (no foreign UID
    // injection). It resolves as a plain member until verified in child session.
    const mainSnapshot = resolveInstanceAuthorization({
      senderId: "main-1",
      instanceUid: "child-1",
      instanceKind: "child",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
        botAdminsPath: context.adminListPath,
      },
    });
    assert.equal(mainSnapshot.role, "member", "foreign main UID must not gain child admin from shared state");

    const outsider = resolveInstanceAuthorization({
      senderId: "random-outsider",
      instanceUid: "child-1",
      instanceKind: "child",
      projectRoot: world.root,
      overrides: {
        highFilePath: path.join(world.root, "assets", "data", "list_admin_high.json"),
        highCommandPath: path.join(world.root, "assets", "data", "list_admin_high_command.json"),
        botAdminsPath: context.adminListPath,
      },
    });
    assert.equal(outsider.role, "member");
  } finally {
    await world.cleanup();
  }
});

test("re-seeding does not duplicate entries and keeps separately assigned admins", async (t) => {
  const world = await makeProvisionRoot();
  try {
    const uid = "child-2";
    const context = buildContext(world.root, uid);
    // separately assigned legacy admin lives in the per-bot config file
    await fs.mkdir(path.dirname(context.adminFilePath), { recursive: true });
    await fs.writeFile(context.adminFilePath, JSON.stringify(["assigned-admin"]), "utf8");

    seedRuntimeFiles(context);
    const first = JSON.parse(await fs.readFile(context.adminListPath, "utf8")).sort();
    assert.deepEqual(first, ["assigned-admin"]);

    seedRuntimeFiles(context);
    const second = JSON.parse(await fs.readFile(context.adminListPath, "utf8")).sort();
    assert.deepEqual(second, first, "re-provisioning must be idempotent");

    // existing populated runtime list is never rewritten
    await fs.writeFile(context.adminListPath, JSON.stringify([uid, "hand-added"]), "utf8");
    seedRuntimeFiles(context);
    const third = JSON.parse(await fs.readFile(context.adminListPath, "utf8")).sort();
    assert.deepEqual(third, ["child-2", "hand-added"]);
  } finally {
    await world.cleanup();
  }
});
