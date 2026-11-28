import test from "node:test";
import assert from "node:assert/strict";

/**
 * PM2-phase restore policy (updated):
 * Every valid, non-expired child bot is a restore candidate regardless of
 * its previous `status` — including `stopped` (Stop is honored only until
 * the next run.bat). Main bot is restored unconditionally by the PM2
 * reconcile flow, not by this policy (see tests below).
 */

test("restore policy filters disabled, expired and cookie-dead bots and preserves manual stops", async () => {
  const { getAutoRestoreCandidates } = await import("../../src/commands/mybot/System/mybot-auto-restore.js");

  const past = new Date(Date.now() - 86400_000).toISOString();
  const future = new Date(Date.now() + 86400_000).toISOString();
  const creds = { cookie: "c=1", imei: "imei-1" };

  const registry = {
    admin: { status: "running", webPort: "2000", expiryAt: "-1", credentials: creds },
    "bot-ok": { status: "running", webPort: "5001", expiryAt: future, enabled: true, credentials: creds },
    "bot-stopped-valid": { status: "stopped", webPort: "5005", expiryAt: future, credentials: creds },
    "bot-disabled": { status: "running", webPort: "5002", enabled: false, credentials: creds },
    "bot-disabled-flag": { status: "running", webPort: "5002b", statusDisabled: true, credentials: creds },
    "bot-expired": { status: "running", webPort: "5003", expiryAt: past, credentials: creds },
    "bot-cookie-dead": { status: "running", webPort: "5004", cookieDead: true, credentials: creds },
  };

  const candidates = getAutoRestoreCandidates(registry);
  const uids = candidates.map(c => c.uid);
  assert.ok(uids.includes("bot-ok"), `bot-ok should be restored (got: ${uids.join(",")})`);
  assert.ok(!uids.includes("bot-stopped-valid"), "manually stopped bot must remain stopped");
  assert.ok(!uids.includes("bot-disabled"), "disabled bot must NOT be restored");
  assert.ok(!uids.includes("bot-expired"), "expired bot must NOT be restored");
  assert.ok(!uids.includes("bot-cookie-dead"), "cookie-dead bot must NOT be restored");
  assert.ok(!uids.includes("admin"), "admin/main handled separately by PM2 reconcile, not restore policy");
});

test("restore policy treats status 'disabled' as excluded even if enabled flag missing", async () => {
  const { getAutoRestoreCandidates } = await import("../../src/commands/mybot/System/mybot-auto-restore.js");
  const future = new Date(Date.now() + 86400_000).toISOString();
  const creds = { cookie: "c=1", imei: "imei-1" };
  const registry = {
    "bot-status-disabled": { status: "disabled", webPort: "6001", expiryAt: future, credentials: creds },
    "bot-running": { status: "running", webPort: "6002", expiryAt: future, credentials: creds },
  };
  const candidates = getAutoRestoreCandidates(registry);
  const uids = candidates.map(c => c.uid);
  assert.ok(!uids.includes("bot-status-disabled"), "status=disabled must be excluded");
  assert.ok(uids.includes("bot-running"));
});

test("restore policy expiry '-1' means never expire", async () => {
  const { getAutoRestoreCandidates } = await import("../../src/commands/mybot/System/mybot-auto-restore.js");
  const creds = { cookie: "c=1", imei: "imei-1" };
  const registry = {
    "bot-lifetime": { status: "running", webPort: "7001", expiryAt: "-1", credentials: creds },
    "bot-normal-expiry": { status: "running", webPort: "7002", expiryAt: new Date(Date.now() + 3600_000).toISOString(), credentials: creds },
  };
  const candidates = getAutoRestoreCandidates(registry);
  const uids = candidates.map(c => c.uid);
  assert.ok(uids.includes("bot-lifetime"), "expiryAt=-1 must be treated as never-expiring");
  assert.ok(uids.includes("bot-normal-expiry"));
});
