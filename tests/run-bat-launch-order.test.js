import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runBat = readFileSync(new URL("../run.bat", import.meta.url), "utf8");
const executableBat = runBat.split(/\r?\n/).filter((line) => !/^\s*rem\b/i.test(line)).join("\n");

test("run.bat must NOT open separate CMD windows for bot or dashboard", () => {
  // PM2 contract: exactly one terminal (this window) runs the monitor.
  assert.equal(executableBat.indexOf('start "MyBot Bot"'), -1, "run.bat must not open 'MyBot Bot' CMD window");
  assert.equal(executableBat.indexOf('start "MyBot Dashboard"'), -1, "run.bat must not open 'MyBot Dashboard' CMD window");
  assert.doesNotMatch(executableBat, /cmd\.exe\s+\/d\s+\/k/, "run.bat must not spawn any interactive CMD windows");
});

test("run.bat must not use bot.js as the fleet owner", () => {
  // bot.js must not be the fleet owner; reconcile-and-monitor.js owns the fleet
  assert.doesNotMatch(executableBat, /bot\.js/, "run.bat must not invoke bot.js");
});

test("run.bat routes the fleet through reconcile-and-monitor", () => {
  assert.match(executableBat, /reconcile-and-monitor/);
  // Default path (no args) must run reconcile + monitor
  const defaultIndex = executableBat.indexOf('reconcile-and-monitor.js"');
  assert.notEqual(defaultIndex, -1, "run.bat must invoke reconcile-and-monitor.js as default entry");
});

test("run.bat supports monitor-only subcommand", () => {
  assert.match(executableBat, /--monitor-only/);
});

test("run.bat does not install PM2 at production startup", () => {
  // PM2 is a declared dependency; auto-install at startup is forbidden
  assert.doesNotMatch(executableBat, /npm-cli\.js/, "run.bat must not call npm-cli.js");
  assert.doesNotMatch(executableBat, /install pm2/i, "run.bat must not install pm2 at runtime");
  // Either the .bin shim or the package's own bin/pm2 is acceptable
  const hasBinCheck = /node_modules\\\.bin\\pm2\.cmd/.test(executableBat)
    || /node_modules\\pm2\\bin\\pm2/.test(executableBat);
  assert.ok(hasBinCheck, "run.bat must check local pm2 installation");
});

test("run.bat resolves Node.js before launching commands", () => {
  assert.match(executableBat, /where node/);
  assert.match(executableBat, /set "NODE_EXE=%%N"/);
  assert.match(executableBat, /if not defined NODE_EXE/);
});
