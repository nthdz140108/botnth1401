import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { ControlPlaneStore } from "../src/dashboard/v5/control-store.js";
import { computeTotpCode } from "../src/dashboard/v5/iam-service.js";
import { countSpintaxVariants, parseSpintax } from "../src/dashboard/v5/campaign-media-service.js";

test("ControlPlaneStore native node:sqlite WAL mode persists and closes cleanly", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-v5-sqlite-wal-"));
  try {
    const store = new ControlPlaneStore({ root: tempRoot, forceSqlite: true });
    assert.equal(store.backend, "sqlite");
    store.setDoc("test_ns", "alpha", { ok: true, count: 42 });
    assert.deepEqual(store.getDoc("test_ns", "alpha"), { ok: true, count: 42 });
    store.close();
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

async function startTempV5Server(tempRoot) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    if (!req.path.startsWith("/v5-auth") && !req.path.startsWith("/v5-portal")) {
      req.dashboardSession = { username: "admin", isAdmin: true, role: "system_admin" };
    }
    next();
  });
  registerDashboardApi(app, { root: tempRoot });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      try {
        app.locals?.v5?.sreService?.stop?.();
        app.locals?.v5?.campaignService?.stop?.();
        app.locals?.v5?.store?.close?.();
      } catch {}
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("V5 Enterprise Control Plane: PWA, IAM RBAC + 2FA, SaaS CRM + Vouchers, Shield Presets, Campaigns, Media, Simulator & Encrypted Snapshot Vault", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-v5-enterprise-"));
  let srv = null;
  try {
    await fs.mkdir(path.join(tempRoot, "mybot", "state"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "mybot", "bots"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "assets", "data"), { recursive: true });

    await fs.writeFile(
      path.join(tempRoot, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "100001", status: "running", cookieDead: false }, null, 2),
      "utf8"
    );

    srv = await startTempV5Server(tempRoot);

    // 1. PWA Manifest & Service Worker
    const manifestRes = await fetch(`${srv.baseUrl}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    const manifest = await manifestRes.json();
    assert.ok(manifest.name.includes("MYBOT"));

    const swRes = await fetch(`${srv.baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    const swText = await swRes.text();
    assert.ok(swText.includes("Service Worker"));

    // 2. V4 Parity Fixes: /api/studio/commands & /api/bots/:id/groups/enable-all
    const studioCmdsRes = await fetch(`${srv.baseUrl}/api/studio/commands`);
    assert.equal(studioCmdsRes.status, 200);
    const studioCmdsBody = await studioCmdsRes.json();
    assert.equal(studioCmdsBody.success, true);
    assert.ok(Array.isArray(studioCmdsBody.data.commands));

    // Create a rented sub-bot for SaaS CRM & Tenant Portal tests
    const createBotRes = await fetch(`${srv.baseUrl}/api/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        botKey: "bot_vip_01",
        displayName: "Bot VIP 01",
        ownerUid: "84912345678",
        prefix: "!",
        expiryPreset: "+1d",
      }),
    });
    assert.equal(createBotRes.status, 201);

    // 3. Shield Presets & Unified Group Settings Sync
    const putGroupRes = await fetch(`${srv.baseUrl}/api/bots/bot_vip_01/groups/55667788/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Nhóm Cộng Đồng VIP",
        settings: { enableBot: true, antiLink: true, antiUndo: true },
      }),
    });
    assert.equal(putGroupRes.status, 200);
    const putGroupBody = await putGroupRes.json();
    assert.equal(putGroupBody.data.settings.activeBot, true);
    assert.equal(putGroupBody.data.settings.enableBot, true);
    assert.equal(putGroupBody.data.settings.removeLinks, true);

    const presetsRes = await fetch(`${srv.baseUrl}/api/v5/shields/presets`);
    assert.equal(presetsRes.status, 200);
    const presetsBody = await presetsRes.json();
    assert.ok(presetsBody.data.presets.length >= 4);

    const applyPresetRes = await fetch(`${srv.baseUrl}/api/v5/bots/bot_vip_01/groups/apply-preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presetId: "strict_security", threadIds: ["55667788"] }),
    });
    assert.equal(applyPresetRes.status, 200);

    const enableAllRes = await fetch(`${srv.baseUrl}/api/bots/bot_vip_01/groups/enable-all`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(enableAllRes.status, 200);
    const enableAllBody = await enableAllRes.json();
    assert.ok(enableAllBody.data.updatedCount >= 1);

    // 4. SaaS CRM, Batch Voucher Generation & Redemption
    const batchRes = await fetch(`${srv.baseUrl}/api/v5/crm/vouchers/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prefix: "VIP30",
        count: 3,
        durationPreset: "+30d",
        priceVnd: 150000,
        maxUses: 1,
        tier: "vip",
      }),
    });
    assert.equal(batchRes.status, 201);
    const batchBody = await batchRes.json();
    assert.equal(batchBody.data.vouchers.length, 3);
    const voucherCode = batchBody.data.vouchers[0].code;

    const redeemRes = await fetch(`${srv.baseUrl}/api/v5/crm/vouchers/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: voucherCode, botId: "bot_vip_01", ownerUid: "84912345678" }),
    });
    assert.equal(redeemRes.status, 200);
    const redeemBody = await redeemRes.json();
    assert.equal(redeemBody.data.redeemed, true);

    const crmRes = await fetch(`${srv.baseUrl}/api/v5/crm/summary`);
    assert.equal(crmRes.status, 200);
    const crmBody = await crmRes.json();
    assert.ok(crmBody.data.kpis.totalRedemptions >= 1);

    // 5. IAM RBAC, 2FA TOTP & Tenant Owner Token Login
    const createOpRes = await fetch(`${srv.baseUrl}/api/v5/iam/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator_nam",
        password: "StrongPassword123!",
        role: "operator",
        displayName: "Vận Hành Viên Nam",
      }),
    });
    assert.equal(createOpRes.status, 201);

    const setup2faRes = await fetch(`${srv.baseUrl}/api/v5/iam/2fa/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator_nam" }),
    });
    assert.equal(setup2faRes.status, 200);
    const setup2faBody = await setup2faRes.json();
    const validTotp = computeTotpCode(setup2faBody.data.secret);

    const enable2faRes = await fetch(`${srv.baseUrl}/api/v5/iam/2fa/enable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator_nam", code: validTotp }),
    });
    assert.equal(enable2faRes.status, 200);

    // Login without TOTP should return 401 TOTP_REQUIRED
    const noTotpLogin = await fetch(`${srv.baseUrl}/v5-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator_nam", password: "StrongPassword123!" }),
    });
    assert.equal(noTotpLogin.status, 401);

    // Login with valid TOTP succeeds
    const okTotpLogin = await fetch(`${srv.baseUrl}/v5-auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "operator_nam",
        password: "StrongPassword123!",
        totpCode: computeTotpCode(setup2faBody.data.secret),
      }),
    });
    assert.equal(okTotpLogin.status, 200);

    // Owner Magic Token & Tenant Isolation
    const tokenRes = await fetch(`${srv.baseUrl}/api/v5/iam/owner-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ownerUid: "84912345678",
        botIds: ["bot_vip_01"],
        displayName: "Khách VIP 01",
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenBody = await tokenRes.json();
    assert.ok(tokenBody.data.accessCode.startsWith("OWN-"));

    // 6. Spintax, Media Upload & Simulator
    assert.equal(countSpintaxVariants("{A|B|C} {1|2}"), 6);
    const renderedSpin = parseSpintax("{Xin chào|Hello} {groupName}!", { groupName: "Box Alpha" });
    assert.ok(renderedSpin.includes("Box Alpha"));

    const onePixelPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const mediaRes = await fetch(`${srv.baseUrl}/api/v5/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "banner.png",
        mimeType: "image/png",
        dataBase64: onePixelPngBase64,
      }),
    });
    assert.equal(mediaRes.status, 201);
    const mediaBody = await mediaRes.json();
    assert.ok(mediaBody.data.id);

    const simRes = await fetch(`${srv.baseUrl}/api/v5/studio/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandName: "menu",
        botId: "bot_vip_01",
        threadId: "55667788",
        senderRole: "member",
      }),
    });
    assert.equal(simRes.status, 200);

    // 7. Telemetry Time-Series & Encrypted Snapshot Vault
    const telemRes = await fetch(`${srv.baseUrl}/api/v5/telemetry/series?range=24h`);
    assert.equal(telemRes.status, 200);
    const telemBody = await telemRes.json();
    assert.ok(Array.isArray(telemBody.data.series));
    assert.ok(telemBody.data.series.length > 0);

    const snapCreateRes = await fetch(`${srv.baseUrl}/api/v5/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Before Upgrade",
        password: "VaultSecretPassword99!",
        includeSecrets: false,
      }),
    });
    assert.equal(snapCreateRes.status, 201);
    const snapBody = await snapCreateRes.json();
    const snapId = snapBody.data.id;

    const previewRestoreRes = await fetch(`${srv.baseUrl}/api/v5/snapshots/preview-restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: snapId, password: "VaultSecretPassword99!" }),
    });
    assert.equal(previewRestoreRes.status, 200);
    const previewBody = await previewRestoreRes.json();
    assert.equal(previewBody.success, true);
  } finally {
    if (srv) await srv.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
