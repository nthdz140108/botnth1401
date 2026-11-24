import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createBotListImage, resolveBotAvatarImage } from "../src/commands/mybot/list-canvas.js";

test("resolveBotAvatarImage returns null gracefully on unknown UID or network failure", async () => {
  const bot1 = { uid: "admin", displayName: "Admin Bot" };
  const res1 = await resolveBotAvatarImage(bot1, null);
  assert.equal(res1, null);

  const bot2 = { uid: "99999999999999", displayName: "Test Bot" };
  const mockApi = {
    getUserInfo: async () => { throw new Error("API Network error"); },
  };
  const res2 = await resolveBotAvatarImage(bot2, mockApi);
  assert.equal(res2, null);
});

test("createBotListImage renders image with fallback avatars even if api fails", async () => {
  const bots = [
    {
      uid: "admin_uid_123",
      displayName: "Admin Bot",
      isMain: true,
      status: "running",
      expiryAt: "-1",
    },
    {
      uid: "child_bot_456",
      displayName: "Child Bot Test",
      status: "stopped",
      expiryAt: new Date(Date.now() + 1000000).toISOString(),
    },
  ];

  const filePath = await createBotListImage(bots, null);
  assert.ok(filePath);
  const stat = await fs.stat(filePath);
  assert.ok(stat.size > 0);

  // Clean up test generated file
  try {
    await fs.unlink(filePath);
  } catch {}
});
