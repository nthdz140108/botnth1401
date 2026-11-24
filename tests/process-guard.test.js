import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { isPortAvailable } from "../src/dashboard/process-guard.js";

test("process guard detects an occupied port", async () => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  assert.equal(await isPortAvailable(port, "127.0.0.1"), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortAvailable(port, "127.0.0.1"), true);
});
