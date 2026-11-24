import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import portfinder from "portfinder";
import { io } from "socket.io-client";

async function withTempDashboardRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mybot-dashboard-"));
  const previousCwd = process.cwd();
  process.chdir(root);
  try {
    await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
    await fs.mkdir(path.join(root, "mybot", "json-data"), { recursive: true });
    await fs.mkdir(path.join(root, "logs", "admin"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "fonts"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "resources", "game", "keobuabao"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "resources", "audio", ".converted"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "temp"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "data"), { recursive: true });
    await fs.mkdir(path.join(root, "assets", "resources", "gif"), { recursive: true });
    await fs.mkdir(path.join(root, "logs"), { recursive: true });
    const systemFont = "C:\\Windows\\Fonts\\arial.ttf";
    await fs.copyFile(systemFont, path.join(root, "assets", "fonts", "SVN-Transformer.ttf"));
    await fs.copyFile(systemFont, path.join(root, "assets", "fonts", "BeVietnamPro-Bold.ttf"));

    await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
      child: { name: "child", displayName: "Child", status: "running", webPort: 31337 },
    }));
    const adminConfigPath = path.join(root, "mybot", "bots", "admin.json");
    const childConfigPath = path.join(root, "mybot", "bots", "child.json");
    const port = await portfinder.getPortPromise({ port: 35000, stopPort: 45000 });

    await fs.writeFile(adminConfigPath, JSON.stringify({
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
    }));
    await fs.writeFile(childConfigPath, JSON.stringify({
      name: "child",
      configFilePath: "mybot/bots/child-credential.json",
      WEB_CONFIG_PATH: "mybot/web-config-child.json",
    }));
    await fs.writeFile(path.join(root, "mybot", "bots", "admin-credential.json"), JSON.stringify({ cookie: { token: "secret" } }));
    await fs.writeFile(path.join(root, "mybot", "bots", "child-credential.json"), JSON.stringify({ cookie: {} }));
    await fs.writeFile(path.join(root, "mybot", "web-config.json"), JSON.stringify({ selectedGroups: {}, selectedFriends: {} }));
    await fs.writeFile(path.join(root, "mybot", "web-config-child.json"), JSON.stringify({ prefix: "!" }));
    await fs.writeFile(path.join(root, "mybot", "manager.json"), JSON.stringify({ onBotPrivate: true }));
    await fs.writeFile(path.join(root, "assets", "data", "list_admin.json"), JSON.stringify(["admin"]));
    await fs.writeFile(path.join(root, "assets", "data", "prophylactic.json"), JSON.stringify({
      prophylacticUploadAttachment: { enable: false, lastBlocked: "", numRequestZalo: 0 },
    }));
    await fs.writeFile(path.join(root, "assets", "json-data", "data-game.json"), JSON.stringify({}));
    await fs.writeFile(path.join(root, "groupSettings.json"), JSON.stringify({ "group-1": { antiSpam: true } }));
    await fs.writeFile(path.join(root, "assets", "json-data", "command.json"), JSON.stringify({ prefix: "!", commands: [{ name: "ping" }] }));
    await fs.writeFile(path.join(root, "logs", "admin", "bot.log"), "info ready\nERROR port conflict\n");

    process.env.SKIP_ENV_VALIDATION = "1";
    process.env.name = "admin";
    process.env.CONFIG_PATH = path.join(root, "mybot", "bots", "admin.json");
    process.env.ProjectRoot = root;
    await fn({ root, port });
  } finally {
    process.chdir(previousCwd);
  }
}

test("runtime web bridge exposes the live route contract", async () => {
  await withTempDashboardRoot(async ({ port }) => {
    const module = await import(`../../src/web-service/web-server.js?test=${Date.now()}`);
    const api = {
      getAllFriends: async () => ([{ userId: "friend-1", name: "Friend 1" }]),
      sendMessage: async () => true,
    };
    await module.startWebServer(api);

    const base = `http://127.0.0.1:${port}`;
    try {
      const identity = await fetch(`${base}/internal/runtime/identity`).then((res) => res.json());
      assert.equal(identity.success, true);
      assert.equal(identity.botKey, "admin");

      const health = await fetch(`${base}/internal/runtime/health`).then((res) => res.json());
      assert.equal(health.status, "healthy");
      assert.equal(health.botKey, "admin");

      const reload = await fetch(`${base}/internal/runtime/reload`, { method: "POST" }).then((res) => res.json());
      assert.equal(reload.success, true);
      assert.equal(reload.acknowledged, true);

      const notFound = await fetch(`${base}/api/dashboard/overview`);
      assert.equal(notFound.status, 404);
    } finally {
      await module.closeWebServer();
    }
  });
});

test("dashboard socket connect and disconnect stay out of terminal stdout", async () => {
  await withTempDashboardRoot(async ({ port }) => {
    const module = await import(`../../src/web-service/web-server.js?stdout=${Date.now()}`);
    const api = {
      getAllFriends: async () => ([]),
      sendMessage: async () => true,
    };
    const logs = [];
    const originalLog = console.log;
    console.log = (...args) => {
      logs.push(args.map((value) => String(value)).join(" "));
    };
    await module.startWebServer(api);

    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });

    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      socket.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(logs.some((line) => line.includes("đã kết nối tới web socket")), false);
      assert.equal(logs.some((line) => line.includes("ngắt kết nối khỏi web socket")), false);
    } finally {
      console.log = originalLog;
      socket.disconnect();
      await module.closeWebServer();
    }
  });
});
