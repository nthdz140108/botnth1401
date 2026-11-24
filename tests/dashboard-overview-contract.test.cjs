const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

process.env.DASHBOARD_TEST_MODE = "1";
process.env.DASHBOARD_ADMIN_USERNAME = "nthdz";
process.env.DASHBOARD_ADMIN_PASSWORD = "140108";
const serverUrl = pathToFileURL(path.join(__dirname, "../dashboard/server.js")).href;

function mergeCookies(setCookieHeader) {
  if (!setCookieHeader) return "";
  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return values
    .flatMap((value) => String(value).split(/,(?=\s*[^=;,]+=[^;]+)/))
    .map((value) => value.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function request(server, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    http.get({ host: "127.0.0.1", port: address.port, path: route, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, body: JSON.parse(body) }));
    }).on("error", reject);
  });
}

async function login(server) {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nthdz", password: "140108" }),
  });
  const body = await response.json();
  return { body, cookie: mergeCookies(response.headers.getSetCookie ? response.headers.getSetCookie() : response.headers.get("set-cookie")) };
}

function overview(range) {
  const size = range === "7d" ? 672 : 288;
  return { success: true, generatedAt: "2026-08-06T00:00:00.000Z", range, summary: {}, health: {}, series: Array.from({ length: size }, () => ({})), fleet: [], recentActivity: [], warnings: [] };
}

test("overview defaults to 24h and returns the full response contract", async (t) => {
  const { createDashboardServer } = await import(serverUrl);
  const httpServer = createDashboardServer({ observabilityService: { getOverview: async (range) => overview(range) } });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const session = await login(httpServer);

  const response = await request(httpServer, "/api/dashboard/overview", { Cookie: session.cookie });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(Object.keys(response.body).sort(), ["fleet", "generatedAt", "health", "range", "recentActivity", "series", "success", "summary", "warnings"].sort());
  assert.equal(response.body.range, "24h");
  assert.equal(response.body.series.length, 288);
});

test("overview accepts 7d and rejects an invalid range", async (t) => {
  const { createDashboardServer } = await import(serverUrl);
  const httpServer = createDashboardServer({ observabilityService: { getOverview: async (range) => overview(range) } });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => httpServer.close(resolve)));
  const session = await login(httpServer);
  const headers = { Cookie: session.cookie };
  const weekly = await request(httpServer, "/api/dashboard/overview?range=7d", headers);
  const invalid = await request(httpServer, "/api/dashboard/overview?range=month", headers);
  assert.equal(weekly.statusCode, 200);
  assert.equal(weekly.body.series.length, 672);
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.body, { success: false, code: "INVALID_RANGE" });
});
