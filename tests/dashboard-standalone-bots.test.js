import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardServerPath = path.join(__dirname, "..", "dashboard", "server.js");

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-bots-"));
  const previous = process.cwd();
  process.chdir(root);
  try {
    await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
    await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
    await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
      child: { displayName: "Child Bot", status: "running", webPort: 0 },
      stopped: { displayName: "Stopped Bot", status: "stopped", webPort: 39999 },
    }));
    await fs.writeFile(path.join(root, "mybot", "bots", "admin.json"), JSON.stringify({ name: "admin", webPort: 0 }));
    await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({ name: "child" }));
    await fs.writeFile(path.join(root, "mybot", "state", "child.json"), JSON.stringify({ pid: process.pid, startedAt: 1234 }));
    await fn(root);
  } finally {
    process.chdir(previous);
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function mergeCookies(setCookieHeader) {
  if (!setCookieHeader) return "";
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return values
    .flatMap((value) => String(value).split(/,(?=\s*[^=;,]+=[^;]+)/))
    .map((value) => value.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function login(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nthdz", password: "140108" }),
  });
  await response.json();
  return mergeCookies(response.headers.get("set-cookie"));
}

test("standalone dashboard lists configured bots with live process and port state", async () => {
  await withTempRoot(async (root) => {
    const botServer = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.resume();
    });
    const botPort = await listen(botServer);
    const mybotsPath = path.join(root, "mybot", "mybots.json");
    const adminPath = path.join(root, "mybot", "bots", "admin.json");
    const mybots = JSON.parse(await fs.readFile(mybotsPath, "utf8"));
    mybots.child.webPort = botPort;
    await fs.writeFile(mybotsPath, JSON.stringify(mybots));
    await fs.writeFile(adminPath, JSON.stringify({ name: "admin" }));

    process.env.DASHBOARD_TEST_MODE = "1";
    process.env.DASHBOARD_ADMIN_USERNAME = "nthdz";
    process.env.DASHBOARD_ADMIN_PASSWORD = "140108";
    const modulePath = pathToFileURL(dashboardServerPath).href;
    const { createDashboardServer } = await import(`${modulePath}?bots=${Date.now()}`);
    const dashboard = createDashboardServer();
    const dashboardPort = await listen(dashboard);
    const cookie = await login(dashboardPort);

    try {
      const overview = await fetch(`http://127.0.0.1:${dashboardPort}/api/dashboard/overview`, { headers: { Cookie: cookie } }).then((res) => res.json());
      assert.equal(overview.success, true);
      assert.equal(overview.data.total, 3);
      assert.equal(overview.data.counts.running, 1);
      assert.equal(overview.data.bots.find((bot) => bot.id === "child").connected, true);

      const bots = await fetch(`http://127.0.0.1:${dashboardPort}/api/bots`, { headers: { Cookie: cookie } }).then((res) => res.json());
      assert.equal(bots.success, true);
      assert.equal(bots.data.bots.length, 3);
      assert.equal(bots.data.bots.find((bot) => bot.id === "child").processAlive, true);

      const child = await fetch(`http://127.0.0.1:${dashboardPort}/api/bots/child`, { headers: { Cookie: cookie } }).then((res) => res.json());
      assert.equal(child.success, true);
      assert.equal(child.data.id, "child");
      assert.equal(child.data.connected, true);
      assert.equal(child.data.port, botPort);
    } finally {
      await close(dashboard);
      await close(botServer);
      delete process.env.DASHBOARD_TEST_MODE;
    }
  });
});
