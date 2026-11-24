import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BotRegistry } from "../../src/dashboard/bot-registry.js";
import { ConfigStore } from "../../src/dashboard/config-store.js";
import { createBotActionService } from "../../src/dashboard/bot-action-service.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-actions-lifecycle-"));
  for (const dir of ["mybot/bots", "mybot/state", "mybot/credentials", "mybot/overrides", "mybot/config", "mybot/data", "logs"]) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  await fs.writeFile(path.join(root, "mybot/mybots.json"), JSON.stringify({
    child: { name: "child", displayName: "Child Bot", status: "running", webPort: 3333 },
  }));
  await fs.writeFile(path.join(root, "mybot/bots/child.json"), JSON.stringify({ name: "child", webPort: 3333 }));
  await fs.writeFile(path.join(root, "mybot/state/child.json"), JSON.stringify({ status: "running", pid: "99999" }));
  await fs.writeFile(path.join(root, "mybot/credentials/child.json"), "{\"cookie\":{\"token\":\"secret\"}}\n");
  return root;
}

function serviceFor(root, overrides = {}) {
  const calls = [];
  const registry = new BotRegistry({ root, portProbe: async () => false });
  const configStore = new ConfigStore({ backupDir: path.join(root, "logs/backups") });
  const pm2Adapter = {
    status: async () => ({ running: true, status: "online" }),
    start: async (id) => { calls.push(["start", id]); return true; },
    stop: async (id) => { calls.push(["stop", id]); return true; },
    restart: async (id) => { calls.push(["restart", id]); return true; },
    delete: async (id) => { calls.push(["delete", id]); return true; },
    ...overrides.pm2Adapter,
  };
  const processAdapter = {
    status: async () => ({ running: false, status: "stopped" }),
    kill: async (id) => { calls.push(["kill", id]); return true; },
    ...overrides.processAdapter,
  };
  return {
    calls,
    registry,
    service: createBotActionService({
      root,
      registry,
      configStore,
      pm2Adapter,
      processAdapter,
      restartLauncher: overrides.restartLauncher,
      auditStore: overrides.auditStore,
    }),
  };
}

test("start with structured { success:false } must throw ACTION_FAILED, never report running", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: { start: async () => ({ success: false, reason: "pm2_start_failed", detail: "start exploded" }) },
  });
  await assert.rejects(() => service.start("child"), { code: "ACTION_FAILED" });
});

test("start with legacy boolean false must throw ACTION_FAILED", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: { start: async () => false },
  });
  await assert.rejects(() => service.start("child"), { code: "ACTION_FAILED" });
});

test("successful PM2 start reports starting (not running) before readiness", async () => {
  const root = await fixture();
  const { service } = serviceFor(root);
  const result = await service.start("child");
  assert.equal(result.status, "starting");
  assert.equal(result.action, "start");
});

test("start failure with daemon_unavailable maps to 503 PM2_UNAVAILABLE", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: { start: async () => { const err = new Error("daemon down"); err.status = 503; err.code = "PM2_UNAVAILABLE"; throw err; } },
  });
  await assert.rejects(() => service.start("child"), { code: "PM2_UNAVAILABLE", status: 503 });
});

test("start failure with timeout maps to 504 PM2_TIMEOUT", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: { start: async () => ({ success: false, reason: "timeout", code: "timeout" }) },
  });
  await assert.rejects(() => service.start("child"), { code: "PM2_TIMEOUT", status: 504 });
});

test("restart with structured { success:false } from PM2 restart must throw", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: true, status: "online" }),
      restart: async () => ({ success: false, reason: "pm2_restart_failed", detail: "boom" }),
    },
  });
  await assert.rejects(() => service.restart("child"), { code: "ACTION_FAILED" });
});

test("stop with structured { success:false } must throw STOP_FAILED", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: true, status: "online" }),
      stop: async () => ({ success: false, reason: "pm2_stop_failed", detail: "nope" }),
    },
  });
  await assert.rejects(() => service.stop("child"), { code: "STOP_FAILED" });
});

test("stop verifies the process is no longer online before reporting stopped", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: true, status: "online" }),
      stop: async () => true, // stop "succeeds" but status still reports online
    },
  });
  await assert.rejects(() => service.stop("child"), { code: "STOP_FAILED" });
});

test("stop reports PM2_UNAVAILABLE when the post-stop verification cannot run", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => { throw new Error("daemon down"); },
      stop: async () => true,
    },
  });
  await assert.rejects(() => service.stop("child"), { code: "PM2_UNAVAILABLE" });
});

test("stop succeeds when the process is verified offline after stop", async () => {
  const root = await fixture();
  let online = true;
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: online, status: online ? "online" : "stopped" }),
      stop: async () => { online = false; return true; },
    },
  });
  const result = await service.stop("child");
  assert.equal(result.botId, "child");
  assert.equal(result.action, "stop");
  assert.equal(result.status, "stopped");
  assert.ok(result.operationId);
  assert.equal(result.phase, "stopped");
});

test("restart returns restarting and keeps the anti-duplication lock", async () => {
  const root = await fixture();
  let release;
  const restartStarted = new Promise((resolve) => { release = resolve; });
  const { service } = serviceFor(root, {
    pm2Adapter: {
      status: async () => ({ running: true, status: "online" }),
      restart: async () => {
        setTimeout(() => release(), 10);
        await restartStarted;
        return true;
      },
    },
  });
  const first = service.restart("child");
  const second = service.restart("child");
  assert.equal(first, second);
  await first;
  await second;
  const third = service.restart("child");
  assert.notEqual(third, first, "after completion a new restart must create a fresh operation");
  await third;
});

test("safe reason filtering strips paths and credentials from PM2 failure details", async () => {
  const root = await fixture();
  const { service } = serviceFor(root, {
    pm2Adapter: { start: async () => ({ success: false, reason: "pm2_start_failed", detail: "error at C:\\Users\\Admin\\secret.txt password=hunter2" }) },
  });
  try {
    await service.start("child");
    assert.fail("expected rejection");
  } catch (error) {
    const text = JSON.stringify(error.details ?? error);
    assert.ok(!text.includes("C:\\"), `raw path leaked: ${text}`);
    assert.ok(!text.includes("hunter2"), `raw secret leaked: ${text}`);
  }
});
