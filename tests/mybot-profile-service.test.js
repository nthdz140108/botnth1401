import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  createDefaultProfile,
  validateProfile,
  getProfile,
  saveProfile,
  updateProfile,
  updateStyle,
  resetStyle,
  redactProfile,
  migrateBotProfiles,
} from "../src/commands/mybot/System/mybot-profile-service.js";

test("profile service creates default profile with full schema", () => {
  const profile = createDefaultProfile("bot_123", {
    ownerUid: "owner_123",
    ownerName: "Owner Name",
    nameServer: "Server Alpha",
  });

  assert.equal(profile.botId, "bot_123");
  assert.equal(profile.ownerUid, "owner_123");
  assert.equal(profile.ownerName, "Owner Name");
  assert.equal(profile.nameServer, "Server Alpha");
  assert.equal(profile.typePlatform, "zalo");
  assert.ok(profile.style);
  assert.equal(profile.style.icon, "🤖");
  assert.equal(profile.revision, 1);
  assert.ok(profile.updatedAt);
});

test("profile service handles atomic save, revision conflicts, and backups", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-test-"));

  try {
    const botId = "test_bot_1";

    // 1. Initial read creates default profile
    const initial = getProfile(botId, { root: tmpDir });
    assert.equal(initial.botId, botId);
    assert.equal(initial.revision, 1);

    // 2. Update profile with expectedRevision
    const updatedRes = updateProfile(botId, { nameServer: "Updated Server" }, {
      root: tmpDir,
      expectedRevision: 1,
      actor: "test_user",
    });
    assert.equal(updatedRes.ok, true);
    assert.equal(updatedRes.profile.nameServer, "Updated Server");
    assert.equal(updatedRes.profile.revision, 2);
    assert.ok(updatedRes.backup);

    // 3. Stale revision update throws REVISION_CONFLICT
    assert.throws(() => {
      updateProfile(botId, { nameServer: "Conflict Server" }, {
        root: tmpDir,
        expectedRevision: 1, // Stale!
      });
    }, (err) => err.code === "REVISION_CONFLICT");

    // 4. Update style
    const styleRes = updateStyle(botId, { icon: "⚡", color: "15a85f" }, { root: tmpDir });
    assert.equal(styleRes.profile.style.icon, "⚡");
    assert.equal(styleRes.profile.style.color, "15a85f");
    assert.equal(styleRes.profile.revision, 3);

    // 5. Reset style
    const resetRes = resetStyle(botId, { root: tmpDir });
    assert.equal(resetRes.profile.style.icon, "🤖");
    assert.equal(resetRes.profile.style.color, "db342e");
    assert.equal(resetRes.profile.revision, 4);

    // 6. Redaction
    const clean = redactProfile({
      ...resetRes.profile,
      cookie: "secret_cookie",
      rawCookie: "secret_raw",
      imei: "secret_imei",
    });
    assert.equal(clean.cookie, undefined);
    assert.equal(clean.rawCookie, undefined);
    assert.equal(clean.imei, undefined);
    assert.equal(clean.nameServer, "Updated Server");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
