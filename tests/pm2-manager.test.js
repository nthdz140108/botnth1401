import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkPM2Status } from "../src/commands/mybot/System/pm2-manager.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))));

test("pm2 manager spawns PM2 without a shell wrapper", () => {
  const source = readFileSync(path.join(projectRoot, "src", "commands", "mybot", "System", "pm2-manager.js"), "utf8");

  assert.doesNotMatch(source, /shell:\s*true/);
});

test("checkPM2Status treats an unavailable Windows PM2 command as not found", async () => {
  const result = await checkPM2Status("__qr_login_test_missing_pm2__");

  assert.equal(result.running, false);
  assert.ok(["not_found", "error"].includes(result.status));
});
