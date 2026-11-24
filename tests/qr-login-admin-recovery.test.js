import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "node:child_process";
import QRCode from "qrcode";

import {
  findBrowserExecutable,
  createQrHtml,
  printTerminalQr,
} from "../qr-login-admin.js";
import { openPathInDefaultApp } from "../src/platform/index.js";
import { generateQRCode } from "../src/commands/mybot/Credentials/qr-login.js";
import {
  createAdminStartupCoordinator,
  isRecoveryLockActive,
} from "../src/utils/admin-startup-recovery.js";
import {
  isInteractiveRecoveryLaunch,
  presentAdminRecoveryQr,
} from "../src/runtime/admin-recovery-presentation.js";
import { createAdminRecoveryChannel } from "../src/runtime/admin-recovery-channel.js";

test("importing the admin QR CLI does not bootstrap another bot listener", () => {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "process.env.NODE_TEST_CONTEXT='1'; await import('./qr-login-admin.js'); console.log('QR_IMPORT_OK'); process.exit(0)",
  ], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, NODE_TEST_CONTEXT: "1" },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /QR_IMPORT_OK/);
  assert.doesNotMatch(result.stdout + result.stderr, /BOT LISTENER/);
});

test("recovery lock ignores the current listener PID but blocks a live QR child PID", () => {
  const livePids = new Set([1234, 5678]);
  const isProcessAlive = (pid) => livePids.has(pid);

  assert.equal(isRecoveryLockActive({ pid: 1234 }, { currentPid: 1234, isProcessAlive }), false);
  assert.equal(isRecoveryLockActive({ pid: 5678 }, { currentPid: 1234, isProcessAlive }), true);
  assert.equal(isRecoveryLockActive({ pid: 9999 }, { currentPid: 1234, isProcessAlive }), false);
});

function createCoordinatorHarness(overrides = {}) {
  const calls = [];
  const logs = [];
  const harness = {
    credentials: { cookie: "cookie", imei: "imei" },
    login: async () => {
      calls.push("login");
      return { status: "ONLINE" };
    },
    recoverWithQr: async () => {
      calls.push("recoverWithQr");
      return { success: true };
    },
    reloadCredentials: async () => {
      calls.push("reloadCredentials");
      return { cookie: "new-cookie", imei: "new-imei" };
    },
    sleep: async (delay) => calls.push(`sleep:${delay}`),
    logger: (message) => logs.push(message),
    ...overrides,
  };
  return { coordinator: createAdminStartupCoordinator(harness), calls, logs };
}

test("admin coordinator sends missing cookie directly to QR without login or sleep", async () => {
  const { coordinator, calls, logs } = createCoordinatorHarness({
    credentials: { imei: "imei" },
    recoverWithQr: async () => {
      calls.push("recoverWithQr");
      return { cancelled: true };
    },
  });

  const result = await coordinator.start();

  assert.equal(result.status, "STOPPED");
  assert.deepEqual(calls, ["recoverWithQr"]);
  assert.ok(logs.some((message) => message.includes("Admin credentials invalid - starting QR recovery")));
  assert.equal(logs.some((message) => message.includes("Startup retry scheduled")), false);
});

test("admin coordinator treats Missing required params as immediate QR recovery", async () => {
  const { coordinator, calls } = createCoordinatorHarness({
    login: async () => {
      calls.push("login");
      throw new Error("Missing required params");
    },
    sleep: async () => calls.push("sleep"),
  });

  const result = await coordinator.start();

  assert.equal(result.status, "STOPPED");
  assert.deepEqual(calls, ["login", "recoverWithQr", "reloadCredentials", "login"]);
});

test("admin coordinator retries only identified transport failures", async () => {
  const { coordinator, calls } = createCoordinatorHarness({
    login: async () => {
      calls.push("login");
      if (calls.filter((call) => call === "login").length === 1) {
        const error = new Error("network timeout");
        error.code = "ETIMEDOUT";
        throw error;
      }
      return { status: "ONLINE" };
    },
    sleep: async (delay) => calls.push(`sleep:${delay}`),
  });

  const result = await coordinator.start();

  assert.equal(result.status, "ONLINE");
  assert.deepEqual(calls, ["login", "sleep:5000", "login"]);
});

test("admin coordinator reloads credentials and logs in once after successful QR", async () => {
  const { coordinator, calls } = createCoordinatorHarness({ credentials: { cookie: "" } });

  const result = await coordinator.start();

  assert.equal(result.status, "ONLINE");
  assert.deepEqual(calls, ["recoverWithQr", "reloadCredentials", "login"]);
});

test("admin coordinator stops after QR failure without retrying or spawning another QR", async () => {
  const { coordinator, calls } = createCoordinatorHarness({
    credentials: { cookie: "" },
    recoverWithQr: async () => {
      calls.push("recoverWithQr");
      return { cancelled: true };
    },
    sleep: async () => calls.push("sleep"),
  });

  const result = await coordinator.start();

  assert.equal(result.status, "STOPPED");
  assert.equal(result.reason, "cancelled");
  assert.deepEqual(calls, ["recoverWithQr"]);
});

test("admin coordinator shares one active recovery for concurrent startup requests", async () => {
  let resolveRecovery;
  let recoveryCalls = 0;
  const recoveryGate = new Promise((resolve) => { resolveRecovery = resolve; });
  const { coordinator, calls } = createCoordinatorHarness({
    credentials: { cookie: "" },
    recoverWithQr: async () => {
      recoveryCalls += 1;
      await recoveryGate;
      return { cancelled: true };
    },
  });

  const first = coordinator.start();
  const second = coordinator.start();
  await Promise.resolve();
  resolveRecovery();
  const results = await Promise.all([first, second]);

  assert.equal(recoveryCalls, 1);
  assert.equal(results[0], results[1]);
  assert.deepEqual(calls, []);
});

test("findBrowserExecutable returns a string path or null without throwing", () => {
  const executable = findBrowserExecutable();
  assert.ok(executable === null || typeof executable === "string");
  if (executable) {
    assert.equal(fsSync.existsSync(executable), true, `Detected browser at ${executable} must exist on disk`);
  }
});

test("createQrHtml generates an HTML file with embedded/referenced QR image and styling", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-html-test-"));
  const dummyImgPath = path.join(tempDir, "qr_code.png");
  const dummySampleUrl = "https://id.zalo.me/account/authen/qr?code=unit-test-123";
  const dummyBuffer = await QRCode.toBuffer(dummySampleUrl);
  await fs.writeFile(dummyImgPath, dummyBuffer);

  const { htmlPath, htmlUrl } = await createQrHtml(dummyImgPath, dummyBuffer.toString("base64"));
  assert.equal(fsSync.existsSync(htmlPath), true);
  assert.ok(htmlUrl.startsWith("file:"));

  const content = await fs.readFile(htmlPath, "utf8");
  assert.ok(content.includes("Zalo Admin QR Login"));
  assert.ok(content.includes("data:image/png;base64,"));
  assert.ok(content.includes("Quét QR"));

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("printTerminalQr decodes image buffer and outputs terminal QR without throwing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-terminal-test-"));
  const dummyImgPath = path.join(tempDir, "qr_code.png");
  const dummySampleUrl = "https://id.zalo.me/account/authen/qr?code=terminal-test-456";
  const dummyBuffer = await QRCode.toBuffer(dummySampleUrl);
  await fs.writeFile(dummyImgPath, dummyBuffer);

  const logged = await printTerminalQr(dummyImgPath, dummyBuffer.toString("base64"));
  assert.equal(logged, true, "printTerminalQr must return true when valid QR is decoded");

  // Invalid data should gracefully return false without throwing
  const failed = await printTerminalQr(null, "invalid-base64");
  assert.equal(failed, false);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("openPathInDefaultApp normalizes target path to absolute before invoking spawn", () => {
  let invokedCommand = null;
  let invokedArgs = null;

  const mockSpawn = (cmd, args) => {
    invokedCommand = cmd;
    invokedArgs = args;
    return { unref: () => {} };
  };

  const relativePath = ".cache/qr_code_test.png";
  const success = openPathInDefaultApp(relativePath, {
    platform: "win32",
    spawnImpl: mockSpawn,
  });

  assert.equal(success, true);
  assert.equal(invokedCommand, "cmd");
  assert.deepEqual(invokedArgs, ["/c", "start", "", path.resolve(relativePath)]);
});

test("generateQRCode safely isolates onQrReady errors without failing session", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-gen-test-"));
  const qrFilePath = path.join(tempDir, "test-qr.png");
  const sampleUrl = "https://id.zalo.me/account/authen/qr?code=gen-test-789";
  const qrBuffer = await QRCode.toBuffer(sampleUrl);
  const base64Data = `data:image/png;base64,${qrBuffer.toString("base64")}`;

  const mockSession = {
    headers: {},
    fetchWithCookies: async () => ({
      ok: true,
      json: async () => ({
        data: {
          image: base64Data,
          code: "gen-test-789",
        },
      }),
    }),
    onQrReady: async () => {
      throw new Error("Simulated browser launch failure (e.g. Could not find Chrome)");
    },
  };

  const [code, updatedSession] = await generateQRCode(mockSession, {
    qrFilePath,
    persistQrFile: true,
  });

  assert.equal(code, "gen-test-789");
  assert.ok(updatedSession);
  assert.equal(fsSync.existsSync(qrFilePath), true);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("classifyAuthError correctly recognizes Missing required params and all auth/cookie failures", async () => {
  const { classifyAuthError } = await import("../src/index.js");

  assert.equal(classifyAuthError(new Error("Missing required params")).isAuthError, true);
  assert.equal(classifyAuthError(new Error("Invalid cookie format")).isAuthError, true);
  assert.equal(classifyAuthError(new Error("Login data is null. Cookie đã hết hạn hoặc không hợp lệ.")).isAuthError, true);
  assert.equal(classifyAuthError(new Error("Login response missing zpw_ws. Cookie may have expired.")).isAuthError, true);
  assert.equal(classifyAuthError(new Error("Failed to fetch login info: unauthorized")).isAuthError, true);
  assert.equal(classifyAuthError({ status: 401 }).isAuthError, true);
  assert.equal(classifyAuthError(new Error("Unrelated network timeout")).isAuthError, false);
});

test("hasRequiredCredentials validates existence and non-emptiness of cookie and imei", async () => {
  const { hasRequiredCredentials } = await import("../src/index.js");

  assert.equal(hasRequiredCredentials(null), false);
  assert.equal(hasRequiredCredentials({}), false);
  assert.equal(hasRequiredCredentials({ cookie: "c" }), false);
  assert.equal(hasRequiredCredentials({ imei: "i" }), false);
  assert.equal(hasRequiredCredentials({ cookie: "", imei: "i" }), false);
  assert.equal(hasRequiredCredentials({ cookie: "   ", imei: "i" }), false);
  assert.equal(hasRequiredCredentials({ cookie: "c", imei: "   " }), false);
  assert.equal(hasRequiredCredentials({ cookie: "valid-cookie", imei: "valid-imei" }), true);
});

test("decideStartupFailureAction routes admin missing params and auth failures to admin-recovery", async () => {
  const { decideStartupFailureAction } = await import("../src/index.js");

  const res1 = decideStartupFailureAction({
    error: new Error("Missing required params"),
    botName: "admin",
    retryCount: 0,
    hasRecoveredWithQr: false,
  });
  assert.equal(res1.action, "admin-recovery");
  assert.equal(res1.isAuthError, true);

  const res2 = decideStartupFailureAction({
    error: null,
    botName: "admin",
    credentials: { imei: "123" },
    retryCount: 0,
    hasRecoveredWithQr: false,
  });
  assert.equal(res2.action, "admin-recovery");
  assert.equal(res2.reason, "missing-credentials");

  const res3 = decideStartupFailureAction({
    error: null,
    botName: "admin",
    credentials: { cookie: "abc" },
    retryCount: 0,
    hasRecoveredWithQr: false,
  });
  assert.equal(res3.action, "admin-recovery");
  assert.equal(res3.reason, "missing-credentials");
});

test("decideStartupFailureAction stops sub-bot immediately on auth/missing params without triggering admin QR", async () => {
  const { decideStartupFailureAction } = await import("../src/index.js");

  const resSub1 = decideStartupFailureAction({
    error: new Error("Missing required params"),
    botName: "bot123",
    retryCount: 0,
  });
  assert.equal(resSub1.action, "stop");
  assert.equal(resSub1.isAuthError, true);
  assert.ok(resSub1.error.includes("bot123"));

  const resSub2 = decideStartupFailureAction({
    error: null,
    botName: "child-bot",
    credentials: { cookie: "" },
  });
  assert.equal(resSub2.action, "stop");
  assert.equal(resSub2.isAuthError, true);
});

test("decideStartupFailureAction prevents infinite QR recovery loop when credentials fail after recovery", async () => {
  const { decideStartupFailureAction } = await import("../src/index.js");

  const resExhausted = decideStartupFailureAction({
    error: new Error("Missing required params"),
    botName: "admin",
    hasRecoveredWithQr: true,
  });
  assert.equal(resExhausted.action, "stop");
  assert.equal(resExhausted.reason, "qr-recovery-exhausted");
  assert.equal(resExhausted.isAuthError, true);
});

test("decideStartupFailureAction keeps retrying transient network errors up to maxRetries", async () => {
  const { decideStartupFailureAction } = await import("../src/index.js");

  const netError = new Error("FetchError: request to https://zalo.me failed, reason: connect ETIMEDOUT");

  const retry1 = decideStartupFailureAction({
    error: netError,
    botName: "admin",
    retryCount: 0,
    maxRetries: 5,
  });
  assert.equal(retry1.action, "retry");
  assert.equal(retry1.retryCount, 1);
  assert.equal(retry1.delay, 5000);

  const retry4 = decideStartupFailureAction({
    error: netError,
    botName: "admin",
    retryCount: 3,
    maxRetries: 5,
  });
  assert.equal(retry4.action, "retry");
  assert.equal(retry4.retryCount, 4);
  assert.equal(retry4.delay, 20000);

  const maxReached = decideStartupFailureAction({
    error: netError,
    botName: "admin",
    retryCount: 4,
    maxRetries: 5,
  });
  assert.equal(maxReached.action, "stop");
  assert.equal(maxReached.reason, "max-retries-exceeded");
});

test("printRuntimeFingerprint outputs string containing root, entry, bot, pid, version, and commit", async () => {
  const { printRuntimeFingerprint, getGitCommitHash } = await import("../src/bootstrap.js");

  const fingerprint = printRuntimeFingerprint({
    entrypoint: "test-entry.js",
    botName: "admin",
    commit: "abc1234",
  });

  assert.ok(fingerprint.includes("[RUNTIME FINGERPRINT]"));
  assert.ok(fingerprint.includes("root="));
  assert.ok(fingerprint.includes('entry="test-entry.js"'));
  assert.ok(fingerprint.includes('bot="admin"'));
  assert.ok(fingerprint.includes(`pid=${process.pid}`));
  assert.ok(fingerprint.includes("version="));
  assert.ok(fingerprint.includes('commit="abc1234"'));

  const autoCommit = getGitCommitHash();
  assert.ok(typeof autoCommit === "string" && autoCommit.length > 0);
});

// ---------------------------------------------------------------------------
// Task 2: Publish recovery QR and avoid GUI assumptions under PM2
// ---------------------------------------------------------------------------

function makeTtyStdout() {
  return { isTTY: true };
}

function makePipeStdout() {
  return { isTTY: false };
}

test("isInteractiveRecoveryLaunch is true for interactive direct runs and false under PM2", () => {
  // Managed run is never interactive regardless of TTY/platform.
  assert.equal(
    isInteractiveRecoveryLaunch({ env: { BOT_MANAGED: "true" }, stdout: makeTtyStdout(), platform: "win32" }),
    false
  );
  assert.equal(
    isInteractiveRecoveryLaunch({ env: { BOT_MANAGED: "TRUE" }, stdout: makeTtyStdout(), platform: "win32" }),
    false
  );
  // Interactive TTY without managed marker is interactive on any platform.
  assert.equal(
    isInteractiveRecoveryLaunch({ env: {}, stdout: makeTtyStdout(), platform: "win32" }),
    true
  );
  assert.equal(
    isInteractiveRecoveryLaunch({ env: {}, stdout: makeTtyStdout(), platform: "linux" }),
    true
  );
  // Non-TTY stdout (piped/daemon output) is not interactive even when unmanaged.
  assert.equal(
    isInteractiveRecoveryLaunch({ env: {}, stdout: makePipeStdout(), platform: "win32" }),
    false
  );
  assert.equal(
    isInteractiveRecoveryLaunch({ env: {}, stdout: null, platform: "win32" }),
    false
  );
});

test("presentAdminRecoveryQr under PM2 publishes to channel and never attempts GUI", async () => {
  const calls = [];
  const result = await presentAdminRecoveryQr({
    filePath: "unused.png",
    base64Image: "aGVsbG8=",
    managed: true,
    channel: { publishQr: async () => ({ sessionId: "session-a" }) },
    openWindow: async () => { calls.push("open"); },
  });
  assert.equal(result.sessionId, "session-a");
  assert.equal(result.presentation, "channel");
  assert.deepEqual(calls, []);
});

test("presentAdminRecoveryQr publishes before opening window in direct interactive runs", async () => {
  const calls = [];
  const channel = {
    publishQr: async () => {
      calls.push("publish");
      return { sessionId: "session-b" };
    },
  };
  const result = await presentAdminRecoveryQr({
    filePath: "qr.png",
    base64Image: "aGVsbG8=",
    managed: false,
    channel,
    openWindow: async () => { calls.push("open"); },
  });
  assert.equal(result.sessionId, "session-b");
  assert.equal(result.presentation, "channel");
  assert.deepEqual(calls, ["publish", "open"]);
  assert.equal(result.window, undefined, "window handle must not be required when no handle is returned");
});

test("presentAdminRecoveryQr keeps channel active when popup window fails", async () => {
  const calls = [];
  const result = await presentAdminRecoveryQr({
    filePath: "qr.png",
    base64Image: "aGVsbG8=",
    managed: false,
    channel: {
      publishQr: async () => {
        calls.push("publish");
        return { sessionId: "session-c" };
      },
    },
    openWindow: async () => {
      calls.push("open-attempt");
      throw new Error("Could not find Chrome");
    },
  });
  assert.equal(result.sessionId, "session-c");
  assert.equal(result.presentation, "channel");
  assert.deepEqual(calls, ["publish", "open-attempt"]);
});

test("presentAdminRecoveryQr returns presentation 'none' when no channel is available", async () => {
  const result = await presentAdminRecoveryQr({
    filePath: "qr.png",
    base64Image: "aGVsbG8=",
    managed: true,
    channel: null,
    openWindow: async () => {},
  });
  assert.equal(result.presentation, "none");
});

test("presentAdminRecoveryQr publishes image buffer copied from file when no base64 is supplied", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "qr-present-"));
  const qrPath = path.join(tempDir, "qr.png");
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await fs.writeFile(qrPath, pngBytes);

  let received = null;
  const channel = {
    publishQr: async ({ imageBuffer }) => {
      received = imageBuffer;
      return { sessionId: "session-d" };
    },
  };
  const result = await presentAdminRecoveryQr({
    filePath: qrPath,
    base64Image: "",
    managed: false,
    channel,
    openWindow: async () => {},
  });
  assert.ok(Buffer.isBuffer(received));
  assert.equal(received.equals(pngBytes), true);
  assert.equal(result.sessionId, "session-d");
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("admin recovery channel round-trip: publish, readActive, readQr, cleanup in temp projectRoot", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qr-channel-root-"));
  const channel = createAdminRecoveryChannel({ projectRoot: tempRoot });
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const expiresAt = new Date(Date.now() + 90_000).toISOString();

  const published = await channel.publishQr({ imageBuffer: pngBytes, expiresAt, ownerPid: process.pid });
  assert.ok(published.sessionId);
  assert.equal(published.state, "waiting_scan");
  assert.equal(published.qrFile, `sessions/${published.sessionId}/qr.png`);

  const active = await channel.readActive();
  assert.equal(active.sessionId, published.sessionId);

  const qr = await channel.readQr(published.sessionId);
  assert.equal(qr.equals(pngBytes), true);

  const cleaned = await channel.cleanup(published.sessionId, "success");
  assert.equal(cleaned.state, "success");
  assert.equal(await channel.readActive(), null);
  assert.equal(await channel.readQr(published.sessionId), null);
  assert.equal(await channel.cleanup(published.sessionId, "success"), null, "cleanup must be idempotent");

  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("interactive admin recovery watcher pops up QR once per sessionId and auto-closes on completion", async () => {
  const { startInteractiveAdminRecoveryWatcher } = await import("../src/runtime/admin-recovery-watcher.js");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qr-watcher-root-"));
  const channel = createAdminRecoveryChannel({ projectRoot: tempRoot });
  const pngBytes = await QRCode.toBuffer("https://id.zalo.me/account/authen/qr?code=watcher-test");

  const shownSessions = [];
  let closedCount = 0;

  const watcher = startInteractiveAdminRecoveryWatcher({
    projectRoot: tempRoot,
    pollIntervalMs: 60_000,
    channel,
    onShowQr: async ({ sessionId, pngBuffer }) => {
      shownSessions.push({ sessionId, size: pngBuffer.length });
      return {
        close: () => {
          closedCount += 1;
        },
      };
    },
  });

  try {
    await watcher.tick();
    assert.equal(shownSessions.length, 0);

    const published = await channel.publishQr({
      imageBuffer: pngBytes,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerPid: process.pid,
    });

    await watcher.tick();
    assert.equal(shownSessions.length, 1);
    assert.equal(shownSessions[0].sessionId, published.sessionId);
    assert.equal(closedCount, 0);

    // Second tick on same sessionId must NOT pop up a duplicate window
    await watcher.tick();
    assert.equal(shownSessions.length, 1);

    // Completing the session must auto-close the popup window
    await channel.cleanup(published.sessionId, "success");
    await watcher.tick();
    assert.equal(closedCount, 1);
  } finally {
    watcher.stop();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
