import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { registerDashboardApi } from "../src/dashboard/api-routes.js";
import { createWebAdminRecoveryCoordinator } from "../src/dashboard/v4-control-routes.js";
import { registerInternalCommandRoutes } from "../src/web-service/internal-command-route.js";

async function startTempApiServer(tempRoot) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.dashboardSession = { username: "admin", isAdmin: true, role: "system_admin" };
    next();
  });
  registerDashboardApi(app, { root: tempRoot });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("V4 Control Center routes on V3: create bot, 17-shield settings, expiry, remote console, doctor & redacted backup", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-v4-dash-"));
  try {
    await fs.mkdir(path.join(tempRoot, "mybot", "state"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "assets", "data"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "100001", cookieDead: true }, null, 2),
      "utf8"
    );

    const srv = await startTempApiServer(tempRoot);
    try {
      // 1. Create sub-bot
      const createRes = await fetch(`${srv.baseUrl}/api/bots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botKey: "sub_alpha",
          displayName: "Bot Thuê Alpha",
          ownerUid: "849999",
          prefix: "?",
          expiryPreset: "+7d",
        }),
      });
      assert.equal(createRes.status, 201);
      const createBody = await createRes.json();
      assert.equal(createBody.success, true);
      assert.equal(createBody.data.bot.id, "sub_alpha");

      // 2. Extend expiry to permanent
      const expRes = await fetch(`${srv.baseUrl}/api/bots/sub_alpha/expiry`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset: "permanent" }),
      });
      assert.equal(expRes.status, 200);
      const expBody = await expRes.json();
      assert.equal(expBody.data.expiryAt, "-1");

      // 3. Save 17 Anti-Shields for a group
      const shieldRes = await fetch(`${srv.baseUrl}/api/bots/sub_alpha/groups/99887766/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Nhóm Kiểm Duyệt VIP",
          settings: {
            activeBot: true,
            antiSpam: true,
            antiUndo: true,
            antiNude: true,
            removeLinks: true,
          },
        }),
      });
      assert.equal(shieldRes.status, 200);
      const shieldBody = await shieldRes.json();
      assert.equal(shieldBody.data.settings.antiUndo, true);
      assert.equal(shieldBody.data.settings.antiNude, true);

      const groupsRes = await fetch(`${srv.baseUrl}/api/bots/sub_alpha/groups`);
      const groupsBody = await groupsRes.json();
      assert.equal(groupsBody.data.groups.length, 1);
      assert.equal(groupsBody.data.groups[0].settings.removeLinks, true);

      // 4. Remote Command Console simulation
      const cmdRes = await fetch(`${srv.baseUrl}/api/bots/sub_alpha/remote/execute-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandLine: "menu", deliverToZalo: false }),
      });
      assert.equal(cmdRes.status, 200);
      const cmdBody = await cmdRes.json();
      assert.equal(cmdBody.success, true);

      // 5. System Doctor & Safe Backup Download
      const docRes = await fetch(`${srv.baseUrl}/api/system/doctor`);
      assert.equal(docRes.status, 200);
      const docBody = await docRes.json();
      assert.ok(Array.isArray(docBody.data.checks));

      const backupRes = await fetch(`${srv.baseUrl}/api/system/backup/download`);
      assert.equal(backupRes.status, 200);
      const backupText = await backupRes.text();
      assert.ok(backupText.includes("mybot-safe-backup-v4"));
      assert.ok(!backupText.includes("zpw_sek"));
    } finally {
      await srv.close();
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("WebAdminRecoveryCoordinator holds 60s uid_mismatch_confirm and applies on confirmSwap", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-v4-qr-"));
  try {
    await fs.mkdir(path.join(tempRoot, "mybot", "state"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "OLD_ADMIN_111", cookieDead: true }, null, 2),
      "utf8"
    );

    const events = [];
    const coord = createWebAdminRecoveryCoordinator({
      root: tempRoot,
      getIo: () => ({ emit: (ev, payload) => events.push({ ev, state: payload.state }) }),
      qrModuleLoader: async () => ({
        authenticateZalo: async ({ onQrReady, onStatus }) => {
          await onQrReady?.("mem.png", { data: { image: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } });
          onStatus?.("waiting_confirm");
          return {
            success: true,
            resultData: { imei: "imei-new-999", name: "Admin Mới", avatar: "" },
            rawCookies: {
              url: "https://chat.zalo.me",
              cookies: [{ domain: ".chat.zalo.me", name: "zpw_sek", path: "/", value: "sek_test" }],
            },
          };
        },
      }),
      zaloModuleLoader: async () => ({
        Zalo: class MockZalo {
          constructor() {
            this.userId = "NEW_ADMIN_222";
          }
          async login() {
            return {
              assertReady() {},
              async getUserInfo() {
                return { changed_profiles: { NEW_ADMIN_222: { displayName: "Admin Mới" } } };
              },
              listener: { ws: { close() {} } },
            };
          }
        },
      }),
    });

    await coord.start({ allowAccountChange: false });
    // Wait briefly for async flow to reach uid_mismatch_confirm
    for (let i = 0; i < 30; i += 1) {
      if (coord.getSnapshot().state === "uid_mismatch_confirm") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const snap = coord.getSnapshot();
    assert.equal(snap.state, "uid_mismatch_confirm");
    assert.equal(snap.expectedUid, "OLD_ADMIN_111");
    assert.equal(snap.scannedUid, "NEW_ADMIN_222");

    const confirmed = await coord.confirmSwap();
    assert.equal(confirmed.state, "success");

    const updatedState = JSON.parse(await fs.readFile(path.join(tempRoot, "mybot", "state", "admin.json"), "utf8"));
    assert.equal(updatedState.uid, "NEW_ADMIN_222");
    assert.equal(updatedState.cookieDead, false);
    assert.ok(events.some((e) => e.state === "uid_mismatch_confirm"));
    assert.ok(events.some((e) => e.state === "success"));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("V3 Web Console remote execute runs live command handler on Main Admin Bot (dry-run & Zalo delivery)", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-v4-remote-cmd-"));
  let bridgeServer = null;
  let dashServer = null;
  try {
    await fs.mkdir(path.join(tempRoot, "mybot", "state"), { recursive: true });
    let liveZaloTransmissions = 0;

    // Mock Main Bot bridge server with numeric Zalo UID ("100001") while Dashboard targets "admin"
    class MockPrototypeZaloApi {
      getBotId() {
        return "100001";
      }
      async getGroupInfo(gid) {
        return { gridInfoMap: { [gid]: { name: "Nhóm Test" } } };
      }
      async sendMessage(payload) {
        liveZaloTransmissions += 1;
        return { msgId: "live_1", echo: payload };
      }
    }

    const bridgeApp = express();
    bridgeApp.use(express.json());
    registerInternalCommandRoutes(bridgeApp, {
      api: new MockPrototypeZaloApi(),
      projectRoot: tempRoot,
      commandHandlers: {
        handleCommandPrivate: async (api, message, auth) => {
          const bid = api.getBotId();
          await api.sendMessage(
            `[REAL_PRIVATE_HANDLER bid=${bid} high=${auth.isAdminLevelHigh}] ${message.data.content}`,
            message.threadId,
            message.type
          );
        },
        handleCommand: async (api, message, _gInfo, _gAdmins, _gSettings, isHigh) => {
          // Verify prototype method (`getBotId`) still works through executionApi Proxy!
          const bid = api.getBotId();
          await api.sendMessage(
            `[REAL_GROUP_HANDLER bid=${bid} high=${isHigh}] ${message.data.content}`,
            message.threadId,
            message.type
          );
        },
      },
    });
    bridgeServer = createServer(bridgeApp);
    await new Promise((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve));
    const bridgePort = bridgeServer.address().port;

    await fs.writeFile(
      path.join(tempRoot, "mybot", "state", "admin.json"),
      JSON.stringify({
        uid: "100001",
        status: "running",
        webPort: bridgePort,
        wsConnected: true,
        cookieDead: false,
      }),
      "utf8"
    );

    dashServer = await startTempApiServer(tempRoot);

    // 1. Dry-run on Web Console (`deliverToZalo: false`): runs real handler, captures output, 0 Zalo transmissions!
    const dryRes = await fetch(`${dashServer.baseUrl}/api/bots/admin/remote/execute-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandLine: "mybot list",
        threadId: "web_remote_console",
        deliverToZalo: false,
      }),
    });
    assert.equal(dryRes.status, 200);
    const dryJson = await dryRes.json();
    assert.equal(dryJson.success, true);
    assert.equal(dryJson.data.executed, true);
    assert.equal(dryJson.data.deliveredToZalo, false);
    assert.match(dryJson.data.replyText, /REAL_PRIVATE_HANDLER bid=100001 high=true/);
    assert.equal(liveZaloTransmissions, 0);

    // 2. Live delivery to a real Zalo group (`deliverToZalo: true`): transmits once to Zalo!
    const liveRes = await fetch(`${dashServer.baseUrl}/api/bots/admin/remote/execute-command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commandLine: "menu",
        threadId: "888999000",
        deliverToZalo: true,
      }),
    });
    assert.equal(liveRes.status, 200);
    const liveJson = await liveRes.json();
    assert.equal(liveJson.success, true);
    assert.equal(liveJson.data.deliveredToZalo, true);
    assert.match(liveJson.data.replyText, /REAL_GROUP_HANDLER bid=100001 high=true/);
    assert.equal(liveZaloTransmissions, 1);
  } finally {
    if (dashServer) await dashServer.close();
    if (bridgeServer) await new Promise((resolve) => bridgeServer.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
