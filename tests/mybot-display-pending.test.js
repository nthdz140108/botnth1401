import test from "node:test";
import assert from "node:assert/strict";

test("formatBotExpiryDisplay formats pending trial or null expiry as 'Chưa khởi động'", async () => {
  const { formatBotExpiryDisplay } = await import("../src/commands/mybot/System/mybot-display.js");

  // Pending trial bot with null expiry
  const pendingBot = {
    displayName: "New User",
    status: "stopped",
    trialStatus: "pending",
    expiryAt: null,
  };
  assert.equal(formatBotExpiryDisplay(pendingBot), "Chưa khởi động");

  // Active bot with future expiry
  const activeBot = {
    displayName: "Active User",
    status: "running",
    trialStatus: "active",
    expiryAt: new Date(Date.now() + 3600000).toISOString(),
  };
  assert.notEqual(formatBotExpiryDisplay(activeBot), "Hết Hạn");
  assert.notEqual(formatBotExpiryDisplay(activeBot), "Chưa khởi động");

  // Expired bot
  const expiredBot = {
    displayName: "Expired User",
    status: "expired",
    expiryAt: new Date(Date.now() - 3600000).toISOString(),
  };
  assert.equal(formatBotExpiryDisplay(expiredBot), "Hết Hạn");

  // Permanent bot
  const permBot = {
    displayName: "Perm User",
    status: "running",
    expiryAt: "-1",
  };
  assert.equal(formatBotExpiryDisplay(permBot), "Vĩnh Viễn");
});
