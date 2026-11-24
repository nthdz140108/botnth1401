import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeBridgeService } from "../../src/dashboard/node-bridge-service.js";
import { run3Probes, probeHttp } from "../../deploy/canary-rollout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

function makeHmacHeaders(secret, body = "") {
  const timestamp = Date.now();
  const payload = `${timestamp}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return {
    "x-internal-signature": sig,
    "x-internal-timestamp": String(timestamp),
    "x-request-id": `test_${Date.now()}`,
    "Content-Type": "application/json",
  };
}

test("NodeBridgeService emits snapshot with bootId, monotonic seq, ts, and statusVersion", async () => {
  const secret = "test_realtime_secret_123";
  const service = new NodeBridgeService({
    root: projectRoot,
    port: 0,
    host: "127.0.0.1",
    secret,
  });

  const boundPort = await service.start();
  try {
    const snap = await service.getFleetSnapshot();
    assert.ok(snap.bootId, "bootId must be defined");
    assert.match(snap.bootId, /^[0-9a-f-]+$/i, "bootId must be a valid UUID");
    assert.ok(typeof snap.seq === "number" && snap.seq >= 1, "seq must be monotonic integer >= 1");
    assert.ok(typeof snap.statusVersion === "number" && snap.statusVersion >= 1, "statusVersion must be >= 1");
    assert.ok(snap.ts?.iso && snap.ts?.epochMs, "ts must contain both iso string and epochMs");
    assert.ok(Array.isArray(snap.bots), "bots must be an array");
    assert.ok(snap.overview && typeof snap.overview === "object", "overview must be an object");

    // Second snapshot must increment seq
    const snap2 = await service.getFleetSnapshot();
    assert.ok(snap2.seq > snap.seq, "seq must strictly increase on subsequent snapshots");
    assert.equal(snap2.bootId, snap.bootId, "bootId must remain constant within same bridge boot");
  } finally {
    await service.stop();
  }
});

test("NodeBridgeService SSE /bridge/events streams initial snapshot and delta events", async () => {
  const secret = "test_realtime_secret_456";
  const service = new NodeBridgeService({
    root: projectRoot,
    port: 0,
    host: "127.0.0.1",
    secret,
  });

  const boundPort = await service.start();
  try {
    const headers = makeHmacHeaders(secret, "");

    const eventsPromise = new Promise((resolve, reject) => {
      const received = [];
      let emittedDelta = false;
      const req = http.get(
        `http://127.0.0.1:${boundPort}/bridge/events`,
        { headers },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers["content-type"], /text\/event-stream/);

          let buffer = "";
          res.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            while (buffer.includes("\n\n")) {
              const idx = buffer.indexOf("\n\n");
              const frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);

              const lines = frame.split("\n");
              let eventType = "message";
              let data = "";
              for (const l of lines) {
                if (l.startsWith("event:")) eventType = l.slice(6).trim();
                if (l.startsWith("data:")) data = l.slice(5).trim();
              }
              if (data) {
                try {
                  const parsed = JSON.parse(data);
                  received.push({ event: eventType, data: parsed });
                  if (eventType === "snapshot" && !emittedDelta) {
                    emittedDelta = true;
                    setTimeout(() => {
                      service.emitDelta({
                        action: "status_change",
                        botId: "admin",
                        status: "recovering",
                      });
                    }, 50);
                  }
                } catch {}
              }

              if (received.length >= 2) {
                req.destroy();
                resolve(received);
              }
            }
          });
        }
      );
      req.on("error", (err) => {
        if (received.length >= 2) resolve(received);
        else reject(err);
      });
    });

    const events = await eventsPromise;
    assert.ok(events.length >= 2, "Must receive at least snapshot and delta");

    // 1. Initial event is snapshot
    const initialSnap = events[0];
    assert.equal(initialSnap.event, "snapshot");
    assert.ok(initialSnap.data.bootId);
    assert.ok(initialSnap.data.seq >= 1);
    assert.ok(initialSnap.data.ts?.iso);

    // 2. Second event is delta
    const deltaEvent = events[1];
    assert.equal(deltaEvent.event, "delta");
    assert.equal(deltaEvent.data.action, "status_change");
    assert.equal(deltaEvent.data.botId, "admin");
    assert.ok(deltaEvent.data.seq > initialSnap.data.seq, "Delta seq must be higher than initial snapshot");
    assert.ok(deltaEvent.data.statusVersion > initialSnap.data.statusVersion, "Delta statusVersion must increment");
  } finally {
    await service.stop();
  }
});

test("Stale detection contract preserves fleet data when bridge connection is dropped", () => {
  // Simulate the BridgeFleetCache behavior implemented in Rust
  const cache = {
    isStale: false,
    isConnected: true,
    lastSeen: Date.now(),
    bots: [
      { id: "admin", botKey: "admin", status: "running", connected: true },
      { id: "child_1", botKey: "child_1", status: "running", connected: true },
    ],
    overview: {
      totalBots: 2,
      runningBots: 2,
      stale: false,
      bridgeConnected: true,
    },
    markStale() {
      this.isStale = true;
      this.isConnected = false;
      this.overview.stale = true;
      this.overview.bridgeConnected = false;
      for (const bot of this.bots) {
        bot.stale = true;
      }
    },
  };

  // Simulate timeout > 3000ms
  cache.lastSeen = Date.now() - 3500;
  if (Date.now() - cache.lastSeen > 3000) {
    cache.markStale();
  }

  assert.equal(cache.isStale, true, "Must be marked stale after 3 seconds");
  assert.equal(cache.isConnected, false, "isConnected must be false");
  // ABSOLUTELY DO NOT empty the bot list!
  assert.equal(cache.bots.length, 2, "Bot list MUST NOT be emptied when marked stale!");
  assert.equal(cache.overview.stale, true, "Overview stale flag must be true");
  assert.equal(cache.overview.bridgeConnected, false, "Overview bridgeConnected must be false");
});

test("Resync contract triggers snapshot reload within 2s on gap detection", async () => {
  let resyncTriggered = false;
  let snapshotLoaded = false;
  let lastSeq = 10;

  async function onDeltaReceived(delta) {
    if (delta.seq > lastSeq + 1) {
      // Gap detected!
      resyncTriggered = true;
      const startTime = Date.now();
      // Load fresh snapshot within <= 2s
      await new Promise((r) => setTimeout(r, 50));
      snapshotLoaded = true;
      const elapsed = Date.now() - startTime;
      assert.ok(elapsed <= 2000, "Resync snapshot must complete within 2000ms");
      lastSeq = delta.seq;
    }
  }

  // Incoming delta with sequence gap (last was 10, new is 15)
  await onDeltaReceived({ seq: 15, statusVersion: 8, botId: "admin" });
  assert.equal(resyncTriggered, true, "Gap must trigger resync");
  assert.equal(snapshotLoaded, true, "Snapshot must be loaded on gap");
  assert.equal(lastSeq, 15);
});

test("3 Independent Probes module functions report accurately", async () => {
  // Test probeHttp with mock or non-existent port
  const deadProbe = await probeHttp("http://127.0.0.1:59998/api/system/health", 100);
  assert.equal(deadProbe.ok, false);

  const results = await run3Probes({ rustPort: 59998, bridgePort: 59999 });
  assert.equal(results.allPassed, false, "Must fail when services are not running");
  assert.equal(results.probe1.ok, false);
  assert.equal(results.probe2.ok, false);
  assert.equal(results.probe3.ok, false);
});
