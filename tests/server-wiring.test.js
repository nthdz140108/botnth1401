import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import * as url from "node:url";

const serverPath = path.join(process.cwd(), "dashboard", "server.js");
const source = fs.readFileSync(serverPath, "utf8");

test("express.json is registered exactly once via shared configure helper", () => {
  const jsonUses = source.match(/express\.json\(\)/g) || [];
  assert.equal(jsonUses.length, 1);
});

test("security headers are registered before auth middleware and api routes", () => {
  const headerPos = source.indexOf('res.setHeader("X-Frame-Options"');
  const authUse = source.indexOf('.use("/api", requireDashboardAuth)');
  assert.ok(headerPos >= 0, "security headers middleware must exist");
  assert.ok(authUse >= 0, "auth middleware must be mounted");
  assert.ok(headerPos < authUse, "headers must precede auth middleware");
});

test("gateway http proxy middleware is mounted", () => {
  assert.match(source, /app\.use\(gateway\.middleware\)/);
});

test("no hardcoded default credentials", () => {
  assert.doesNotMatch(source, /"nthdz"/);
  assert.doesNotMatch(source, /"140108"/);
  assert.match(source, /throw new Error\("DASHBOARD_ADMIN_USERNAME/);
});

test("missing admin credentials abort startup outside test mode", () => {
  const { pathToFileURL } = url;
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mybot-wiring-noenv-"));
  try {
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import ${JSON.stringify(pathToFileURL(serverPath).href)}`,
    ], {
      cwd: emptyRoot,
      encoding: "utf8",
      env: (() => {
        const env = { ...process.env, PROJECT_ROOT: emptyRoot };
        delete env.ProjectRoot;
        delete env.DASHBOARD_TEST_MODE;
        delete env.DASHBOARD_ADMIN_USERNAME;
        delete env.DASHBOARD_ADMIN_PASSWORD;
        return env;
      })(),
      timeout: 10000,
    });
    assert.notEqual(result.status, 0, "startup must fail without admin credentials");
    assert.match(String(result.stderr), /DASHBOARD_ADMIN_USERNAME/);
  } finally {
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("module app applies security headers even to 401 responses", async () => {
  const previousTestMode = process.env.DASHBOARD_TEST_MODE;
  process.env.DASHBOARD_TEST_MODE = "1";
  try {
    const module = await import(`../dashboard/server.js?wiring=${Date.now()}`);
    const server = module.app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/bots`);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("x-frame-options"), "DENY");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    if (previousTestMode === undefined) delete process.env.DASHBOARD_TEST_MODE;
    else process.env.DASHBOARD_TEST_MODE = previousTestMode;
  }
});
