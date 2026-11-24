import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { io } from "socket.io-client";

function mergeCookies(setCookieHeader) {
  if (!setCookieHeader) return "";
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return values
    .flatMap((value) => String(value).split(/,(?=\s*[^=;,]+=[^;]+)/))
    .map((value) => value.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function makeFixtureRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-auth-"));
  await fs.mkdir(path.join(root, "mybot", "bots"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "instances", "child", "data"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });

  await fs.writeFile(path.join(root, "mybot", "mybots.json"), JSON.stringify({
    child: { name: "child", displayName: "Child", status: "running", webPort: 31337 },
  }));
  await fs.writeFile(path.join(root, "mybot", "bots", "child.json"), JSON.stringify({
    name: "child",
    displayName: "Child",
    webPort: 31337,
    commandFilePath: "mybot/instances/child/data/command.json",
    configFilePath: "mybot/bots/child-credential.json",
  }));
  await fs.writeFile(path.join(root, "mybot", "bots", "child-credential.json"), JSON.stringify({}));
  await fs.writeFile(path.join(root, "mybot", "instances", "child", "data", "command.json"), JSON.stringify({
    prefix: "!",
    commands: [{ name: "ping" }],
  }));

  return root;
}

async function startDashboardServer(root) {
  const previous = {
    cwd: process.cwd(),
    DASHBOARD_TEST_MODE: process.env.DASHBOARD_TEST_MODE,
    DASHBOARD_AUTH_SECRET: process.env.DASHBOARD_AUTH_SECRET,
    DASHBOARD_ADMIN_USERNAME: process.env.DASHBOARD_ADMIN_USERNAME,
    DASHBOARD_ADMIN_PASSWORD: process.env.DASHBOARD_ADMIN_PASSWORD,
    DASHBOARD_COOKIE_SECURE: process.env.DASHBOARD_COOKIE_SECURE,
    DASHBOARD_COOKIE_SAMESITE: process.env.DASHBOARD_COOKIE_SAMESITE,
    DASHBOARD_ORIGIN: process.env.DASHBOARD_ORIGIN,
    DASHBOARD_LOGIN_RATE_LIMIT_MAX: process.env.DASHBOARD_LOGIN_RATE_LIMIT_MAX,
    DASHBOARD_LOGIN_RATE_LIMIT_WINDOW_MS: process.env.DASHBOARD_LOGIN_RATE_LIMIT_WINDOW_MS,
    PROJECT_ROOT: process.env.PROJECT_ROOT,
  };

  process.chdir(root);
  process.env.DASHBOARD_TEST_MODE = "1";
  process.env.DASHBOARD_AUTH_SECRET = "correct horse battery staple";
  process.env.DASHBOARD_ADMIN_USERNAME = "nthdz";
  process.env.DASHBOARD_ADMIN_PASSWORD = "correct horse battery staple";
  process.env.DASHBOARD_COOKIE_SECURE = "1";
  process.env.DASHBOARD_COOKIE_SAMESITE = "Strict";
  process.env.DASHBOARD_ORIGIN = "http://allowed.test";
  process.env.DASHBOARD_LOGIN_RATE_LIMIT_MAX = "2";
  process.env.DASHBOARD_LOGIN_RATE_LIMIT_WINDOW_MS = "60000";
  process.env.PROJECT_ROOT = root;

  const module = await import(`../dashboard/server.js?test=${Date.now()}`);
  const server = module.createDashboardServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    server,
    module,
    restore: async () => {
      await new Promise((resolve) => server.close(resolve));
      process.chdir(previous.cwd);
      for (const [key, value] of Object.entries(previous)) {
        if (key === "cwd") continue;
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function login(baseUrl, password, username = "nthdz") {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie");
  return {
    response,
    body,
    cookieHeader: mergeCookies(setCookie),
    setCookie,
  };
}

function connectSocket(baseUrl, { cookieHeader, csrfToken, origin }) {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      auth: csrfToken ? { csrfToken } : undefined,
      transportOptions: {
        websocket: {
          extraHeaders: {
            Cookie: cookieHeader,
            Origin: origin,
          },
        },
      },
    });

    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.close();
      reject(error);
    });
  });
}

test("dashboard auth/login/session, csrf, socket handshake, and rate limit contracts", async () => {
  const root = await makeFixtureRoot();
  const { baseUrl, server, restore } = await startDashboardServer(root);
  const origin = "http://allowed.test";

  try {
    const unauthenticatedSession = await fetch(`${baseUrl}/api/auth/session`).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(unauthenticatedSession.status, 401);
    assert.equal(unauthenticatedSession.body.authenticated, false);
    assert.equal(unauthenticatedSession.body.username, null);

    const unauthorizedMutation = await fetch(`${baseUrl}/api/bots/child/prefix`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "#" }),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(unauthorizedMutation.status, 401);
    assert.equal(unauthorizedMutation.body.error, "AUTH_REQUIRED");

    const invalidLogin = await login(baseUrl, "wrong-password");
    assert.equal(invalidLogin.response.status, 401);
    assert.equal(invalidLogin.body.error, "INVALID_CREDENTIALS");

    const successfulLogin = await login(baseUrl, "correct horse battery staple");
    assert.equal(successfulLogin.response.status, 200);
    assert.equal(successfulLogin.body.authenticated, true);
    assert.equal(successfulLogin.body.username, "nthdz");
    assert.equal(typeof successfulLogin.body.csrfToken, "string");
    const sessionCookieHeader = successfulLogin.cookieHeader
      .split("; ")
      .find((entry) => entry.startsWith("mybot_session="));
    assert.match(successfulLogin.cookieHeader, /mybot_session=/);
    assert.match(successfulLogin.cookieHeader, /mybot_csrf=/);
    assert.match(String(successfulLogin.setCookie), /HttpOnly/i);
    assert.match(String(successfulLogin.setCookie), /Secure/i);
    assert.match(String(successfulLogin.setCookie), /SameSite=Strict/i);

    const authenticatedSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: successfulLogin.cookieHeader },
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(authenticatedSession.status, 200);
    assert.equal(authenticatedSession.body.authenticated, true);
    assert.equal(authenticatedSession.body.username, "nthdz");
    assert.equal(authenticatedSession.body.csrfToken, successfulLogin.body.csrfToken);

    const handshake = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`, {
      headers: { Origin: origin },
    });
    assert.notEqual(handshake.headers.get("access-control-allow-origin"), "*");
    assert.equal(handshake.headers.get("access-control-allow-origin"), origin);

    const csrfMissing = await fetch(`${baseUrl}/api/bots/child/prefix`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: successfulLogin.cookieHeader,
      },
      body: JSON.stringify({ prefix: "#" }),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(csrfMissing.status, 403);
    assert.equal(csrfMissing.body.error, "CSRF_REQUIRED");

    const csrfWrongLength = await fetch(`${baseUrl}/api/bots/child/prefix`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: successfulLogin.cookieHeader,
        "X-CSRF-Token": "short",
      },
      body: JSON.stringify({ prefix: "#" }),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(csrfWrongLength.status, 403);
    assert.equal(csrfWrongLength.body.error, "CSRF_REQUIRED");

    const csrfOk = await fetch(`${baseUrl}/api/bots/child/prefix`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: successfulLogin.cookieHeader,
        "X-CSRF-Token": successfulLogin.body.csrfToken,
      },
      body: JSON.stringify({ prefix: "#" }),
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(csrfOk.status, 200);
    assert.equal(csrfOk.body.success, true);
    assert.equal(csrfOk.body.data.prefix, "#");

    await assert.rejects(
      connectSocket(baseUrl, {
        cookieHeader: sessionCookieHeader,
        origin,
      }),
      (error) => error.message === "CSRF_REQUIRED",
    );

    const socket = await connectSocket(baseUrl, {
      cookieHeader: successfulLogin.cookieHeader,
      csrfToken: successfulLogin.body.csrfToken,
      origin,
    });
    assert.equal(socket.connected, true);
    socket.disconnect();

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: successfulLogin.cookieHeader },
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
      setCookie: response.headers.get("set-cookie"),
    }));
    assert.equal(logout.status, 200);
    assert.equal(logout.body.success, true);
    assert.match(String(logout.setCookie), /Max-Age=0/i);

    const afterLogoutSession = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { Cookie: successfulLogin.cookieHeader },
    }).then(async (response) => ({
      status: response.status,
      body: await response.json(),
    }));
    assert.equal(afterLogoutSession.status, 401);
    assert.equal(afterLogoutSession.body.authenticated, false);

    const secondInvalid = await login(baseUrl, "still-wrong");
    assert.equal(secondInvalid.response.status, 401);

    const rateLimited = await login(baseUrl, "also-wrong");
    assert.equal(rateLimited.response.status, 429);
    assert.equal(rateLimited.body.error, "LOGIN_RATE_LIMITED");
  } finally {
    await restore();
  }
});
