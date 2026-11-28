import test from "node:test";
import assert from "node:assert/strict";
import { QrSessionManager } from "../src/dashboard/qr-session.js";

const setup = (overrides = {}) => {
  const calls = [];
  const manager = new QrSessionManager({
    initSession: async () => ({ secret: "hidden" }), verifyClient: async (s) => s,
    generateQr: async () => ["code", { secret: "hidden" }], readQr: async () => "data:image/png;base64,qr",
    waitScan: async () => true, waitConfirm: async () => [{ imei: "imei", cookie: { zpw_sek: "x" } }, { cookies: [{ name: "zpw_sek", value: "secret" }] }],
    verifyAccount: async () => ({ uid: "verified-account" }),
    writeCredential: async (id, value) => calls.push([id, value]), timeoutMs: 1000, ...overrides,
  });
  return { manager, calls };
};

test("QR manager exposes only public state and writes credential after confirm", async () => {
  const { manager, calls } = setup();
  const started = await manager.start("bot-1");
  assert.equal(started.state, "waiting_scan");
  assert.equal(started.qrImage, "data:image/png;base64,qr");
  assert.equal("session" in started, false);
  assert.equal(started.active, true);
  assert.equal(typeof started.createdAt, "number");
  assert.equal(typeof started.remainingMs, "number");
  for (let i = 0; i < 10 && manager.get("bot-1")?.state !== "configured"; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.get("bot-1").state, "configured");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].cookie.cookies.length, 1);
});

test("QR manager rejects concurrent sessions and supports cancellation", async () => {
  let release;
  const { manager } = setup({ waitScan: () => new Promise((resolve) => { release = resolve; }) });
  await manager.start("bot-1");
  await assert.rejects(() => manager.start("bot-2"), /another QR login/i);
  assert.equal(manager.cancel("bot-1"), true);
  release(true);
});

test("QR manager can list active sessions and honor a higher concurrency limit", async () => {
  const releases = [];
  let qrCounter = 0;
  const { manager } = setup({
    maxConcurrentSessions: 2,
    waitScan: (_code, _session, signal) => new Promise((resolve) => {
      releases.push(resolve);
      signal?.addEventListener("abort", () => resolve(false), { once: true });
    }),
    generateQr: async (_session) => {
      const code = `code-${++qrCounter}`;
      return [code, { secret: "hidden" }];
    },
  });

  await manager.start("bot-1");
  await manager.start("bot-2");

  const sessions = manager.list();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((session) => session.botId).sort(), ["bot-1", "bot-2"]);
  assert.equal(sessions.every((session) => session.active === true), true);
  assert.equal(manager.activeCount(), 2);

  await assert.rejects(() => manager.start("bot-3"), /concurrency limit/i);
  manager.cancel("bot-1");
  manager.cancel("bot-2");
  for (const release of releases) release(true);
});

test("cancellation prevents a late QR result from writing credentials", async () => {
  let release;
  const { manager, calls } = setup({ waitScan: () => new Promise((resolve) => { release = resolve; }) });
  await manager.start("bot-1");
  manager.cancel("bot-1");
  release(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 0);
  assert.equal(manager.get("bot-1").state, "cancelled");
});

test("QR manager never writes credential when confirmation fails", async () => {
  const { manager, calls } = setup({ waitConfirm: async () => [null, null] });
  await manager.start("bot-1");
  for (let i = 0; i < 10 && !["failed", "expired"].includes(manager.get("bot-1")?.state); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 0);
  assert.equal(manager.get("bot-1").state, "failed");
});

test("QR manager passes bot and session context into every dependency", async () => {
  const calls = [];
  const manager = new QrSessionManager({
    initSession: async (context) => {
      calls.push(["initSession", context]);
      return { sessionId: context.sessionId };
    },
    verifyClient: async (session) => {
      calls.push(["verifyClient", session]);
      return { ...session, verified: true };
    },
    generateQr: async (session, context) => {
      calls.push(["generateQr", session, context]);
      return ["code-context", { ...session, qrImage: "data:image/png;base64,qr" }];
    },
    readQr: async (session, context) => {
      calls.push(["readQr", session, context]);
      return session.qrImage;
    },
    waitScan: async () => true,
    waitConfirm: async () => [{ imei: "imei", cookie: { zpw_sek: "x" } }, { cookies: [{ name: "zpw_sek", value: "secret" }] }],
    verifyAccount: async () => ({ uid: "verified-account" }),
    writeCredential: async (id, value, session) => {
      calls.push(["writeCredential", id, value, session]);
    },
    timeoutMs: 1000,
  });

  await manager.start("bot-context");
  for (let i = 0; i < 20 && !calls.some(([name]) => name === "writeCredential"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.deepEqual(calls[0][0], "initSession");
  assert.equal(calls[0][1].botId, "bot-context");
  assert.equal(typeof calls[0][1].sessionId, "string");
  assert.deepEqual(calls[1], ["verifyClient", { sessionId: calls[0][1].sessionId }]);
  assert.equal(calls[2][0], "generateQr");
  assert.equal(calls[2][2].botId, "bot-context");
  assert.equal(calls[2][2].sessionId, calls[0][1].sessionId);
  assert.equal(calls[3][0], "readQr");
  assert.equal(calls[3][2].botId, "bot-context");
  assert.equal(calls[3][2].sessionId, calls[0][1].sessionId);
  assert.equal(calls.some(([name]) => name === "writeCredential"), true);
});

test("QR manager expires and aborts a scan that outlives its deadline", async () => {
  let release;
  let aborted = false;
  const { manager, calls } = setup({
    timeoutMs: 20,
    waitScan: (_code, _session, signal) => new Promise((resolve) => {
      release = () => resolve(true);
      signal?.addEventListener("abort", () => { aborted = true; });
    }),
  });

  await manager.start("bot-expired");
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(manager.get("bot-expired").state, "expired");
  assert.equal(aborted, true);
  assert.equal(calls.length, 0);

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(manager.get("bot-expired").state, "expired");
  assert.equal(calls.length, 0);
});

test("QR manager supports unlimited concurrent sessions when maxConcurrentSessions is 0 or Infinity", async () => {
  const releases = [];
  let qrCounter = 0;
  const { manager } = setup({
    maxConcurrentSessions: 0,
    waitScan: (_code, _session, signal) => new Promise((resolve) => {
      releases.push(resolve);
      signal?.addEventListener("abort", () => resolve(false), { once: true });
    }),
    generateQr: async () => [`code-${++qrCounter}`, { secret: "hidden" }],
  });

  assert.equal(manager.maxConcurrentSessions, Infinity);
  for (let i = 1; i <= 10; i++) {
    await manager.start(`bot-unlimited-${i}`);
  }
  assert.equal(manager.activeCount(), 10);
  for (let i = 1; i <= 10; i++) {
    manager.cancel(`bot-unlimited-${i}`);
  }
  for (const r of releases) r(true);
});
