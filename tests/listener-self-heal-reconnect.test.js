import test from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { Listener } from "../src/api-zalo/apis/listen.js";
import { API, createLoginSession } from "../src/api-zalo/zalo.js";
import { appContext } from "../src/api-zalo/context.js";
import { createReconnectCoordinator } from "../src/core/reconnect-coordinator.js";
import { createRuntimeLifecycle } from "../src/core/runtime-lifecycle.js";
import {
  getListenerRuntimeState,
  resetListenerRuntimeState,
} from "../src/runtime/listener-state.js";

function encodeZaloFrame(version, cmd, subCmd, payloadObj) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const buf = Buffer.alloc(4 + jsonBytes.length);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint8(0, version);
  view.setInt32(1, cmd, true);
  view.setInt8(3, subCmd);
  jsonBytes.forEach((b, idx) => view.setUint8(4 + idx, b));
  return buf;
}

class FakeWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = WebSocket.CONNECTING;
    this.onopen = null;
    this.onerror = null;
    this.onclose = null;
    this.onmessage = null;
    this.pingCount = 0;
    this.terminated = false;
  }

  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(buf) {
    return this.onmessage?.({ data: buf });
  }

  simulateError(err) {
    const error = err instanceof Error ? err : new Error(String(err));
    this.onerror?.(error);
  }

  simulateClose(code = 1006, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  ping() {
    this.pingCount += 1;
    this.emit("ping_sent");
  }

  terminate() {
    this.terminated = true;
    this.simulateClose(1006, "terminated");
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WebSocket.CLOSED) return;
    this.simulateClose(code, reason);
  }

  send() {}
}

function setupAppContext() {
  appContext.cookie = "zpw_sek=initial_cookie";
  appContext.userAgent = "Mozilla/5.0 TestAgent";
  appContext.imei = "imei-test-123";
  appContext.uid = "10001";
  appContext.secretKey = Buffer.alloc(32, 1).toString("base64");
  appContext.options = appContext.options || {};
}

test("Listener.startAsync resolves immediately on Zalo key exchange (1,1)", async () => {
  resetListenerRuntimeState();
  setupAppContext();

  let createdSocket = null;
  const listener = new Listener("wss://ws1.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=100", {
    openSettleMs: 5000,
    handshakeTimeoutMs: 2000,
    wsPingIntervalMs: 0,
    zaloKeepAliveIntervalMs: 60_000,
    wsFactory: (url, opts) => {
      createdSocket = new FakeWebSocket(url, opts);
      queueMicrotask(async () => {
        createdSocket.simulateOpen();
        await createdSocket.simulateMessage(encodeZaloFrame(1, 1, 1, { key: "cipher_abc" }));
      });
      return createdSocket;
    },
  });

  const result = await listener.startAsync();
  assert.equal(result.keyExchanged, true);
  assert.equal(listener.cipherKey, "cipher_abc");
  listener.stop();
});

test("Listener.startAsync rejects with DUPLICATE_CONNECTION when kicked by cmd=3000 right after open", async () => {
  resetListenerRuntimeState();
  setupAppContext();

  const origConsoleError = console.error;
  console.error = () => {};
  try {
    const listener = new Listener("wss://ws1.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=100", {
      openSettleMs: 500,
      handshakeTimeoutMs: 2000,
      wsPingIntervalMs: 0,
      wsFactory: (url, opts) => {
        const ws = new FakeWebSocket(url, opts);
        queueMicrotask(async () => {
          ws.simulateOpen();
          await ws.simulateMessage(encodeZaloFrame(1, 3000, 0, {}));
        });
        return ws;
      },
    });

    await assert.rejects(
      () => listener.startAsync(),
      (err) => {
        assert.equal(err.code, "DUPLICATE_CONNECTION");
        assert.match(err.message, /code 3000/i);
        return true;
      }
    );
    listener.stop();
  } finally {
    console.error = origConsoleError;
  }
});

test("Listener refreshes t= timestamp, picks up updated appContext.cookie, and rotates wsEndpoints", () => {
  resetListenerRuntimeState();
  setupAppContext();

  const captured = [];
  const listener = new Listener("wss://ws1.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1000", {
    wsEndpoints: [
      "wss://ws1.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1000",
      "wss://ws2.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1000",
      "wss://ws3.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1000",
    ],
    wsPingIntervalMs: 0,
    wsFactory: (url, opts) => {
      const ws = new FakeWebSocket(url, opts);
      captured.push({ url, cookie: opts.headers.cookie, host: opts.headers.host });
      return ws;
    },
  });

  listener.start({ rotateEndpoint: false });
  appContext.cookie = "zpw_sek=rotated_runtime_cookie";
  listener.start({ rotateEndpoint: true });
  listener.start({ rotateEndpoint: true });

  assert.equal(captured.length, 3);
  assert.equal(captured[0].host, "ws1.chat.zalo.me");
  assert.equal(captured[0].cookie, "zpw_sek=initial_cookie");
  assert.notEqual(new URL(captured[0].url).searchParams.get("t"), "1000");

  assert.equal(captured[1].host, "ws2.chat.zalo.me");
  assert.equal(captured[1].cookie, "zpw_sek=rotated_runtime_cookie");

  assert.equal(captured[2].host, "ws3.chat.zalo.me");
  listener.stop();
});

test("Listener WS ping watchdog terminates unresponsive dead socket and emits closed reason", async () => {
  resetListenerRuntimeState();
  setupAppContext();

  let activeWs = null;
  let closePayload = null;
  const listener = new Listener("wss://ws1.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1", {
    wsPingIntervalMs: 25,
    wsPongTimeoutMs: 25,
    wsFactory: (url, opts) => {
      activeWs = new FakeWebSocket(url, opts);
      return activeWs;
    },
  });

  listener.on("closed", (_gen, info) => {
    closePayload = info;
  });

  listener.start();
  activeWs.simulateOpen();

  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(activeWs.pingCount >= 1, true);
  assert.equal(activeWs.terminated, true);
  assert.match(closePayload?.reason || "", /ping timeout/i);
  listener.stop();
});

test("createReconnectCoordinator preserves escalating attempts on flapping sockets within stableResetMs", async () => {
  const seenAttempts = [];
  const coordinator = createReconnectCoordinator({
    backoffSchedule: [15, 25, 35, 50],
    jitterRatio: 0,
    stableResetMs: 120,
    onReconnect: async (_api, meta) => {
      seenAttempts.push(meta.attempt);
    },
    logger: { warn: () => {}, error: () => {} },
  });

  // First disconnect -> attempt #1 resolves, enters 120ms stability window
  coordinator.schedule("closed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(seenAttempts, [1]);
  assert.equal(coordinator.stats().attempts, 1, "attempts must stay > 0 during stability window");

  // Socket drops again 10ms later (flapping!) -> must escalate to attempt #2 instead of resetting to #1
  coordinator.schedule("closed");
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(seenAttempts, [1, 2]);

  // Wait past stableResetMs -> attempts resets cleanly to 0
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(coordinator.stats().attempts, 0);
  coordinator.dispose();
});

test("createRuntimeLifecycle escalates to refreshSession after failed WS attempt and marks connected only when startAsync succeeds", async () => {
  resetListenerRuntimeState();
  setupAppContext();

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-selfheal-"));
  const botName = `test_selfheal_${Date.now()}`;
  const state = getListenerRuntimeState();
  state.setStartupPhase("listener-retrying");
  state.markRetrying("initial disconnect");

  let startCalls = 0;
  let refreshCalls = 0;
  let reconnectedHookCalls = 0;

  const mockListener = {
    wsEndpoints: ["wss://ws1.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1"],
    rotatedFlags: [],
    sessionRefreshed: false,
    async startAsync({ rotateEndpoint }) {
      startCalls += 1;
      this.rotatedFlags.push(rotateEndpoint);
      if (!this.sessionRefreshed) {
        throw new Error("Unexpected server response: 403");
      }
      const gen = state.beginConnection();
      return { generation: gen, keyExchanged: true };
    },
  };

  const mockApi = { listener: mockListener };

  const lifecycle = await createRuntimeLifecycle({
    projectRoot: tmpRoot,
    botName,
    api: mockApi,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    refreshSession: async (currApi) => {
      refreshCalls += 1;
      currApi.listener.sessionRefreshed = true;
      return currApi;
    },
    onListenerReconnected: async () => {
      reconnectedHookCalls += 1;
    },
    reconnectBackoffSchedule: [15, 25, 40],
    reconnectStableResetMs: 50,
  });

  try {
    lifecycle.reconnectCoordinator.schedule("closed");

    // Wait just past attempt #1 (~15ms): startAsync rejected -> listenerConnected MUST remain false!
    await new Promise((resolve) => setTimeout(resolve, 24));
    if (startCalls === 1) {
      assert.equal(state.getSnapshot().listenerConnected, false);
    }

    // Wait past attempt #2 (~25ms more): refreshSession runs -> startAsync resolves -> listenerConnected = true!
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(startCalls, 2);
    assert.equal(refreshCalls, 1);
    assert.equal(reconnectedHookCalls, 1);
    assert.equal(state.getSnapshot().listenerConnected, true);
    assert.equal(state.getSnapshot().listenerState, "connected");
    assert.equal(state.getSnapshot().startupPhase, "ready");
  } finally {
    await lifecycle.shutdown();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test("createLoginSession preserves all valid zpw_ws endpoints and API.applyRefreshedSession updates in-place", () => {
  resetListenerRuntimeState();
  setupAppContext();

  const baseServiceMap = {
    chat: ["https://chat1.zalo.me"],
    group: ["https://group1.zalo.me"],
    file: ["https://file1.zalo.me"],
    profile: ["https://profile1.zalo.me"],
    reaction: ["https://reaction1.zalo.me"],
  };

  const session1 = createLoginSession(
    {
      data: {
        uid: "10001",
        zpw_enk: Buffer.alloc(32, 2).toString("base64"),
        send2me_id: "s2m_1",
        zpw_service_map_v3: baseServiceMap,
        zpw_ws: [
          "wss://ws-a.chat.zalo.me",
          "wss://ws-b.chat.zalo.me",
          "http://invalid-protocol.zalo.me",
        ],
      },
    },
    { settings: {} },
    1700000000000
  );

  assert.equal(session1.wsEndpoints.length, 2);
  assert.match(session1.wsEndpoints[0], /^wss:\/\/ws-a\.chat\.zalo\.me\//);
  assert.match(session1.wsEndpoints[1], /^wss:\/\/ws-b\.chat\.zalo\.me\//);

  appContext.secretKey = session1.secretKey;
  const api = new API(
    session1.secretKey,
    session1.zpwServiceMap,
    session1.wsUrl,
    false,
    session1.wsEndpoints
  );
  const originalListenerRef = api.listener;

  const nextSecret = Buffer.alloc(32, 9).toString("base64");
  const nextServiceMap = {
    ...baseServiceMap,
    chat: ["https://chat2.zalo.me"],
  };
  appContext.secretKey = nextSecret;

  api.applyRefreshedSession({
    secretKey: nextSecret,
    zpwServiceMap: nextServiceMap,
    wsUrl: "wss://ws-c.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1700000099999",
    wsEndpoints: [
      "wss://ws-c.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1700000099999",
      "wss://ws-d.chat.zalo.me/?zpw_ver=665&zpw_type=30&t=1700000099999",
    ],
  });

  assert.equal(api.listener, originalListenerRef, "must preserve bound Listener EventEmitter instance");
  assert.equal(api.secretKey, nextSecret);
  assert.equal(api.zpwServiceMap.chat[0], "https://chat2.zalo.me");
  assert.equal(api.listener.wsEndpoints.length, 2);
  assert.match(api.listener.wsEndpoints[0], /^wss:\/\/ws-c\.chat\.zalo\.me\//);
  assert.match(api.listener.wsEndpoints[1], /^wss:\/\/ws-d\.chat\.zalo\.me\//);
});

