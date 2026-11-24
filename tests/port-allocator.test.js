import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  PORT_SCAN_START,
  PORT_SCAN_END,
  canBindPort,
  usedRegistryPorts,
  allocateBindablePort,
} from "../src/runtime/port-allocator.js";
import { resolveLaunchDescriptor, setRuntimeInstanceDescriptor } from "../src/core/runtime-instance.js";
import { startWebServer, closeWebServer } from "../src/web-service/web-server.js";

/** Bind a port and keep it open for the duration of `fn`. */
async function withHeldPort(fn) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("canBindPort detects an occupied port as not bindable", async () => {
  await withHeldPort(async (port) => {
    assert.equal(await canBindPort(port), false, "held port must not be bindable");
  });
  // After release the port MAY be bindable again (do not assert true: OS may
  // keep it in TIME_WAIT briefly) — but a held port is definitively false.
});

test("usedRegistryPorts collects every finite webPort in the registry", () => {
  const used = usedRegistryPorts({
    a: { webPort: "4444" },
    b: { webPort: 4445 },
    c: { webPort: "not-a-port" },
    d: {},
    e: null,
  });
  assert.deepEqual([...used].sort(), [4444, 4445]);
});

test("allocateBindablePort skips registry-claimed AND really-bound ports", async () => {
  await withHeldPort(async (boundPort) => {
    const registry = { a: { webPort: "4444" }, b: { webPort: "4445" } };
    const port = await allocateBindablePort({
      registry,
      start: 4444,
      canBind: async (candidate) => candidate !== boundPort,
    });
    assert.notEqual(port, 4444);
    assert.notEqual(port, 4445);
    assert.notEqual(port, boundPort, "a port held by a foreign process is never allocated");
  });
});

test("allocateBindablePort never silently falls back to a fixed default", async () => {
  const port = await allocateBindablePort({
    registry: { a: { webPort: "4444" }, b: { webPort: "4445" } },
    start: 4444,
    canBind: async () => true,
  });
  assert.equal(port, 4446, "first port that is not registry-claimed and bindable wins");
});

test("allocateBindablePort treats bound ports as used and keeps scanning", async () => {
  await withHeldPort(async (boundPort) => {
    // Scan starts AT the really-held port; the allocator must skip it and
    // return the next bindable candidate.
    const port = await allocateBindablePort({
      registry: {},
      start: boundPort,
      end: boundPort + 5,
      canBind: async (candidate) => candidate !== boundPort,
    });
    assert.equal(port, boundPort + 1, "scans past the really-bound port");
  });
});

test("allocateBindablePort throws NO_BINDABLE_PORT when nothing is free", async () => {
  await assert.rejects(
    allocateBindablePort({ start: 7000, end: 7002, canBind: async () => false }),
    (error) => error.code === "NO_BINDABLE_PORT" && /7000-7002/.test(error.message),
  );
});

test("scan range covers the documented 4444-6666 window", () => {
  assert.equal(PORT_SCAN_START, 4444);
  assert.equal(PORT_SCAN_END, 6666);
});

test("startWebServer throws a structured BRIDGE_PORT_IN_USE on bind failure", async () => {
  await withHeldPort(async (boundPort) => {
    const descriptor = resolveLaunchDescriptor({
      kind: "child",
      botKey: "bridge_conflict_bot",
      configuredUid: "556677",
      webPort: boundPort,
    });
    setRuntimeInstanceDescriptor(descriptor);

    await assert.rejects(
      startWebServer({}),
      (error) =>
        error.code === "EADDRINUSE"
        && error.port === boundPort
        && error.botKey === "bridge_conflict_bot"
        && typeof error.pid === "number"
        && /failed to bind/.test(error.message),
    );
    // The failed bridge must not leave a listening server behind.
    await closeWebServer().catch(() => {});
  });
});
