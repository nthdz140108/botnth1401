import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getProfile,
  saveProfile,
  validateProfile,
  createDefaultProfile,
  updateProfile,
} from "../src/commands/mybot/System/mybot-profile-service.js";
import {
  DEFAULT_STYLE,
  normalizeColor,
  normalizeType,
  validateStyle,
  buildStyledMessagePayload,
} from "../src/commands/mybot/System/mybot-style.js";

test("validateProfile enforces field length limits and types", () => {
  const valid = validateProfile({
    botId: "123",
    ownerName: "A".repeat(80),
    nameServer: "B".repeat(80),
    description: "C".repeat(500),
    botInfo: "D".repeat(500),
    typePlatform: "E".repeat(40),
  });
  assert.equal(valid.ok, true);

  const invalid = validateProfile({
    botId: "123",
    ownerName: "A".repeat(81),
    nameServer: "B".repeat(81),
    description: "C".repeat(501),
    botInfo: "D".repeat(501),
    typePlatform: "E".repeat(41),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors.length, 5);
});

test("getProfile is a pure read without disk mutations", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-pure-read-"));
  const profileDir = path.join(root, "mybot", "instances", "bot-pure-123", "data");
  const profilePath = path.join(profileDir, "profile.json");

  // Read non-existent profile
  const profile = getProfile("bot-pure-123", { root });
  assert.equal(profile.botId, "bot-pure-123");
  assert.equal(profile.trialStatus, "pending");

  // Verify file was NOT created on disk by getProfile
  let exists = false;
  try {
    await fs.access(profilePath);
    exists = true;
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "profile.json should not be written to disk during getProfile()");
});

test("saveProfile produces collision-proof backups and updates revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-save-test-"));

  const saved1 = saveProfile("bot-save-1", {
    botId: "bot-save-1",
    nameServer: "Server 1",
  }, { root });
  assert.equal(saved1.ok, true);
  assert.equal(saved1.profile.revision, 2);

  const saved2 = saveProfile("bot-save-1", {
    botId: "bot-save-1",
    nameServer: "Server 2",
  }, { root });
  assert.equal(saved2.ok, true);
  assert.equal(saved2.profile.revision, 3);
  assert.notEqual(saved1.backup, saved2.backup);
});

test("style normalization handles color names and none exclusivity", () => {
  assert.equal(normalizeColor("red"), "db342e");
  assert.equal(normalizeColor("green"), "15a85f");
  assert.equal(normalizeColor("gold"), "f7b503");
  assert.equal(normalizeColor("#ffffff"), "ffffff");
  assert.equal(normalizeColor("invalid-color"), DEFAULT_STYLE.color);

  assert.deepEqual(normalizeType(["bold", "italic"]), ["bold", "italic"]);
  assert.deepEqual(normalizeType(["bold", "none", "italic"]), ["none"]);
  assert.deepEqual(normalizeType("none"), ["none"]);
});

test("buildStyledMessagePayload builds correct Zalo payload", () => {
  const payload = buildStyledMessagePayload({
    style: {
      color: "red",
      size: { nameServer: 20, text: 16 },
      type: { nameServer: ["bold"], text: ["italic"] },
    },
    nameServer: "MyBot Test",
    text: "Hello World",
  });

  assert.ok(payload.msg.includes("MyBot Test"));
  assert.ok(payload.msg.includes("Hello World"));
  assert.ok(payload.style);
});
