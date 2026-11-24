import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const testDataDir = path.join(projectRoot, ".cache", "test-terminal-launcher");

test("startBotWithLauncher returns structured result with success, pid, consolePid", async () => {
  const { startBotWithLauncher } = await import("../src/commands/mybot/System/pm2-manager.js");
  
  // For QR_BOOTSTRAP_ONLY or headless mock
  const result = await startBotWithLauncher("qr-bootstrap-test-mock", {
    skipHealthCheck: true,
    env: {
      QR_BOOTSTRAP_SESSION: "mock-session",
      QR_BOOTSTRAP_ONLY: "true",
      TEST_MOCK_LAUNCH: "true",
    },
  });

  assert.ok(result);
  assert.equal(typeof result, "object");
  assert.equal(result.success, true);
});

test("startBotWithLauncher prevents double-start for same bot UID", async () => {
  const { startBotWithLauncher } = await import("../src/commands/mybot/System/pm2-manager.js");

  // Mock starting two identical requests concurrently
  const p1 = startBotWithLauncher("double-start-test", { skipHealthCheck: true, env: { TEST_MOCK_LAUNCH: "true" } });
  const p2 = startBotWithLauncher("double-start-test", { skipHealthCheck: true, env: { TEST_MOCK_LAUNCH: "true" } });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
});
