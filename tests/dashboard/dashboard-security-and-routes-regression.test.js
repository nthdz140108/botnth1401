import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import portfinder from "portfinder";
import { io as createSocketClient } from "socket.io-client";

import { registerDashboardApi } from "../../src/dashboard/api-routes.js";
import { createDashboardGateway, isProxyPath } from "../../src/dashboard/dashboard-gateway.js";
import { createBotActionService, defaultRestartLauncher } from "../../src/dashboard/bot-action-service.js";
import { RoleRegistryService } from "../../src/dashboard/role-registry-service.js";
import { CredentialService } from "../../src/dashboard/credential-service.js";
import { ConfigStore } from "../../src/dashboard/config-store.js";
import { CommandService } from "../../src/dashboard/command-service.js";
import { apiRequest, redactSecrets } from "../../dashboard/src/api/client.js";

async function makeTempRoot(t, prefix = "mybot-c6-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

async function startTestApp(t, app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
  });
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}`;
}

test("dashboard server auth guard blocks prefix/traversal bypasses, enforces proxy trust, and compares digests safely", async (t) => {
  const prevTestMode = process.env.DASHBOARD_TEST_MODE;
  const prevTrustProxy = process.env.DASHBOARD_TRUST_PROXY;
  const prevProjectRoot = process.env.DASHBOARD_PROJECT_ROOT;
  const prevLegacyRoot = process.env.PROJECT_ROOT;
  const prevMixedRoot = process.env.ProjectRoot;

  process.env.DASHBOARD_TEST_MODE = "1";
  delete process.env.DASHBOARD_TRUST_PROXY;
  delete process.env.DASHBOARD_PROJECT_ROOT;
  delete process.env.PROJECT_ROOT;
  delete process.env.ProjectRoot;

  t.after(() => {
    if (prevTestMode === undefined) delete process.env.DASHBOARD_TEST_MODE;
    else process.env.DASHBOARD_TEST_MODE = prevTestMode;
    if (prevTrustProxy === undefined) delete process.env.DASHBOARD_TRUST_PROXY;
    else process.env.DASHBOARD_TRUST_PROXY = prevTrustProxy;
    if (prevProjectRoot === undefined) delete process.env.DASHBOARD_PROJECT_ROOT;
    else process.env.DASHBOARD_PROJECT_ROOT = prevProjectRoot;
    if (prevLegacyRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = prevLegacyRoot;
    if (prevMixedRoot === undefined) delete process.env.ProjectRoot;
    else process.env.ProjectRoot = prevMixedRoot;
  });

  const serverMod = await import(`../../dashboard/server.js?c6auth=${Date.now()}`);
  const expectedRepoRoot = path.resolve(process.cwd());
  assert.equal(serverMod.projectRoot, expectedRepoRoot);

  // Constant-time digest comparison across mismatched string & UTF-8 byte lengths
  assert.equal(serverMod.timingSafeEqualSafe("secret-value", "secret-value"), true);
  assert.equal(serverMod.timingSafeEqualSafe("short", "much-longer-secret"), false);
  assert.equal(serverMod.timingSafeEqualSafe("á", "ab"), false);

  // Proxy IP spoofing protection
  const fakeReq = {
    headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  delete process.env.DASHBOARD_TRUST_PROXY;
  assert.equal(serverMod.getClientIp(fakeReq), "127.0.0.1");
  process.env.DASHBOARD_TRUST_PROXY = "1";
  assert.equal(serverMod.getClientIp(fakeReq), "203.0.113.9");
  delete process.env.DASHBOARD_TRUST_PROXY;

  // Live HTTP checks against createDashboardServer (raw http requests preserve unnormalized paths)
  const dashboardServer = serverMod.createDashboardServer();
  await new Promise((resolve) => dashboardServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => dashboardServer.close(() => resolve()));
  });
  const port = dashboardServer.address().port;

  const rawGet = (rawPath) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: rawPath },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { data += chunk; });
          res.on("end", () => {
            let parsed = null;
            try { parsed = JSON.parse(data); } catch {}
            resolve({ status: res.statusCode, body: parsed });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });

  // Public allowlisted endpoints remain reachable without session cookie
  const sessionRes = await rawGet("/api/auth/session");
  assert.equal(sessionRes.status, 401);
  assert.equal(sessionRes.body?.authenticated, false);

  const healthRes = await rawGet("/api/system/health");
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.body?.success, true);

  // Bypass attempts must all fail with 401 AUTH_REQUIRED
  for (const bypassPath of [
    "/api/auth/other",
    "/api/auth/login/extra",
    "/api/auth/../bots",
    "/api/auth/%2e%2e/bots",
    "/api/system/health/../bots",
    "/api/system/health/%2e%2e/bots",
  ]) {
    const res = await rawGet(bypassPath);
    assert.equal(res.status, 401, `Expected 401 for ${bypassPath}, got ${res.status}`);
    assert.equal(res.body?.error, "AUTH_REQUIRED");
  }
});

test("dashboard gateway blocks SSRF protocol-relative URLs, path traversal, and unanchored QR paths", async (t) => {
  assert.equal(isProxyPath("/api/groups"), true);
  assert.equal(isProxyPath("/api/bots/child-1/qr-login"), true);
  assert.equal(isProxyPath("/api/bots/child-1/actions/qr-login"), true);

  assert.equal(isProxyPath("/foo/api/bots/child-1/qr-login"), false);
  assert.equal(isProxyPath("//evil.example/api/groups"), false);
  assert.equal(isProxyPath("/api/system/../internal/runtime/reload"), false);
  assert.equal(isProxyPath("/api/system/%2e%2e/internal/runtime/reload"), false);
  assert.equal(isProxyPath("/api/system/%2E%2E/internal/runtime/reload"), false);
  assert.equal(isProxyPath("/api/system\\..\\internal"), false);

  let upstreamCalls = 0;
  const gateway = createDashboardGateway({
    upstreamUrl: "http://127.0.0.1:29999",
    upstreamDisabled: false,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });

  const invokeMiddleware = (rawUrl, reqPath = rawUrl) =>
    new Promise((resolve) => {
      const req = {
        method: "GET",
        url: rawUrl,
        originalUrl: rawUrl,
        path: reqPath,
        headers: {},
      };
      const headers = {};
      const res = {
        statusCode: 200,
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { resolve({ handled: true, status: this.statusCode, body: payload, headers }); return this; },
        send(payload) { resolve({ handled: true, status: this.statusCode, body: payload, headers }); return this; },
      };
      gateway.middleware(req, res, () => resolve({ handled: false }));
    });

  const ssrfAttempt = await invokeMiddleware("//evil.example/api/groups", "//evil.example/api/groups");
  assert.equal(ssrfAttempt.handled, true);
  assert.equal(ssrfAttempt.status, 400);
  assert.equal(ssrfAttempt.body?.error?.code, "INVALID_PROXY_PATH");

  const dotDotAttempt = await invokeMiddleware("/api/system/../internal/runtime/reload", "/api/system/../internal/runtime/reload");
  assert.equal(dotDotAttempt.handled, true);
  assert.equal(dotDotAttempt.status, 400);
  assert.equal(dotDotAttempt.body?.error?.code, "INVALID_PROXY_PATH");

  const encodedDotAttempt = await invokeMiddleware("/api/system/%2e%2e/internal/runtime/reload", "/api/system/%2e%2e/internal/runtime/reload");
  assert.equal(encodedDotAttempt.handled, true);
  assert.equal(encodedDotAttempt.status, 400);
  assert.equal(encodedDotAttempt.body?.error?.code, "INVALID_PROXY_PATH");

  const unanchoredQr = await invokeMiddleware("/prefix/api/bots/child-1/qr-login", "/prefix/api/bots/child-1/qr-login");
  assert.equal(unanchoredQr.handled, false);

  assert.equal(upstreamCalls, 0);
});

test("admin restart never calls process.exit and swapAdminBot rolls back stuck in-progress transactions", async (t) => {
  const root = await makeTempRoot(t, "mybot-c6-restart-");
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.writeFile(path.join(root, "mybot", "bots", "admin.json"), JSON.stringify({ webPort: 24567 }), "utf8");

  const originalExit = process.exit;
  let exitCalled = false;
  process.exit = () => {
    exitCalled = true;
    throw new Error("process.exit must never be called during dashboard admin restart");
  };
  t.after(() => {
    process.exit = originalExit;
  });

  // Case 1: PM2 manages admin -> restarts via PM2 + writes .bot-action without process.exit
  let pm2Restarted = null;
  const pm2Result = await defaultRestartLauncher({
    botId: "admin",
    root,
    pm2: {
      status: async () => ({ running: true, status: "online" }),
      restart: async (id) => {
        pm2Restarted = id;
        return { success: true };
      },
    },
    fetchImpl: async () => {
      throw new Error("fetchImpl should not be needed when PM2 restart succeeds");
    },
  });
  assert.equal(pm2Result, true);
  assert.equal(pm2Restarted, "admin");
  assert.equal(exitCalled, false);
  const botActionRaw = (await fs.readFile(path.join(root, ".bot-action"), "utf8")).trim();
  assert.equal(botActionRaw, "restart");

  // Case 2: Standalone mode (PM2 not managing admin) -> posts to loopback /internal/runtime/reload
  const reloadCalls = [];
  const standaloneActions = createBotActionService({
    readinessProbe: async () => ({ healthy: true }),
    root,
    registry: {
      inventoryPath: path.join(root, "mybot", "mybots.json"),
      describe: async (id) => (id === "admin" ? { id: "admin", enabled: true, status: "running", webPort: 24567 } : null),
    },
    configStore: new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") }),
    pm2Adapter: {
      status: async () => ({ running: false, status: "not_found" }),
      restart: async () => false,
    },
    restartLauncher: (ctx) =>
      defaultRestartLauncher({
        ...ctx,
        fetchImpl: async (url, init) => {
          reloadCalls.push({ url: String(url), body: JSON.parse(init.body) });
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        },
      }),
  });

  const restartRes = await standaloneActions.restart("admin");
  assert.equal(restartRes.status, "running");
  assert.equal(exitCalled, false);
  assert.equal(reloadCalls.length, 1);
  assert.equal(reloadCalls[0].url, "http://127.0.0.1:24567/internal/runtime/reload");
  assert.deepEqual(reloadCalls[0].body, { action: "restart", reason: "dashboard" });

  // Case 3: RoleRegistryService.swapAdminBot rolls back in-progress state on post-write restart failure
  const configStore = new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") });
  let failTargetRestart = true;
  let observedInProgressOnDisk = false;
  const roleRegistry = new RoleRegistryService({
    root,
    configStore,
    registry: {
      describe: async (id) => {
        if (id === "admin") return { id: "admin", enabled: true, status: "running", connected: true, credential: { state: "configured" } };
        if (id === "bot-2") {
          return {
            id: "bot-2",
            enabled: true,
            status: "running",
            connected: true,
            credential: { state: "configured" },
          };
        }
        return null;
      },
    },
    actions: {
      restart: async (id) => {
        if (id === "bot-2" && failTargetRestart) {
          const midSwap = JSON.parse(await fs.readFile(path.join(root, "mybot", "role-registry.json"), "utf8"));
          observedInProgressOnDisk = midSwap?.transaction?.status === "in-progress";
          throw new Error("PM2 restart failed for bot-2");
        }
        return { botId: id, status: "restarting" };
      },
    },
  });

  await assert.rejects(
    () => roleRegistry.swapAdminBot("bot-2", { confirm: true, actor: "test" }),
    /PM2 restart failed for bot-2/
  );
  assert.equal(observedInProgressOnDisk, true);

  const afterFailedSwap = await roleRegistry.read();
  assert.equal(afterFailedSwap.adminBotId, "admin");
  assert.equal(afterFailedSwap.transaction, null);

  // Subsequent swap succeeds cleanly because transaction is not stuck in "in-progress"
  failTargetRestart = false;
  const committed = await roleRegistry.swapAdminBot("bot-2", { confirm: true, actor: "test" });
  assert.equal(committed.adminBotId, "bot-2");
  assert.equal(committed.transaction?.status, "committed");
});

test("GET /api/logs, GET/POST /api/provider-config, and bot config routes enforce contracts and path containment", async (t) => {
  const root = await makeTempRoot(t, "mybot-c6-routes-");
  const prevGeminiEnv = process.env.GEMINI_API_KEYS;
  const prevOpenAiEnv = process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEYS;
  delete process.env.OPENAI_API_KEY;
  t.after(() => {
    if (prevGeminiEnv === undefined) delete process.env.GEMINI_API_KEYS;
    else process.env.GEMINI_API_KEYS = prevGeminiEnv;
    if (prevOpenAiEnv === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAiEnv;
  });
  await fs.mkdir(path.join(root, "logs", "admin"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.writeFile(
    path.join(root, "logs", "admin", "runtime.log"),
    "2026-01-01 INFO boot ok\n2026-01-01 WARN slow query\n2026-01-01 ERROR socket timeout\n",
    "utf8"
  );
  await fs.writeFile(path.join(root, "mybot", "web-config.json"), JSON.stringify({ prefix: "!" }), "utf8");
  const outsideSecretPath = path.join(os.tmpdir(), `outside-secret-${Date.now()}.json`);
  await fs.writeFile(outsideSecretPath, JSON.stringify({ leaked: true }), "utf8");
  t.after(async () => {
    await fs.rm(outsideSecretPath, { force: true }).catch(() => {});
  });

  const app = express();
  app.use(express.json());
  registerDashboardApi(app, {
    root,
    registry: {
      list: async () => [{ id: "admin", status: "running", enabled: true }],
      describe: async (id) => {
        if (id === "admin") {
          return {
            id: "admin",
            status: "running",
            enabled: true,
            paths: {
              webConfig: "mybot/web-config.json",
              escaped: outsideSecretPath,
            },
          };
        }
        return null;
      },
      runtime: async () => ({ status: "running" }),
    },
  });

  const baseUrl = await startTestApp(t, app);

  // GET /api/logs filtering & path traversal rejection
  const errorLogsRes = await fetch(`${baseUrl}/api/logs?botId=admin&severity=error`);
  assert.equal(errorLogsRes.status, 200);
  const errorLogsBody = await errorLogsRes.json();
  assert.equal(errorLogsBody.success, true);
  assert.equal(errorLogsBody.data.logs.length, 1);
  assert.match(errorLogsBody.data.logs[0].message, /socket timeout/);

  const traversalLogsRes = await fetch(`${baseUrl}/api/logs?botId=../outside`);
  assert.equal(traversalLogsRes.status, 400);
  const traversalLogsBody = await traversalLogsRes.json();
  assert.equal(traversalLogsBody.error?.code, "INVALID_BOT_ID");

  // GET & POST /api/provider-config (both { values } and flat payload)
  const initialProvider = await fetch(`${baseUrl}/api/provider-config`).then((r) => r.json());
  assert.equal(initialProvider.success, true);
  assert.ok(Array.isArray(initialProvider.data.keys));

  const postNestedRes = await fetch(`${baseUrl}/api/provider-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ values: { GEMINI_API_KEYS: "gem-key-123456" } }),
  });
  assert.equal(postNestedRes.status, 200);
  const postNestedBody = await postNestedRes.json();
  assert.equal(postNestedBody.success, true);
  assert.ok(Array.isArray(postNestedBody.data.keys));
  assert.ok(postNestedBody.data.health && typeof postNestedBody.data.health === "object");

  const postFlatRes = await fetch(`${baseUrl}/api/provider-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ OPENAI_API_KEY: "sk-openai-654321" }),
  });
  assert.equal(postFlatRes.status, 200);
  const postFlatBody = await postFlatRes.json();
  assert.equal(postFlatBody.success, true);
  const openAiEntry = postFlatBody.data.keys.find((item) => item.name === "OPENAI_API_KEY");
  assert.equal(openAiEntry?.configured, true);

  // Bot config route rejects out-of-root pathKey and traversal pathKey
  const validCfgRes = await fetch(`${baseUrl}/api/bots/admin/config/webConfig`);
  assert.equal(validCfgRes.status, 200);

  const escapedCfgRes = await fetch(`${baseUrl}/api/bots/admin/config/escaped`);
  assert.equal(escapedCfgRes.status, 400);
  const escapedCfgBody = await escapedCfgRes.json();
  assert.equal(escapedCfgBody.error?.code, "INVALID_CONFIG_PATH");

  const badBotIdRes = await fetch(`${baseUrl}/api/bots/..%2Fevil/config`);
  assert.equal(badBotIdRes.status, 400);
  const badBotIdBody = await badBotIdRes.json();
  assert.equal(badBotIdBody.error?.code, "INVALID_BOT_ID");
});

test("CredentialService, ConfigStore.rollback, and CommandService prevent secret clobbering and path escapes", async (t) => {
  const root = await makeTempRoot(t, "mybot-c6-cred-");
  const credPath = path.join(root, "mybot", "credentials", "bot-1.json");
  await fs.mkdir(path.dirname(credPath), { recursive: true });
  const initialRaw = {
    accountUid: "account-1",
    accountIdentityStatus: "verified",
    imei: "real-imei-999",
    userAgent: "Mozilla/5.0 RealUA",
    cookie: { url: "https://chat.zalo.me", cookies: [{ name: "zpw_sek", value: "live-session-secret" }] },
  };
  await fs.writeFile(credPath, JSON.stringify(initialRaw, null, 2), "utf8");

  const configStore = new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") });
  const registry = {
    describe: async (id) => (id === "bot-1" ? { id: "bot-1", configPath: "mybot/credentials/bot-1.json" } : null),
  };
  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({ "bot-1": { name: "bot-1", uid: "account-1", accountUid: "account-1", ownerUid: "owner", accountIdentityStatus: "verified" } }));
  const credentialService = new CredentialService({ root, registry, configStore, verifyCredential: async () => ({ uid: "account-1" }) });

  // read() redacts and omits raw
  const readResult = await credentialService.read("bot-1");
  assert.equal(readResult.configured, true);
  assert.equal(readResult.state, "configured");
  assert.equal("raw" in readResult, false);
  assert.equal(readResult.value.imei, "[masked]");
  assert.equal(readResult.value.cookie, "[masked]");

  // reveal() exposes raw
  const revealResult = await credentialService.reveal("bot-1");
  assert.equal(revealResult.configured, true);
  assert.deepEqual(revealResult.raw, initialRaw);

  // update() strips "[REDACTED]" and "[masked]" placeholders recursively without clobbering real secrets
  await credentialService.update("bot-1", {
    imei: "[REDACTED]",
    userAgent: "Mozilla/5.0 UpdatedUA",
    cookie: "[masked]",
  });

  const persisted = JSON.parse(await fs.readFile(credPath, "utf8"));
  assert.equal(persisted.imei, "real-imei-999");
  assert.equal(persisted.userAgent, "Mozilla/5.0 UpdatedUA");
  assert.equal(persisted.cookie.cookies[0].value, "live-session-secret");

  // CredentialService rejects unsafe botId
  await assert.rejects(() => credentialService.read("../outside"), (err) => err.code === "INVALID_BOT_ID");

  // ConfigStore.rollback enforces both backupDir containment AND matching target basename
  const fileA = path.join(root, "mybot", "configs", "botA.json");
  const fileB = path.join(root, "mybot", "configs", "botB.json");
  await configStore.writeJson(fileA, { owner: "A1" });
  const writeA2 = await configStore.writeJson(fileA, { owner: "A2" });
  await configStore.writeJson(fileB, { owner: "B1" });
  const writeB2 = await configStore.writeJson(fileB, { owner: "B2" });

  await assert.rejects(
    () => configStore.rollback(fileA, writeB2.backup.file),
    (err) => err.code === "INVALID_BACKUP_PATH"
  );
  await assert.rejects(
    () => configStore.rollback(fileA, path.join(root, "mybot", "credentials", "bot-1.json")),
    (err) => err.code === "INVALID_BACKUP_PATH"
  );

  await configStore.rollback(fileA, writeA2.backup.file);
  assert.deepEqual(await configStore.readJson(fileA), { owner: "A1" });

  // CommandService rejects path traversal botId
  const commandService = new CommandService({
    root,
    registry: { list: async () => [] },
    scanner: { scan: async () => ({ commands: [] }) },
    configStore,
  });
  await assert.rejects(
    () => commandService.listForBot("../escape"),
    (err) => err.code === "INVALID_BOT_ID"
  );
});

test("client redactSecrets preserves booleans/containers while redacting secrets and honoring allowSensitive", async () => {
  const input = {
    id: "admin",
    authenticated: true,
    cookieDead: false,
    tokenExpired: true,
    credential: {
      configured: true,
      state: "configured",
      value: {
        imei: "12345",
        cookie: { zpw_sek: "secret-cookie" },
        secretToken: "abc-secret",
      },
    },
    apiKey: "sk-live-999",
  };

  const redacted = redactSecrets(input);
  assert.equal(redacted.authenticated, true);
  assert.equal(redacted.cookieDead, false);
  assert.equal(redacted.tokenExpired, true);
  assert.equal(redacted.apiKey, "[REDACTED]");
  assert.equal(redacted.credential.configured, true);
  assert.equal(redacted.credential.state, "configured");
  assert.equal(redacted.credential.value.cookie, "[REDACTED]");
  assert.equal(redacted.credential.value.secretToken, "[REDACTED]");

  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          configured: true,
          raw: { cookie: { zpw_sek: "raw-live-cookie" }, secret: "raw-secret" },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const maskedResp = await apiRequest("/api/bots/admin/credential/reveal", {
    method: "POST",
    fetch: mockFetch,
  });
  assert.equal(maskedResp.data.raw.cookie, "[REDACTED]");
  assert.equal(maskedResp.data.raw.secret, "[REDACTED]");

  const revealedResp = await apiRequest("/api/bots/admin/credential/reveal", {
    method: "POST",
    allowSensitive: true,
    fetch: mockFetch,
  });
  assert.deepEqual(revealedResp.data.raw.cookie, { zpw_sek: "raw-live-cookie" });
  assert.equal(revealedResp.data.raw.secret, "raw-secret");
});

test("runtime web-server tracks connected Socket.IO clients and triggers reload handler on /internal/runtime/reload", async (t) => {
  const root = await makeTempRoot(t, "mybot-c6-webbridge-");
  const prevCwd = process.cwd();
  const prevSkipEnv = process.env.SKIP_ENV_VALIDATION;
  const prevName = process.env.name;
  const prevConfigPath = process.env.CONFIG_PATH;
  const prevProjectRoot = process.env.ProjectRoot;
  const prevWebPort = process.env.WEB_PORT;

  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "fonts"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "resources", "gif"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "temp"), { recursive: true });
  await fs.mkdir(path.join(root, "logs"), { recursive: true });

  const systemFont = "C:\\Windows\\Fonts\\arial.ttf";
  await fs.copyFile(systemFont, path.join(root, "assets", "fonts", "SVN-Transformer.ttf"));
  await fs.copyFile(systemFont, path.join(root, "assets", "fonts", "BeVietnamPro-Bold.ttf"));

  const port = await portfinder.getPortPromise({ port: 36000, stopPort: 46000 });
  const adminConfigPath = path.join(root, "mybot", "bots", "admin.json");
  await fs.writeFile(
    adminConfigPath,
    JSON.stringify({
      name: "admin",
      webPort: port,
      webHost: "127.0.0.1",
      adminFilePath: "assets/data/list_admin.json",
      configFilePath: "mybot/bots/admin-credential.json",
      WEB_CONFIG_PATH: "mybot/web-config.json",
      MANAGER_FILE_PATH: "mybot/manager.json",
      groupSettingsPath: "groupSettings.json",
      commandFilePath: "assets/json-data/command.json",
      logDir: "logs",
      resourceDir: "assets/resources",
      tempDir: "assets/temp",
      dataGifPath: "assets/resources/gif",
      PROPHYLACTIC_CONFIG_PATH: "assets/data/prophylactic.json",
      DATA_GAME_FILE_PATH: "assets/json-data/data-game.json",
    }),
    "utf8"
  );
  await fs.writeFile(path.join(root, "mybot", "bots", "admin-credential.json"), JSON.stringify({ cookie: {} }), "utf8");
  await fs.writeFile(path.join(root, "mybot", "web-config.json"), JSON.stringify({}), "utf8");
  await fs.writeFile(path.join(root, "mybot", "manager.json"), JSON.stringify({}), "utf8");
  await fs.writeFile(path.join(root, "assets", "data", "list_admin.json"), JSON.stringify(["admin"]), "utf8");
  await fs.writeFile(path.join(root, "assets", "data", "prophylactic.json"), JSON.stringify({ prophylacticUploadAttachment: { enable: false } }), "utf8");
  await fs.writeFile(path.join(root, "assets", "json-data", "data-game.json"), JSON.stringify({}), "utf8");
  await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "!", commands: [] }), "utf8");
  await fs.writeFile(path.join(root, "groupSettings.json"), JSON.stringify({}), "utf8");

  process.chdir(root);
  process.env.SKIP_ENV_VALIDATION = "1";
  process.env.name = "admin";
  process.env.CONFIG_PATH = adminConfigPath;
  process.env.ProjectRoot = root;
  process.env.WEB_PORT = String(port);

  const webMod = await import(`../../src/web-service/web-server.js?c6bridge=${Date.now()}`);
  t.after(async () => {
    webMod.registerRuntimeReloadHandler(null);
    await webMod.closeWebServer();
    process.chdir(prevCwd);
    if (prevSkipEnv === undefined) delete process.env.SKIP_ENV_VALIDATION;
    else process.env.SKIP_ENV_VALIDATION = prevSkipEnv;
    if (prevName === undefined) delete process.env.name;
    else process.env.name = prevName;
    if (prevConfigPath === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = prevConfigPath;
    if (prevProjectRoot === undefined) delete process.env.ProjectRoot;
    else process.env.ProjectRoot = prevProjectRoot;
    if (prevWebPort === undefined) delete process.env.WEB_PORT;
    else process.env.WEB_PORT = prevWebPort;
  });

  const reloadEvents = [];
  webMod.registerRuntimeReloadHandler(async (event) => {
    reloadEvents.push(event);
    return { reloaded: true };
  });

  await webMod.startWebServer(
    { getAllFriends: async () => [], sendMessage: async () => true },
    { projectRoot: root, disableExit: true }
  );

  assert.equal(webMod.getConnectedClientsCount(), 0);

  const socket = createSocketClient(`http://127.0.0.1:${port}`, {
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  assert.equal(webMod.getConnectedClientsCount(), 1);
  assert.equal(webMod.getConnectedClients().length, 1);

  socket.disconnect();
  for (let i = 0; i < 20 && webMod.getConnectedClientsCount() !== 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(webMod.getConnectedClientsCount(), 0);

  const reloadRes = await fetch(`http://127.0.0.1:${port}/internal/runtime/reload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "restart", reason: "dashboard-test" }),
  }).then((r) => r.json());

  assert.equal(reloadRes.success, true);
  assert.equal(reloadRes.acknowledged, true);
  assert.equal(reloadRes.action, "restart");
  assert.deepEqual(reloadRes.result, { reloaded: true });
  assert.equal(reloadEvents.length, 1);
  assert.equal(reloadEvents[0].action, "restart");
  assert.equal(reloadEvents[0].reason, "dashboard-test");

  const persistedReload = JSON.parse(await fs.readFile(path.join(root, "mybot", "state", "reload", "admin.json"), "utf8"));
  assert.equal(persistedReload.action, "restart");
  const persistedBotAction = (await fs.readFile(path.join(root, ".bot-action"), "utf8")).trim();
  assert.equal(persistedBotAction, "restart");
});
