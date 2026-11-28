import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeBridgeService } from "../src/dashboard/node-bridge-service.js";
import { createBotReadinessService } from "../src/runtime/runtime-readiness.js";

test("admin grants require a live matching supervisor, account, key, PID and roster response identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "admin-binding-"));
  const botKey = "bot_binding_test";
  const accountUid = "account_123";
  const friendUid = "child_friend_456";
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({ [botKey]: { botKey, accountUid, uid: accountUid, accountIdentityStatus: "verified", webPort: 3001, status: "running" } }));
  // This stale file must never itself authorize friendUid.
  await fs.writeFile(path.join(root, "mybot", "state", `${botKey}.json`), JSON.stringify({ connected: true, uid: friendUid }));
  const valid = { kind: "child", botKey, liveZaloUid: accountUid, pid: 777, listenerConnected: true };
  let identity = { ...valid, botKey: "foreign_bot" };
  let rosterIdentity = valid;
  let processOnline = true;
  let friendsReads = 0;
  const adminReadiness = createBotReadinessService({
    adapter: { listMyBotProcesses: async () => processOnline ? [{ name: botKey, status: "online", pid: 777 }] : [] },
    portProbe: async () => true, identityFetcher: async () => identity,
  });
  const secret = "admin-runtime-binding-secret";
  const bridge = new NodeBridgeService({ root, port: 0, secret, adminReadiness,
    fetchChildFriends: async () => { friendsReads++; return { online: true, friends: [{ uid: friendUid }], identity: rosterIdentity }; },
  });
  const port = await bridge.start();
  async function add() {
    const raw = JSON.stringify({ uid: friendUid }); const ts = Date.now();
    return fetch(`http://127.0.0.1:${port}/bridge/bots/${botKey}/admins`, { method: "POST", body: raw, headers: { "content-type": "application/json", "x-request-id": crypto.randomUUID(), "x-internal-timestamp": String(ts), "x-internal-signature": crypto.createHmac("sha256", secret).update(`${ts}.${raw}`).digest("hex") } });
  }
  try {
    for (const invalid of [{ botKey: "foreign_bot" }, { liveZaloUid: "foreign_account" }, { pid: 888 }, { listenerConnected: false }]) {
      identity = { ...valid, ...invalid };
      const response = await add();
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.equal((await response.json()).error.code, "CHILD_ADMIN_VERIFICATION_REQUIRED");
    }
    assert.equal(friendsReads, 0);
    identity = valid; processOnline = false;
    assert.equal((await add()).status, 400);
    processOnline = true;
    for (const invalid of [undefined, { ...valid, botKey: "foreign_bot" }, { ...valid, liveZaloUid: "foreign_account" }, { ...valid, pid: 888 }]) {
      rosterIdentity = invalid;
      assert.equal((await add()).status, 400);
    }
    rosterIdentity = valid;
    assert.equal((await add()).status, 200);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "mybot", "instances", botKey, "data", "admin-list.json"), "utf8")), [friendUid]);
  } finally { await bridge.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
