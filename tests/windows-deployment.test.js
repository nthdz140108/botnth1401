import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WindowsSupervisor } from "../scripts/windows-supervisor.js";
import { seedCleanInstall } from "../scripts/clean-install.js";

test("windows deployment scripts exist and are well-formed for Windows Server 2012 R2", async () => {
  const installBat = await fs.readFile(path.join(process.cwd(), "install.bat"), "utf8");
  const runBat = await fs.readFile(path.join(process.cwd(), "run.bat"), "utf8");
  const updateBat = await fs.readFile(path.join(process.cwd(), "update.bat"), "utf8");
  const cleanBat = await fs.readFile(path.join(process.cwd(), "clean-ssd.bat"), "utf8");

  assert.ok(installBat.includes("NODE_SKIP_PLATFORM_CHECK=1"));
  assert.ok(runBat.includes("NODE_SKIP_PLATFORM_CHECK=1"));
  assert.ok(runBat.includes("reconcile-and-monitor.js"));
  assert.ok(updateBat.includes("update-bootstrap.js"));
  assert.ok(updateBat.includes("--skip-restart"));
  assert.ok(cleanBat.includes("deep-clean-ssd.js"));

  // Never set chcp 65001 in cmd.exe on Windows Server 2012 R2 (causes conhost v1 write EIO)
  assert.equal(installBat.includes("chcp 65001"), false);
  assert.equal(runBat.includes("chcp 65001"), false);
  assert.equal(updateBat.includes("chcp 65001"), false);
  assert.equal(cleanBat.includes("chcp 65001"), false);
});

test("windows console guard prevents EIO crashes and transliterates UTF-8 on NT 6.x", async () => {
  const { EventEmitter } = await import("node:events");
  const {
    isLegacyWindowsConsole,
    toAsciiSafeConsoleText,
    installWindowsConsoleSafety,
  } = await import("../src/runtime/windows-console-guard.js");

  assert.equal(isLegacyWindowsConsole({ platform: "win32", release: "6.3.9600", env: {} }), true);
  assert.equal(isLegacyWindowsConsole({ platform: "win32", release: "10.0.19045", env: {} }), false);

  const sanitized = toAsciiSafeConsoleText("[reconcile] admin — Đăng nhập CẦN QUÉT MÃ QR…");
  assert.equal(sanitized, "[reconcile] admin -- Dang nhap CAN QUET MA QR...");

  const chunks = [];
  class MockStream extends EventEmitter {
    constructor() {
      super();
      this._writableState = { autoDestroy: true, emitClose: true };
    }
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    }
  }

  const mockStdout = new MockStream();
  const mockStderr = new MockStream();
  installWindowsConsoleSafety({ stdout: mockStdout, stderr: mockStderr, forceAscii: true });

  mockStderr.write("[reconcile] admin runs OLD code — reloading\n");
  assert.equal(chunks[0], "[reconcile] admin runs OLD code -- reloading\n");

  // Emitting EIO must NOT throw unhandled error event
  const eio = Object.assign(new Error("write EIO"), { code: "EIO", errno: -4070 });
  assert.doesNotThrow(() => {
    mockStderr.emit("error", eio);
  });
});

test("win2012 canvas compat detects ProcessPrng DLL and extracts tar.gz replacements in pure JS", async () => {
  const zlib = await import("node:zlib");
  const {
    extractTarEntriesByBasename,
    needsWin2012CanvasPatch,
    ensureWin2012CanvasCompat,
  } = await import("../src/runtime/win2012-canvas-compat.js");

  function makeTarEntry(filename, contentBuf) {
    const header = Buffer.alloc(512, 0);
    header.write(filename, 0, Math.min(100, Buffer.byteLength(filename)), "utf8");
    header.write("0000644\0", 100, 8, "ascii");
    header.write(`${contentBuf.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header[156] = 48; // '0'
    const padLen = Math.ceil(contentBuf.length / 512) * 512 - contentBuf.length;
    return Buffer.concat([header, contentBuf, Buffer.alloc(padLen, 0)]);
  }

  const fakeRsvg = Buffer.from("MZ_COMPAT_LIBRSVG_uses_libxml2-2.dll_no_win10_sym");
  const fakeXml2 = Buffer.from("MZ_COMPAT_LIBXML2_WIN2012_OK");
  const tarBuf = Buffer.concat([
    makeTarEntry("Release/librsvg-2-2.dll", fakeRsvg),
    makeTarEntry("Release/libxml2-2.dll", fakeXml2),
    Buffer.alloc(1024, 0),
  ]);
  const gzBuf = zlib.gzipSync(tarBuf);

  const extracted = extractTarEntriesByBasename(tarBuf, ["librsvg-2-2.dll", "libxml2-2.dll"]);
  assert.equal(extracted.get("librsvg-2-2.dll")?.equals(fakeRsvg), true);
  assert.equal(extracted.get("libxml2-2.dll")?.equals(fakeXml2), true);

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "win2012-canvas-"));
  const releaseDir = path.join(tmpRoot, "node_modules", "canvas", "build", "Release");
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "librsvg-2-2.dll"), Buffer.from("MZ_WIN10_ProcessPrng_IMPORT"));

  assert.equal(needsWin2012CanvasPatch(releaseDir), true);

  const res = await ensureWin2012CanvasCompat({
    projectRoot: tmpRoot,
    force: true,
    log: () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => gzBuf,
    }),
  });
  assert.equal(res.patched, true);
  assert.equal(needsWin2012CanvasPatch(releaseDir), false);

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test("windows supervisor manages lifecycle and state file", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "supervisor-test-"));
  const supervisor = new WindowsSupervisor({
    botName: "test-bot",
    projectRoot: tmp,
    maxRestarts: 3,
    restartWindowMs: 10000,
  });

  supervisor.acquireLock();
  assert.equal(supervisor.isProcessAlive(process.pid), true);

  supervisor.saveState({ status: "test_running" });
  const stateFile = path.join(tmp, "mybot", "supervisor-state.json");
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(state.botName, "test-bot");
  assert.equal(state.status, "test_running");

  supervisor.releaseLock();
});

test("seedCleanInstall initializes admin workspace properly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-win-install-"));
  await seedCleanInstall({ root, now: () => "2026-08-11T00:00:00.000Z" });

  const roleRegistry = JSON.parse(await fs.readFile(path.join(root, "role-registry.json"), "utf8"));
  const myBots = JSON.parse(await fs.readFile(path.join(root, "mybots.json"), "utf8"));

  assert.equal(roleRegistry.primaryBotId, null);
  assert.equal(myBots.admin.status, "pending");
});
