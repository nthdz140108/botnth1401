import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeBridgeService } from "../src/dashboard/node-bridge-service.js";

const waitUntil = async (predicate) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail("QR state did not settle"); };

for (const outcome of ["cancelled", "failed", "configured"]) {
  test(`new dashboard QR ${outcome}: persist only a verified account under its proposed stable key`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-draft-"));
    let releaseScan;
    const scanned = new Promise(resolve => { releaseScan = resolve; });
    const secret = "draft-test-secret";
    const bridge = new NodeBridgeService({ root, port: 0, secret,
      verifyCredential: async () => ({ uid: "account_verified_123", displayName: "Verified Account" }),
      qrModuleLoader: async () => ({ initSession: async () => ({ qrImage: "data:image/png;base64,AA==" }), verifyClient: async session => session,
        generateQRCode: async session => { if (outcome === "failed") throw new Error("QR_GENERATION_FAILED"); return ["qr-code", session]; },
        waitingScan: async () => scanned,
        waitingConfirm: async () => [{ imei: "test-imei", userAgent: "test-agent" }, [{ name: "zpw_sek", value: "fixture-cookie" }]],
      }),
    });
    const port = await bridge.start();
    async function request(route, body = {}) {
      const raw = JSON.stringify(body); const timestamp = Date.now();
      return fetch(`http://127.0.0.1:${port}${route}`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-internal-timestamp": String(timestamp), "x-internal-signature": crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex"), "x-request-id": crypto.randomUUID() } });
    }
    try {
      const response = await request("/bridge/bots", { ownerUid: "main_owner", expiryPreset: "7d" });
      assert.equal(response.status, 200, await response.clone().text());
      const created = (await response.json()).data;
      const botKey = created.botKey;
      assert.equal(await fs.stat(path.join(root, "mybot", "mybots.json")).then(() => true, () => false), false);
      assert.equal(await fs.stat(path.join(root, "mybot", "instances", botKey)).then(() => true, () => false), false);
      const started = await request(`/bridge/bots/${botKey}/qr/start`);
      if (outcome === "failed") {
        assert.equal(started.status, 502);
        assert.equal(bridge.botDrafts.size, 0);
      } else {
        assert.equal(started.status, 200, await started.clone().text());
        assert.match(botKey, /^bot_[a-f0-9-]{36}$/);
        assert.equal(await fs.stat(path.join(root, "mybot", "mybots.json")).then(() => true, () => false), false);
        assert.equal(await fs.stat(path.join(root, "mybot", "instances", botKey)).then(() => true, () => false), false);
        if (outcome === "cancelled") {
          const cancelled = await request(`/bridge/bots/${botKey}/qr/cancel`);
          assert.equal(cancelled.status, 200);
          releaseScan(true);
          await waitUntil(() => bridge.botQrManager.get(botKey)?.state === "cancelled");
          assert.equal(bridge.botDrafts.size, 0);
        } else {
          releaseScan(true);
          await waitUntil(() => ["configured", "failed"].includes(bridge.botQrManager.get(botKey)?.state));
          assert.equal(bridge.botQrManager.get(botKey)?.state, "configured", JSON.stringify(bridge.botQrManager.get(botKey)));
          const registry = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
          assert.deepEqual(Object.keys(registry), [botKey]);
          assert.equal(registry[botKey].accountUid, "account_verified_123");
          assert.equal(registry[botKey].activationPolicy.durationMs, 7 * 86400000);
          assert.equal(bridge.botDrafts.size, 0);
        }
      }
      if (outcome !== "configured") assert.equal(await fs.stat(path.join(root, "mybot", "mybots.json")).then(() => true, () => false), false);
    } finally { releaseScan(false); await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); }
  });
}
