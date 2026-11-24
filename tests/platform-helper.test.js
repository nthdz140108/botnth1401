import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { openPathInDefaultApp } from "../src/platform/index.js";

test("openPathInDefaultApp uses the platform-appropriate launcher", () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { unref() {} };
  };

  assert.equal(openPathInDefaultApp("C:/tmp/qr.png", { platform: "win32", spawnImpl }), true);
  assert.equal(openPathInDefaultApp("/tmp/qr.png", { platform: "darwin", spawnImpl }), true);
  assert.equal(openPathInDefaultApp("/tmp/qr.png", { platform: "linux", spawnImpl }), true);

  assert.deepEqual(calls[0].command, "cmd");
  assert.deepEqual(calls[0].args, ["/c", "start", "", path.resolve("C:/tmp/qr.png")]);
  assert.deepEqual(calls[1].command, "open");
  assert.deepEqual(calls[1].args, [path.resolve("/tmp/qr.png")]);
  assert.deepEqual(calls[2].command, "xdg-open");
  assert.deepEqual(calls[2].args, [path.resolve("/tmp/qr.png")]);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[1].options.detached, true);
  assert.equal(calls[2].options.stdio, "ignore");
});
