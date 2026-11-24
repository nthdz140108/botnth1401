import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveAdminIdentity,
  syncMainBotRegistry,
  resolveMyBotCallerRole,
  isMainBot,
  assertCanDeleteBot,
} from "../src/commands/mybot/System/mybot-identity.js";

test("resolveAdminIdentity picks UID in priority: API > state admin.json > fallback", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-id-test-"));
  const stateDir = path.join(tmpDir, "mybot", "state");
  await fs.mkdir(stateDir, { recursive: true });

  await fs.writeFile(path.join(stateDir, "admin.json"), JSON.stringify({
    uid: "36636267278442919",
  }, null, 2), "utf8");

  // 1. If API provides own ID
  const apiWithId = { getOwnId: () => "99999999999999999" };
  const res1 = resolveAdminIdentity({ projectRoot: tmpDir, api: apiWithId });
  assert.equal(res1.adminUid, "99999999999999999");
  assert.equal(res1.isMain, true);

  // 2. If API has no ID, falls back to state admin.json
  const apiNoId = {};
  const res2 = resolveAdminIdentity({ projectRoot: tmpDir, api: apiNoId });
  assert.equal(res2.adminUid, "36636267278442919");
  assert.equal(res2.isMain, true);
});

test("syncMainBotRegistry migrates old registry and prevents duplicate admin records", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-reg-test-"));
  const mybotDir = path.join(tmpDir, "mybot");
  await fs.mkdir(mybotDir, { recursive: true });
  const registryPath = path.join(mybotDir, "mybots.json");

  // Initial legacy registry
  const legacyRegistry = {
    "admin": {
      "uid": "admin",
      "name": "admin",
      "displayName": "Admin Bot",
      "status": "running",
      "webPort": "2000",
      "database": "admin",
      "createdAt": "2026-08-01T00:00:00.000Z",
    },
    "36636267278442919": {
      "name": "duplicate_admin_alias",
      "status": "running",
      "webPort": "2000",
    },
    "111222333444555": {
      "name": "child_bot_1",
      "displayName": "Child Bot 1",
      "status": "running",
      "webPort": "4444",
      "createdAt": "2026-08-05T00:00:00.000Z",
    },
  };
  await fs.writeFile(registryPath, JSON.stringify(legacyRegistry, null, 2), "utf8");

  syncMainBotRegistry({
    projectRoot: tmpDir,
    adminUid: "36636267278442919",
    webPort: "2000",
    pid: "12345",
  });

  const updatedRegistry = JSON.parse(await fs.readFile(registryPath, "utf8"));

  // Check admin record
  assert.equal(updatedRegistry.admin.isMain, true);
  assert.equal(updatedRegistry.admin.uid, "36636267278442919");
  assert.equal(updatedRegistry.admin.pid, "12345");

  // Duplicate record with admin's real UID as key should be pruned
  assert.equal(updatedRegistry["36636267278442919"], undefined);

  // Child bot record should have uid and isMain: false backfilled
  assert.equal(updatedRegistry["111222333444555"].uid, "111222333444555");
  assert.equal(updatedRegistry["111222333444555"].isMain, false);

  // Idempotent: running again keeps data intact
  syncMainBotRegistry({
    projectRoot: tmpDir,
    adminUid: "36636267278442919",
    webPort: "2000",
    pid: "12345",
  });
  const reRead = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(reRead.admin.uid, "36636267278442919");
  assert.equal(reRead.admin.isMain, true);
  assert.equal(reRead["111222333444555"].uid, "111222333444555");
});

test("resolveMyBotCallerRole grants system admin to Real Main Bot UID and adminLevelHigh", () => {
  const adminUid = "36636267278442919";
  const highAdminUid = "88888888888888888";
  const normalUserUid = "12345678901234567";

  // Case 1: Caller is real main bot UID
  const r1 = resolveMyBotCallerRole({
    uidFrom: adminUid,
    adminBotUid: adminUid,
    isAdminLevelHighest: false,
  });
  assert.equal(r1.isSystemAdmin, true);
  assert.equal(r1.canManageAll, true);

  // Case 2: Caller has isAdminLevelHighest = true
  const r2 = resolveMyBotCallerRole({
    uidFrom: highAdminUid,
    adminBotUid: adminUid,
    isAdminLevelHighest: true,
  });
  assert.equal(r2.isSystemAdmin, true);
  assert.equal(r2.canManageAll, true);

  // Case 3: Caller has role adminLevelHigh via roleContext
  const r3 = resolveMyBotCallerRole({
    uidFrom: highAdminUid,
    adminBotUid: adminUid,
    isAdminLevelHighest: false,
    roleContext: { mainAdmins: [highAdminUid] },
  });
  assert.equal(r3.isSystemAdmin, true);
  assert.equal(r3.canManageAll, true);

  // Case 4: Normal user
  const r4 = resolveMyBotCallerRole({
    uidFrom: normalUserUid,
    adminBotUid: adminUid,
    isAdminLevelHighest: false,
    roleContext: { mainAdmins: [] },
  });
  assert.equal(r4.isSystemAdmin, false);
  assert.equal(r4.canManageAll, false);
  // Normal user can manage their own bot
  assert.equal(r4.canManageBot({ uid: normalUserUid }), true);
  assert.equal(r4.canManageBot({ uid: "other_bot_uid" }), false);
});

test("isMainBot and assertCanDeleteBot protect Main Bot", () => {
  const mainBot1 = { isMain: true, uid: "36636267278442919", name: "admin" };
  const mainBot2 = { name: "admin" };
  const childBot = { isMain: false, uid: "111222333444555", name: "bot_1" };

  assert.equal(isMainBot(mainBot1, "admin"), true);
  assert.equal(isMainBot(mainBot2, "admin"), true);
  assert.equal(isMainBot(childBot, "111222333444555"), false);

  assert.throws(() => {
    assertCanDeleteBot(mainBot1, "admin");
  }, /Không thể xóa hoặc vô hiệu hóa Main Bot/i);

  assert.doesNotThrow(() => {
    assertCanDeleteBot(childBot, "111222333444555");
  });
});

test("resolveAdminIdentity and syncMainBotRegistry resolve canonical username and retain identity fields", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-canonical-id-"));
  const stateDir = path.join(tmpDir, "mybot", "state");
  await fs.mkdir(stateDir, { recursive: true });

  await fs.writeFile(path.join(stateDir, "admin.json"), JSON.stringify({
    uid: "36636267278442919",
    zaloUsername: "Admin_Official",
    globalUid: "11112222-3333-4444-5555-666677778888",
  }, null, 2), "utf8");

  const resolved = resolveAdminIdentity({ projectRoot: tmpDir, stateDir });
  assert.equal(resolved.adminUid, "36636267278442919");
  assert.equal(resolved.canonicalUsername, "admin_official");
  assert.equal(resolved.globalUid, "11112222-3333-4444-5555-666677778888");
  assert.equal(resolved.identityReady, true);

  // Sync to registry
  syncMainBotRegistry({
    projectRoot: tmpDir,
    adminUid: "36636267278442919",
    webPort: "2000",
    pid: "9999",
    identityInfo: {
      zaloUsername: "Admin_Official",
      globalUid: "11112222-3333-4444-5555-666677778888",
    },
  });

  const registryPath = path.join(tmpDir, "mybot", "mybots.json");
  const read = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(read.admin.zaloUsername, "Admin_Official");
  assert.equal(read.admin.canonicalUsername, "admin_official");
  assert.equal(read.admin.globalUid, "11112222-3333-4444-5555-666677778888");
});

