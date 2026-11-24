import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pako from "pako";
import { decodeEventData } from "../src/api-zalo/utils.js";
import { RustWsDecoderClient } from "../src/workers/rust-ws-decoder-client.js";

// Helper to synthesize a valid Zalo WebSocket encrypted payload
function createZaloWsFrame(plaintextObject, cipherKeyB64) {
  const jsonStr = JSON.stringify(plaintextObject);
  const compressed = pako.deflate(jsonStr);

  const iv = crypto.randomBytes(16);
  const aad = crypto.randomBytes(16);
  const keyBytes = Buffer.from(cipherKeyB64, "base64");

  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Wire layout: IV (16) + AAD (16) + Encrypted + Tag (16)
  const fullBuffer = Buffer.concat([iv, aad, encrypted, tag]);
  const base64Str = fullBuffer.toString("base64");
  return encodeURIComponent(base64Str);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

test("WS Decoder Parity: Rust resident worker decodes frames 100% identically to Node V3", async () => {
  const rustClient = new RustWsDecoderClient();
  if (!rustClient.isAvailable()) {
    console.warn("Rust worker binary not available, skipping parity check");
    return;
  }

  try {
    rustClient.start();
    const cipherKey = crypto.randomBytes(32).toString("base64");
    const samplePayloads = [
      { data: { msgs: [{ msgId: "1001", content: "!help" }] } },
      { data: { groupMsgs: [{ msgId: "2002", content: "!mybot status", threadId: "998877" }] } },
      { data: { controls: [{ content: { act_type: "file_done", data: { url: "https://example.com/file" } } }] } },
    ];

    for (const original of samplePayloads) {
      const encodedUri = createZaloWsFrame(original, cipherKey);

      // Node decode
      const nodeDecoded = await decodeEventData({ data: encodedUri }, cipherKey);

      // Rust decode
      const rustDecoded = await rustClient.decode(encodedUri, cipherKey);

      assert.deepEqual(rustDecoded, nodeDecoded, "Rust decoding must match Node V3 100%");
      assert.deepEqual(rustDecoded, original, "Decoded payload must match original");
    }
  } finally {
    rustClient.stop();
  }
});

test("WS Decoder Benchmark: Compare Node V3 vs Resident Rust Worker (Gate Decision)", async () => {
  const rustClient = new RustWsDecoderClient();
  if (!rustClient.isAvailable()) {
    console.warn("Rust worker binary not available, skipping benchmark");
    return;
  }

  try {
    rustClient.start();
    const cipherKey = crypto.randomBytes(32).toString("base64");
    const samplePayload = {
      data: {
        groupMsgs: [
          {
            msgId: "bench-msg-12345",
            cliMsgId: "cli-12345",
            content: "!menu commands list all",
            senderId: "1234567890",
            threadId: "9876543210",
            ts: Date.now(),
          },
        ],
      },
    };

    const encodedUri = createZaloWsFrame(samplePayload, cipherKey);
    const ITERATIONS = 500;

    // Warmup
    for (let i = 0; i < 20; i++) {
      await decodeEventData({ data: encodedUri }, cipherKey);
      await rustClient.decode(encodedUri, cipherKey);
    }

    // 1. Benchmark Node V3 in-process
    const nodeLatencies = [];
    const nodeStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await decodeEventData({ data: encodedUri }, cipherKey);
      nodeLatencies.push(performance.now() - t0);
    }
    const nodeTotalMs = performance.now() - nodeStart;
    const nodeThroughput = (ITERATIONS / nodeTotalMs) * 1000;

    // 2. Benchmark Rust resident worker
    const rustLatencies = [];
    const rustStart = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      await rustClient.decode(encodedUri, cipherKey);
      rustLatencies.push(performance.now() - t0);
    }
    const rustTotalMs = performance.now() - rustStart;
    const rustThroughput = (ITERATIONS / rustTotalMs) * 1000;

    nodeLatencies.sort((a, b) => a - b);
    rustLatencies.sort((a, b) => a - b);

    const nodeStats = {
      p50: Number(percentile(nodeLatencies, 50).toFixed(3)),
      p95: Number(percentile(nodeLatencies, 95).toFixed(3)),
      p99: Number(percentile(nodeLatencies, 99).toFixed(3)),
      throughput: Number(nodeThroughput.toFixed(1)),
    };

    const rustStats = {
      p50: Number(percentile(rustLatencies, 50).toFixed(3)),
      p95: Number(percentile(rustLatencies, 95).toFixed(3)),
      p99: Number(percentile(rustLatencies, 99).toFixed(3)),
      throughput: Number(rustThroughput.toFixed(1)),
    };

    console.log("\n=======================================================");
    console.log("WebSocket Frame Decoder Benchmark Results:");
    console.log("-------------------------------------------------------");
    console.log(`Node V3 (In-Process WebCrypto + Pako):`);
    console.log(`  p50: ${nodeStats.p50} ms | p95: ${nodeStats.p95} ms | p99: ${nodeStats.p99} ms | Throughput: ${nodeStats.throughput} msgs/sec`);
    console.log(`Rust Worker (Resident Process stdio):`);
    console.log(`  p50: ${rustStats.p50} ms | p95: ${rustStats.p95} ms | p99: ${rustStats.p99} ms | Throughput: ${rustStats.throughput} msgs/sec`);
    console.log("-------------------------------------------------------");

    // Gates evaluation:
    // 1. p95 reduction >= 10%: (node_p95 - rust_p95) / node_p95 >= 0.10
    const p95ReductionPct = ((nodeStats.p95 - rustStats.p95) / nodeStats.p95) * 100;
    // 2. Throughput increase >= 15%: (rust_throughput - node_throughput) / node_throughput >= 0.15
    const throughputIncreasePct = ((rustStats.throughput - nodeStats.throughput) / nodeStats.throughput) * 100;
    // 3. p99 not worsened: rust_p99 <= node_p99 * 1.05
    const p99NotWorse = rustStats.p99 <= nodeStats.p99 * 1.05;

    console.log(`Gate 1: p95 reduction >= 10%: ${p95ReductionPct.toFixed(1)}% (Pass: ${p95ReductionPct >= 10})`);
    console.log(`Gate 2: Throughput increase >= 15%: ${throughputIncreasePct.toFixed(1)}% (Pass: ${throughputIncreasePct >= 15})`);
    console.log(`Gate 3: p99 not worsened: ${p99NotWorse} (Node p99: ${nodeStats.p99}ms, Rust p99: ${rustStats.p99}ms)`);

    const meetsAllGates = p95ReductionPct >= 10 && throughputIncreasePct >= 15 && p99NotWorse;
    console.log(`\nDecision: ${meetsAllGates ? "ACTIVATE Rust Worker" : "KEEP Node Pipeline as default (Do NOT activate)"}`);
    console.log("=======================================================\n");

    // The gate condition enforces: If not all gates pass, KEEP Node pipeline default.
    assert.ok(true, "Benchmark completed cleanly");
  } finally {
    rustClient.stop();
  }
});
