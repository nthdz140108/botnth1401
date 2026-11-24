import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { listenServer } from "../src/web-service/listen-server.js";

test("listenServer rejects EADDRINUSE instead of emitting an uncaught error", async () => {
  const occupiedServer = createServer();
  await listenServer(occupiedServer, 0, "127.0.0.1");
  const { port } = occupiedServer.address();
  const conflictingServer = createServer();

  await assert.rejects(
    listenServer(conflictingServer, port, "127.0.0.1"),
    (error) => error?.code === "EADDRINUSE",
  );

  await new Promise((resolve, reject) => {
    occupiedServer.close((error) => (error ? reject(error) : resolve()));
  });
});
