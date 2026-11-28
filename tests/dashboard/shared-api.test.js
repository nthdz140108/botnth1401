import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import portfinder from "portfinder";
import { CredentialService } from "../../src/dashboard/credential-service.js";
import { AuditStore } from "../../src/dashboard/audit-store.js";
import { BotRegistry } from "../../src/dashboard/bot-registry.js";
import { registerDashboardApi } from "../../src/dashboard/api-routes.js";

async function makeDashboardFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-shared-api-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "instances", "child", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "command-overrides"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });

  const port = await portfinder.getPortPromise({ port: 36000, stopPort: 45000 });
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    child: { name: "child", displayName: "Child", status: "running", webPort: 3333 },
    pm2bot: { name: "pm2bot", displayName: "PM2 Bot", status: "stopped", webPort: 3334 },
  }));
  await fs.writeFile(path.join(root, "mybot", "bots", "admin.json"), JSON.stringify({
    name: "admin",
    webPort: port,
    webHost: "127.0.0.1",
    configFilePath: "mybot/bots/admin-credential.json",
    commandFilePath: "mybot/json-data/command-admin.json",
    WEB_CONFIG_PATH: "mybot/web-config.json",
  }));
  await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({
    name: "child",
    configFilePath: "mybot/bots/child-credential.json",
    commandFilePath: "mybot/json-data/command-child.json",
    WEB_CONFIG_PATH: "mybot/web-config-child.json",
  }));
  await fs.writeFile(path.join(root, "mybot", "bots", "pm2bot.json"), JSON.stringify({
    name: "pm2bot",
    configFilePath: "mybot/bots/pm2bot-credential.json",
    commandFilePath: "mybot/json-data/command-pm2bot.json",
  }));
  await fs.writeFile(path.join(root, "mybot", "state", "stateonly.json"), JSON.stringify({
    pid: process.pid,
    webPort: 3202,
    status: "running",
  }));
  await fs.writeFile(path.join(root, "mybot", "state", "child.json"), JSON.stringify({
    pid: process.pid,
    webPort: 3333,
    status: "running",
  }));
  await fs.writeFile(path.join(root, "mybot", "bots", "admin-credential.json"), JSON.stringify({ cookie: { token: "secret" }, imei: "imei-admin", userAgent: "ua-admin", active: true }));
  await fs.writeFile(path.join(root, "mybot", "bots", "child-credential.json"), JSON.stringify({ cookie: {}, prefix: "!" }));
  await fs.writeFile(path.join(root, "mybot", "bots", "pm2bot-credential.json"), JSON.stringify({ cookie: {} }));
  await fs.writeFile(path.join(root, "mybot", "web-config.json"), JSON.stringify({ prefix: "!", selectedGroups: {} }));
  await fs.writeFile(path.join(root, "mybot", "web-config-child.json"), JSON.stringify({ prefix: "!", selectedGroups: {} }));
  await fs.writeFile(path.join(root, "mybot", "json-data", "command-admin.json"), JSON.stringify({ prefix: "!", commands: [{ name: "ping" }] }));
  await fs.writeFile(path.join(root, "mybot", "json-data", "command-child.json"), JSON.stringify({ prefix: "!", commands: [{ name: "ping" }] }));
  await fs.writeFile(path.join(root, "mybot", "json-data", "command-pm2bot.json"), JSON.stringify({ prefix: "!", commands: [{ name: "ping" }] }));
  await fs.writeFile(path.join(root, "mybot", "instances", "child", "data", "command.json"), JSON.stringify({ prefix: "!", commands: [{ name: "ping" }] }));
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    prefix: "!",
    commands: [
      { name: "ping", alias: ["p"], permission: "all", countdown: 0, active: true, icon: "P", type: 1 },
    ],
  }));
  return root;
}

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", ...options.headers }, ...options });
  return { status: res.status, body: await res.json() };
}

async function putJson(url, body, requestId) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function postJson(url, body, requestId) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function startSharedApi(root, options = {}) {
  const app = express();
  app.use(express.json());
  registerDashboardApi(app, { root, ...options });
  return listen(app);
}

test("shared dashboard API wraps success and errors with request IDs", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root, {
    actions: {
      start: async (id) => ({ status: "starting", id }),
      stop: async (id) => ({ status: "stopping", id }),
      restart: async (id) => ({ status: "restarting", id }),
      delete: async (id) => ({ status: "deleted", id }),
    },
  });
  try {
    const ok = await fetchJson(`${server.url}/api/bots`, { headers: { "X-Request-ID": "req-list" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.success, true);
    assert.equal(ok.body.requestId, "req-list");
    assert.ok(Array.isArray(ok.body.data.bots));

    const missing = await fetchJson(`${server.url}/api/bots/missing/config/nope`, { headers: { "X-Request-ID": "req-missing" } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.success, false);
    assert.equal(missing.body.requestId, "req-missing");
    assert.equal(missing.body.error.code, "BOT_NOT_FOUND");
  } finally {
    await server.close();
  }
});

test("shared dashboard API serves QR login through injected manager with envelope responses", async () => {
  const root = await makeDashboardFixture();
  const calls = [];
  const qrSessionManager = {
    maxConcurrentSessions: 2,
    start: async (botId) => {
      calls.push(["start", botId]);
      return { botId, state: "waiting_scan", qrImage: "data:image/png;base64,qr" };
    },
    get: async (botId) => {
      calls.push(["get", botId]);
      return null;
    },
    cancel: async (botId) => {
      calls.push(["cancel", botId]);
      return true;
    },
    list: async () => [{ botId: "child", state: "waiting_scan" }],
    activeCount: () => 1,
  };
  const server = await startSharedApi(root, { qrSessionManager });
  try {
    const start = await fetch(`${server.url}/api/bots/child/actions/qr-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-qr-start" },
      body: JSON.stringify({}),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(start.status, 202);
    assert.equal(start.body.success, true);
    assert.equal(start.body.requestId, "req-qr-start");
    assert.equal(start.body.data.botId, "child");
    assert.equal(start.body.data.state, "waiting_scan");
    assert.equal(calls[0][0], "start");
    assert.equal(calls[0][1], "child");

    const get = await fetchJson(`${server.url}/api/bots/child/qr-login`, { headers: { "X-Request-ID": "req-qr-get" } });
    assert.equal(get.status, 200);
    assert.equal(get.body.success, true);
    assert.equal(get.body.data.botId, "child");
    assert.equal(get.body.data.state, "idle");

    const list = await fetchJson(`${server.url}/api/system/qr-sessions`, { headers: { "X-Request-ID": "req-qr-list" } });
    assert.equal(list.status, 200);
    assert.equal(list.body.success, true);
    assert.equal(list.body.data.activeCount, 1);
    assert.equal(Array.isArray(list.body.data.sessions), true);

    const cancel = await fetch(`${server.url}/api/bots/child/qr-login`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-qr-cancel" },
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.success, true);
    assert.equal(cancel.body.data.cancelled, true);
    assert.equal(calls.some(([name]) => name === "cancel"), true);
  } finally {
    await server.close();
  }
});

test("canonical actions pass payload, normalize legacy ids, and expose partial failures", async () => {
  const root = await makeDashboardFixture();
  const calls = [];
  const server = await startSharedApi(root, {
    actions: {
      start: async (id, payload) => { calls.push({ id, payload }); return { status: "starting", id }; },
      delete: async (id, payload) => id === "child" ? { deleted: true, id, payload } : Promise.reject(Object.assign(new Error("failed"), { code: "ACTION_FAILED", status: 409 })),
    },
  });
  try {
    const single = await postJson(`${server.url}/api/bots/child/actions/start`, { reason: "manual" }, "req-start");
    assert.equal(single.success, true);
    assert.deepEqual(calls[0], { id: "child", payload: { reason: "manual" } });

    const unavailable = await fetch(`${server.url}/api/bots/child/actions/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-unavailable" },
      body: "{}",
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error.code, "ACTION_UNAVAILABLE");
    assert.equal(unavailable.body.requestId, "req-unavailable");

    const bulk = await fetch(`${server.url}/api/bots/actions/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-bulk" },
      body: JSON.stringify({ action: "delete", ids: ["child", "pm2bot"], confirm: "DELETE_SELECTED_BOTS" }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(bulk.status, 207);
    assert.equal(bulk.body.success, false);
    assert.equal(bulk.body.error.code, "PARTIAL_DELETE");
    assert.equal(bulk.body.requestId, "req-bulk");
    assert.deepEqual(bulk.body.data.results.map((item) => item.botId), ["child", "pm2bot"]);
  } finally {
    await server.close();
  }
});

test("provider config API reads masked state and saves only changed keys", async () => {
  const root = await makeDashboardFixture();
  await fs.writeFile(path.join(root, ".env.local"), "GEMINI_API_KEYS=test-gemini-value\nCUSTOM_FLAG=keep\n");
  await fs.writeFile(path.join(root, ".env"), "TENOR_API_KEY=test-tenor-fallback\n");
  const server = await startSharedApi(root);
  try {
    const read = await fetchJson(`${server.url}/api/provider-config`, {
      headers: { "X-Request-ID": "req-provider-read" },
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.requestId, "req-provider-read");
    assert.equal(read.body.data.keys.find((item) => item.name === "GEMINI_API_KEYS").masked, "********");
    assert.equal(JSON.stringify(read.body).includes("test-gemini-value"), false);

    const update = await putJson(`${server.url}/api/provider-config`, {
      values: { TENOR_API_KEY: "new-tenor", GEMINI_API_KEYS: "" },
    }, "req-provider-update");
    assert.equal(update.success, true);
    assert.equal(update.restartRequired, true);
    assert.deepEqual(update.changedKeys, ["GEMINI_API_KEYS", "TENOR_API_KEY"]);
    assert.ok(update.backup?.file);
    assert.equal(JSON.stringify(update).includes("new-tenor"), false);

    const saved = await fs.readFile(path.join(root, ".env.local"), "utf8");
    assert.match(saved, /CUSTOM_FLAG=keep/);
    assert.match(saved, /TENOR_API_KEY=new-tenor/);
    assert.doesNotMatch(saved, /GEMINI_API_KEYS=/);
    const audit = await fs.readFile(path.join(root, "logs", "dashboard-audit.jsonl"), "utf8");
    assert.match(audit, /provider-config\.update/);
    assert.match(audit, /TENOR_API_KEY/);
    assert.doesNotMatch(audit, /new-tenor|test-gemini-value/);
  } finally {
    await server.close();
  }
});

test("provider config API rejects malformed payloads and unknown keys", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    for (const values of [null, [], { NOT_A_PROVIDER: "x" }, { TENOR_API_KEY: 123 }]) {
      const response = await fetch(`${server.url}/api/provider-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.success, false);
      assert.equal(body.error.code, "PROVIDER_CONFIG_INVALID");
    }
  } finally {
    await server.close();
  }
});

test("audit store appends dashboard write metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-audit-"));
  const audit = new AuditStore({ root });
  await audit.append({ requestId: "req-audit", action: "config.update", botId: "child", changedPaths: ["mybot/bots/child.json"] });
  const entries = await audit.list();
  assert.equal(entries[0].requestId, "req-audit");
  assert.equal(entries[0].action, "config.update");
  assert.equal(entries[0].actor, "dashboard-local");
});

test("bot registry discovers inventory, bot files, state files, pid, pm2, and port health", async () => {
  const root = await makeDashboardFixture();
  const registry = new BotRegistry({
    root,
    pm2: { status: async (id) => id === "pm2bot" ? { status: "online", pid: 1234 } : null },
    portProbe: async (port) => Number(port) === 3333,
  });
  const bots = await registry.list();
  const ids = bots.map((bot) => bot.id);
  assert.ok(ids.includes("admin"));
  assert.ok(ids.includes("child"));
  assert.ok(ids.includes("pm2bot"));
  assert.ok(ids.includes("stateonly"));
  assert.equal(bots.find((bot) => bot.id === "child").portOpen, true);
  assert.equal(bots.find((bot) => bot.id === "stateonly").processAlive, true);
  assert.equal(bots.find((bot) => bot.id === "pm2bot").pm2Status.status, "online");
});

test("config update writes backup, audit, changed paths, and rollback restores", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const update = await putJson(`${server.url}/api/bots/child/config/WEB_CONFIG_PATH`, { prefix: "#" }, "req-config");
    assert.equal(update.success, true);
    assert.equal(update.restartRequired, true);
    assert.equal(update.changedPaths.length, 1);
    assert.ok(update.backup);

    const saved = JSON.parse(await fs.readFile(path.join(root, "mybot", "web-config-child.json"), "utf8"));
    assert.equal(saved.prefix, "#");

    const rollback = await postJson(`${server.url}/api/bots/child/config/rollback`, { pathKey: "WEB_CONFIG_PATH", backup: update.backup.file }, "req-rollback");
    assert.equal(rollback.success, true);
    const restored = JSON.parse(await fs.readFile(path.join(root, "mybot", "web-config-child.json"), "utf8"));
    assert.equal(restored.prefix, "!");
  } finally {
    await server.close();
  }
});

test("per-bot prefix API reads and updates only the selected bot command config", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const legacyCommandPath = path.join(root, "mybot", "json-data", "command-child.json");
    const legacyCommand = JSON.parse(await fs.readFile(legacyCommandPath, "utf8"));
    await fs.writeFile(legacyCommandPath, JSON.stringify({ ...legacyCommand, prefix: "$" }), "utf8");
    const read = await fetchJson(`${server.url}/api/bots/child/prefix`, { headers: { "X-Request-ID": "req-prefix-read" } });
    assert.equal(read.status, 200);
    assert.equal(read.body.data.botId, "child");
    assert.equal(read.body.data.prefix, "!");

    const unavailable = await fetchJson(`${server.url}/api/bots/stateonly/prefix`);
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.data.prefix, "!");
    assert.equal(unavailable.body.data.available, false);

    const invalid = await fetch(`${server.url}/api/bots/child/prefix`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-prefix-invalid" },
      body: JSON.stringify({ prefix: "too-long" }),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.error.code, "PREFIX_INVALID");

    const update = await putJson(`${server.url}/api/bots/child/prefix`, { prefix: "#" }, "req-prefix-update");
    assert.equal(update.success, true);
    assert.equal(update.data.botId, "child");
    assert.equal(update.data.prefix, "#");
    assert.equal(update.restartRequired, true);
    assert.ok(update.backup?.file);

    const childCommand = JSON.parse(await fs.readFile(path.join(root, "mybot", "json-data", "command-child.json"), "utf8"));
    const childRuntimeCommand = JSON.parse(await fs.readFile(path.join(root, "mybot", "instances", "child", "data", "command.json"), "utf8"));
    const adminCommand = JSON.parse(await fs.readFile(path.join(root, "mybot", "json-data", "command-admin.json"), "utf8"));
    assert.equal(childCommand.prefix, "#");
    assert.deepEqual(childCommand.commands, [{ name: "ping" }]);
    assert.equal(childRuntimeCommand.prefix, "#");
    assert.deepEqual(childRuntimeCommand.commands, [{ name: "ping" }]);
    assert.equal(adminCommand.prefix, "!");
    const audit = await fs.readFile(path.join(root, "logs", "dashboard-audit.jsonl"), "utf8");
    assert.match(audit, /"action":"prefix\.update"/);
    assert.match(audit, /"botId":"child"/);
  } finally {
    await server.close();
  }
});

test("credential read is masked, reveal is explicit, and update writes allowed credential fields", async () => {
  const root = await makeDashboardFixture();
  const botConfigPath = path.join(root, "mybot", "bots", "admin.json");
  const botConfig = JSON.parse(await fs.readFile(botConfigPath, "utf8"));
  await fs.writeFile(botConfigPath, JSON.stringify({ ...botConfig, configFilePath: "assets/config.json" }));
  const registryPath = path.join(root, "mybot", "mybots.json");
  const records = JSON.parse(await fs.readFile(registryPath, "utf8"));
  await fs.writeFile(registryPath, JSON.stringify({ ...records, admin: { name: "admin", uid: "main-account", isMain: true } }));
  await fs.copyFile(path.join(root, "mybot", "bots", "admin-credential.json"), path.join(root, "assets", "config.json"));
  const registry = new BotRegistry({ root });
  const credentialService = new CredentialService({ root, registry, verifyCredential: async () => ({ uid: "main-account" }) });
  const server = await startSharedApi(root, { registry, credentialService });
  try {
    const masked = await fetchJson(`${server.url}/api/bots/admin/credential`);
    assert.equal(masked.body.data.value.cookie, "[masked]");
    const revealed = await postJson(`${server.url}/api/bots/admin/credential/reveal`, {}, "req-reveal");
    assert.equal(revealed.data.raw.cookie.token, "secret");
    const update = await putJson(`${server.url}/api/bots/admin/credential`, { imei: "imei-1", userAgent: "ua-1", active: true }, "req-cred");
    assert.equal(update.restartRequired, true);
    assert.ok(update.backup?.file);
    const saved = JSON.parse(await fs.readFile(path.join(root, "assets", "config.json"), "utf8"));
    assert.equal(saved.imei, "imei-1");
    assert.equal(saved.userAgent, "ua-1");
    assert.equal(saved.active, true);
  } finally {
    await server.close();
  }
});

test("command API rejects duplicate aliases and preserves a backup before changing the global registry", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const duplicate = await fetch(`${server.url}/api/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-duplicate" },
      body: JSON.stringify({ name: "pong", alias: ["p"], permission: "all", countdown: 0, active: true, type: 1 }),
    }).then(async (res) => ({ status: res.status, body: await res.json() }));
    assert.equal(duplicate.status, 400);
    assert.equal(duplicate.body.error.code, "COMMAND_VALIDATION_FAILED");

    const update = await putJson(`${server.url}/api/commands/ping`, { description: "Ping command" }, "req-command-backup");
    assert.ok(update.backup?.file);
    const backedUp = JSON.parse(await fs.readFile(update.backup.file, "utf8"));
    assert.equal(backedUp.commands[0].name, "ping");
  } finally {
    await server.close();
  }
});

test("command APIs update global commands and validate bad fields", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const update = await putJson(`${server.url}/api/commands/ping`, { alias: ["p"], permission: "all", countdown: 1 }, "req-command");
    assert.equal(update.success, true);
    assert.equal(update.restartRequired, true);

    const bad = await fetch(`${server.url}/api/commands/ping`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Request-ID": "req-bad" },
      body: JSON.stringify({ alias: [""], permission: "owner", countdown: -1 }),
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.success, false);
    assert.equal(bad.body.error.code, "COMMAND_VALIDATION_FAILED");
  } finally {
    await server.close();
  }
});

test("command scan API exposes runtime enablement and handler availability", async () => {
  const root = await makeDashboardFixture();
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({
    prefix: "!",
    commands: [
      { name: "help", alias: ["menu"], permission: "all", countdown: 5, active: false, icon: "📚", type: 1 },
    ],
  }));

  const server = await startSharedApi(root);
  try {
    const scan = await fetchJson(`${server.url}/api/commands/scan`);
    const help = scan.body.data.commands.find((cmd) => cmd.name === "help");

    assert.equal(scan.body.success, true);
    assert.equal(help.active, false);
    assert.equal(help.enabled, false);
    assert.equal(help.handlerAvailable, true);
    assert.ok(Array.isArray(help.requiredConfig));
    assert.ok(Array.isArray(help.requiredDependencies));
    assert.ok(help.missingDependencies.includes("zaloSession"));
  } finally {
    await server.close();
  }
});

test("per-bot command override can be saved, copied from admin, reset, and applied to all", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const override = await putJson(`${server.url}/api/bots/child/commands/ping`, { active: false, alias: ["pc"] }, "req-override");
    assert.equal(override.success, true);
    const botCommands = await fetchJson(`${server.url}/api/bots/child/commands`);
    assert.equal(botCommands.body.data.commands.find((cmd) => cmd.name === "ping").override.active, false);

    const reset = await fetch(`${server.url}/api/bots/child/commands/ping/override`, { method: "DELETE", headers: { "X-Request-ID": "req-reset" } }).then((res) => res.json());
    assert.equal(reset.success, true);

    const apply = await postJson(`${server.url}/api/commands/apply-all`, { commandName: "ping", patch: { active: true } }, "req-apply-all");
    assert.equal(apply.success, true);
    assert.ok(apply.data.botIds.includes("child"));
  } finally {
    await server.close();
  }
});

test("provider health API exposes masked group state without secrets", async () => {
  const root = await makeDashboardFixture();
  const server = await startSharedApi(root);
  try {
    const response = await fetchJson(`${server.url}/api/provider-health`);
    assert.equal(response.body.success, true);
    assert.ok(response.body.data.health.gemini);
    assert.equal(Array.isArray(response.body.data.groups), true);
    assert.equal(JSON.stringify(response.body).includes("test-gemini-value"), false);
  } finally {
    await server.close();
  }
});
