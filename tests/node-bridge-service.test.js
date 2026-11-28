import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeBridgeService } from "../src/dashboard/node-bridge-service.js";

function makeHmacHeaders(secret, body = "", timestamp = Date.now(), requestId = crypto.randomUUID()) {
  const payload = `${timestamp}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "Content-Type": "application/json",
    "x-internal-signature": sig,
    "x-internal-timestamp": String(timestamp),
    "x-request-id": requestId,
  };
}

test("NodeBridgeService: health, HMAC verification, idempotency, bot list & console command", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "node-bridge-test-"));
  const secret = "test-bridge-internal-secret-123456789";

  try {
    await fs.mkdir(path.join(tempRoot, "mybot", "state"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "assets"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "admin_uid_123", cookieDead: false, connected: true }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(tempRoot, "groupSettings.json"),
      JSON.stringify({ "12345": { name: "Test Group", activeBot: true, antiSpam: true } }, null, 2),
      "utf8"
    );

    const bridge = new NodeBridgeService({
      root: tempRoot,
      port: 0, // pick random available port
      host: "127.0.0.1",
      secret,
      verifyCredential: async () => ({ uid: "verified_child_account", displayName: "Verified Child", avatar: "", canonicalUsername: "verified.child" }),
    });

    const port = await bridge.start();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Health check (unauthenticated)
      const healthRes = await fetch(`${baseUrl}/bridge/health`);
      assert.equal(healthRes.status, 200);
      const healthData = await healthRes.json();
      assert.equal(healthData.status, "ok");
      assert.equal(healthData.bridge, "node-hybrid-bridge");

      // 2. Unauthenticated request to protected endpoint fails (401)
      const unauthRes = await fetch(`${baseUrl}/bridge/status`);
      assert.equal(unauthRes.status, 401);

      // 3. Authenticated request to /bridge/status succeeds
      const statusRes = await fetch(`${baseUrl}/bridge/status`, {
        headers: makeHmacHeaders(secret),
      });
      assert.equal(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.equal(statusData.success, true);
      assert.equal(statusData.data.engine, "node-v3-hybrid");

      // 3b. Authenticated request to /bridge/metrics returns eventLoop, CPU, RAM, lanes, and catalog
      const metricsRes = await fetch(`${baseUrl}/bridge/metrics`, {
        headers: makeHmacHeaders(secret),
      });
      assert.equal(metricsRes.status, 200);
      const metricsData = await metricsRes.json();
      assert.equal(metricsData.success, true);
      assert.ok(typeof metricsData.data.memory.rssBytes === "number");
      assert.ok(typeof metricsData.data.memory.heapUsedBytes === "number");
      assert.ok(typeof metricsData.data.cpu.userMicros === "number");
      assert.ok(metricsData.data.eventLoop !== undefined);
      assert.ok(metricsData.data.lanes.fastQueue !== undefined);
      assert.ok(metricsData.data.lanes.heavyQueue !== undefined);
      assert.ok(metricsData.data.catalog.totalKeys > 0);

      // 4. List bots
      const botsRes = await fetch(`${baseUrl}/bridge/bots`, {
        headers: makeHmacHeaders(secret),
      });
      assert.equal(botsRes.status, 200);
      const botsData = await botsRes.json();
      assert.equal(botsData.success, true);
      assert.ok(Array.isArray(botsData.data.bots));

      // 5. Read group settings
      const groupsRes = await fetch(`${baseUrl}/bridge/bots/admin/groups`, {
        headers: makeHmacHeaders(secret),
      });
      assert.equal(groupsRes.status, 200);
      const groupsData = await groupsRes.json();
      assert.equal(groupsData.success, true);
      assert.ok(groupsData.data.groups.some((g) => g.id === "12345"));

      // 6. Update group settings
      const updatePayload = JSON.stringify({
        settings: { antiNude: true, antiUndo: true },
      });
      const updateRes = await fetch(`${baseUrl}/bridge/bots/admin/groups/12345/settings`, {
        method: "PUT",
        headers: makeHmacHeaders(secret, updatePayload),
        body: updatePayload,
      });
      assert.equal(updateRes.status, 200);
      const updateData = await updateRes.json();
      assert.equal(updateData.success, true);
      assert.equal(updateData.data.settings.antiNude, true);
      assert.equal(updateData.data.settings.antiUndo, true);

      // 7. Execute command console (dry-run with known command 'help')
      const cmdPayload = JSON.stringify({
        commandLine: "help",
        deliverToZalo: false,
      });
      const cmdRes = await fetch(`${baseUrl}/bridge/bots/admin/remote/execute-command`, {
        method: "POST",
        headers: makeHmacHeaders(secret, cmdPayload),
        body: cmdPayload,
      });
      assert.equal(cmdRes.status, 200);
      const cmdData = await cmdRes.json();
      assert.equal(cmdData.success, true);
      assert.equal(cmdData.data.parsed, true);
      assert.equal(cmdData.data.executed, true);
      assert.equal(cmdData.data.deliveryAttempted, false);
      assert.equal(cmdData.data.deliveredToZalo, false);

      // 7b. Execute unknown command returns parsed=false, outcome='not_found'
      const unknownPayload = JSON.stringify({
        commandLine: "not_a_real_command_xyz",
        deliverToZalo: false,
      });
      const unknownRes = await fetch(`${baseUrl}/bridge/bots/admin/remote/execute-command`, {
        method: "POST",
        headers: makeHmacHeaders(secret, unknownPayload),
        body: unknownPayload,
      });
      assert.equal(unknownRes.status, 200);
      const unknownData = await unknownRes.json();
      assert.equal(unknownData.success, true);
      assert.equal(unknownData.data.parsed, false);
      assert.equal(unknownData.data.outcome, "not_found");

      // 8. Idempotency test (same request-id returns cached response)
      const fixedReqId = "test-fixed-req-id-999";
      const idempPayload = JSON.stringify({ settings: { antiSpam: false } });
      const firstHeaders = makeHmacHeaders(secret, idempPayload, Date.now(), fixedReqId);
      const firstRes = await fetch(`${baseUrl}/bridge/bots/admin/groups/12345/settings`, {
        method: "PUT",
        headers: firstHeaders,
        body: idempPayload,
      });
      assert.equal(firstRes.status, 200);

      // Second identical call with same requestId returns cached response
      const secondRes = await fetch(`${baseUrl}/bridge/bots/admin/groups/12345/settings`, {
        method: "PUT",
        headers: firstHeaders,
        body: idempPayload,
      });
      assert.equal(secondRes.status, 200);
      const secondData = await secondRes.json();
      assert.equal(secondData.requestId, fixedReqId);

      // 9. Module 2 & 3 test: Child bot creation via bridge
      // 9a. Rejects startImmediately: true
      const rejectPayload = JSON.stringify({
        name: "Bot Test Fail",
        startImmediately: true,
      });
      const rejectRes = await fetch(`${baseUrl}/bridge/bots`, {
        method: "POST",
        headers: makeHmacHeaders(secret, rejectPayload),
        body: rejectPayload,
      });
      assert.equal(rejectRes.status, 400);
      const rejectData = await rejectRes.json();
      assert.equal(rejectData.error?.code || rejectData.code, "START_IMMEDIATELY_NOT_ALLOWED");

      // 9b. Successfully creates bot in stopped / pending state
      const createPayload = JSON.stringify({
        name: "Bot Con Thử Nghiệm",
        imei: "123456789012345",
        cookie: JSON.stringify({ zpw_sek: "dummy_sek" }),
        ownerUid: "999888777",
      });
      const createRes = await fetch(`${baseUrl}/bridge/bots`, {
        method: "POST",
        headers: makeHmacHeaders(secret, createPayload),
        body: createPayload,
      });
      assert.equal(createRes.status, 200);
      const createData = await createRes.json();
      assert.equal(createData.success, true);
      assert.equal(createData.data.bot.status, "stopped");
      assert.equal(createData.data.bot.desiredStatus, "stopped");
      assert.equal(createData.data.bot.trialStatus, "pending");
      const createdBotId = createData.data.id;
      assert.ok(createdBotId);

      // 9c. Update credentials keeping stopped state
      const credPayload = JSON.stringify({
        imei: "987654321098765",
        cookie: JSON.stringify({ zpw_sek: "new_sek" }),
      });
      const credRes = await fetch(`${baseUrl}/bridge/bots/${createdBotId}/credentials`, {
        method: "POST",
        headers: makeHmacHeaders(secret, credPayload),
        body: credPayload,
      });
      assert.equal(credRes.status, 200);
      const credData = await credRes.json();
      assert.equal(credData.success, true);
      assert.equal(credData.data.status, "stopped");

      // 9d. Query QR status for child bot
      const qrStatusRes = await fetch(`${baseUrl}/bridge/bots/${createdBotId}/qr/status`, {
        headers: makeHmacHeaders(secret),
      });
      assert.equal(qrStatusRes.status, 200);
      const qrStatusData = await qrStatusRes.json();
      assert.equal(qrStatusData.success, true);
      assert.ok(qrStatusData.data.state !== undefined);

      // 9e. Reconciliation reports old SQLite records without resurrecting bots.
      const reconcilePayload = JSON.stringify({
        bots: [
          {
            key: "bot-sqlite-imported",
            displayName: "Bot From SQLite",
            uid: "imported_uid_555",
            ownerUid: "owner_123",
            expiry: "pending",
          },
        ],
      });
      const reconcileRes = await fetch(`${baseUrl}/bridge/reconcile-sqlite`, {
        method: "POST",
        headers: makeHmacHeaders(secret, reconcilePayload),
        body: reconcilePayload,
      });
      assert.equal(reconcileRes.status, 200);
      const reconcileData = await reconcileRes.json();
      assert.equal(reconcileData.success, true);
      assert.equal(reconcileData.data.imported, 0);
      assert.equal(reconcileData.data.reportOnly, true);
      assert.equal(reconcileData.data.unresolved.length, 1);
      const inventory = JSON.parse(await fs.readFile(path.join(tempRoot, "mybot", "mybots.json"), "utf8"));
      assert.equal(inventory["bot-sqlite-imported"], undefined);

    } finally {
      await bridge.stop();
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
});
