import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeBridgeService } from "../src/dashboard/node-bridge-service.js";

test("hybrid profile, style, expiry, prefix and admin routes write canonical Node data", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hybrid-data-"));
  const secret = "test-shared-node-data";
  const botId = "bot_stable_key";
  const dataDir = path.join(root, "mybot", "instances", botId, "data");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({ [botId]: { uid: "account_123", ownerUid: "main_owner", status: "stopped", accountIdentityStatus: "verified" } }));
  await fs.writeFile(path.join(dataDir, "command.json"), '{"prefix":"!","custom":true}');
  const bridge = new NodeBridgeService({ root, port: 0, secret, verifyChildAdminUid: async (_, uid) => uid === "child_verified_uid" });
  const port = await bridge.start();
  async function call(route, method = "GET", body) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, body: raw || undefined, headers: { "content-type": "application/json", "x-internal-timestamp": String(ts), "x-internal-signature": crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex"), "x-request-id": crypto.randomUUID() } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).data;
  }
  try {
    const tsCreate = Date.now();
    const invalidBody = JSON.stringify({ ownerUid: "owner", cookie: "broken", imei: "imei" });
    const invalid = await fetch(`http://127.0.0.1:${port}/bridge/bots`, { method: "POST", body: invalidBody, headers: { "content-type": "application/json", "x-internal-timestamp": String(tsCreate), "x-internal-signature": crypto.createHmac("sha256", secret).update(`${tsCreate}.${invalidBody}`).digest("hex") } });
    assert.equal(invalid.status, 400);
    assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"))).length, 1);
    const profile = await call(`/bridge/bots/${botId}/profile`, "PUT", { nameServer: "New Bot Name", description: "Kept by Node" });
    assert.equal(profile.profile.nameServer, "New Bot Name");
    assert.equal((await call(`/bridge/bots/${botId}/profile`)).profile.description, "Kept by Node");
    await call(`/bridge/bots/${botId}/prefix`, "PUT", { prefix: "?" });
    const command = JSON.parse(await fs.readFile(path.join(dataDir, "command.json"), "utf8"));
    assert.equal(command.prefix, "?");
    assert.equal(command.custom, true);
    const requestId = crypto.randomUUID();
    async function prefixRequest(prefix) {
      const raw = JSON.stringify({ prefix });
      const timestamp = Date.now();
      return fetch(`http://127.0.0.1:${port}/bridge/bots/${botId}/prefix`, { method: "PUT", body: raw, headers: { "content-type": "application/json", "x-request-id": requestId, "x-internal-timestamp": String(timestamp), "x-internal-signature": crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex") } });
    }
    assert.equal((await prefixRequest("!")).status, 200);
    assert.equal((await prefixRequest("#")).status, 409);
    await call(`/bridge/bots/${botId}/expiry`, "PUT", { preset: "7d" });
    const registry = JSON.parse(await fs.readFile(path.join(root, "mybot", "mybots.json"), "utf8"));
    assert.equal(registry[botId].expiryAt, null);
    assert.equal(registry[botId].activationPolicy.durationMs, 7 * 86400000);
    await call(`/bridge/bots/${botId}/admins`, "POST", { uid: "child_verified_uid", verifiedInChildSession: true });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, "admin-list.json"), "utf8")), ["child_verified_uid"]);
    await call(`/bridge/bots/${botId}/settings`, "PUT", { groupEnabled: false, privateEnabled: true });
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, "web-config.json"), "utf8")).groupEnabled, false);
    const wrongBotOperation = bridge.actions.getOperation;
    bridge.actions.getOperation = () => ({ botId: "other_bot", operationId: "op1", phase: "ws_ready" });
    const ts = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/bridge/bots/${botId}/operations/op1`, { headers: { "x-internal-timestamp": String(ts), "x-internal-signature": crypto.createHmac("sha256", secret).update(`${ts}.`).digest("hex") } });
    assert.equal(response.status, 404);
    bridge.actions.getOperation = wrongBotOperation;
  } finally { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
