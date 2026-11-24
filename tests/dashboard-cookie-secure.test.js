import test from "node:test";
import assert from "node:assert/strict";

process.env.DASHBOARD_TEST_MODE = "1";
process.env.DASHBOARD_ADMIN_USERNAME = "cookie-test-admin";
process.env.DASHBOARD_ADMIN_PASSWORD = "cookie-test-secret";
delete process.env.DASHBOARD_COOKIE_SECURE;

async function loginAndGetCookies({ forwardedProto, secureEnv } = {}) {
  try {
    const module = await import(`../dashboard/server.js?cookie-test=${Date.now()}-${Math.random()}`);
    if (secureEnv === undefined) delete process.env.DASHBOARD_COOKIE_SECURE;
    else process.env.DASHBOARD_COOKIE_SECURE = secureEnv;
    const server = module.createDashboardServer();
    const port = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
        },
        body: JSON.stringify({ username: "cookie-test-admin", password: "cookie-test-secret" }),
      });
      assert.equal(response.status, 200);
      return response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get("set-cookie")];
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.DASHBOARD_COOKIE_SECURE;
  }
}

test("plain HTTP login omits Secure even in production mode", async () => {
  process.env.NODE_ENV = "production";
  try {
    const cookies = await loginAndGetCookies({});
    const session = cookies.find((c) => c.startsWith("mybot_session="));
    assert.ok(session);
    assert.doesNotMatch(session, /;\s*Secure/i);
  } finally {
    delete process.env.NODE_ENV;
  }
});

test("login through HTTPS proxy (x-forwarded-proto) sets Secure", async () => {
  process.env.NODE_ENV = "production";
  try {
    const cookies = await loginAndGetCookies({ forwardedProto: "https" });
    const session = cookies.find((c) => c.startsWith("mybot_session="));
    assert.ok(session);
    assert.match(session, /;\s*Secure/i);
  } finally {
    delete process.env.NODE_ENV;
  }
});

test("DASHBOARD_COOKIE_SECURE=0 forces Secure off, =1 forces on", async () => {
  const forcedOff = await loginAndGetCookies({ forwardedProto: "https", secureEnv: "0" });
  assert.doesNotMatch(forcedOff.find((c) => c.startsWith("mybot_session=")), /;\s*Secure/i);

  const forcedOn = await loginAndGetCookies({ secureEnv: "1" });
  assert.match(forcedOn.find((c) => c.startsWith("mybot_session=")), /;\s*Secure/i);
});
