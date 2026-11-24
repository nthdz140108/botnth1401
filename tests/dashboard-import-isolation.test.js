import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("importing dashboard does not start a Zalo listener or mutate admin state", () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "dashboard-import-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./dashboard/server.js'); console.log('DASHBOARD_IMPORT_OK');"], {
      cwd: root,
      env: { ...process.env, DASHBOARD_TEST_MODE: "1", NODE_TEST_CONTEXT: "1", PROJECT_ROOT: projectRoot, DASHBOARD_PORT: "0" },
      encoding: "utf8",
      timeout: 10000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /DASHBOARD_IMPORT_OK/);
    assert.doesNotMatch(output, /BOT LISTENER/);
    assert.equal(existsSync(path.join(projectRoot, "mybot", "state", "admin.json")), false);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
