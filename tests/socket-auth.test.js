import test from "node:test";
import assert from "node:assert/strict";
import { socketAuthMiddleware } from "../src/web-service/auth-guard.js";

test("socketAuthMiddleware rejects client claiming isAdmin without valid server token", () => {
  process.env.BOT_WEB_AUTH_TOKEN = "server-super-secret";

  let nextError = null;
  const mockSocket = {
    handshake: {
      address: "192.168.1.50",
      auth: {
        isAdmin: true, // Client trying to self-assert admin
        role: "admin",
      },
    },
    data: {},
  };

  socketAuthMiddleware(mockSocket, (err) => {
    nextError = err;
  });

  assert.ok(nextError, "Must reject self-asserted admin without token");
  assert.equal(mockSocket.data.isAdmin, undefined);
});

test("socketAuthMiddleware grants admin when valid token is provided", () => {
  process.env.BOT_WEB_AUTH_TOKEN = "server-super-secret";

  let nextError = null;
  const mockSocket = {
    handshake: {
      address: "192.168.1.50",
      auth: {
        token: "server-super-secret",
      },
    },
    data: {},
  };

  socketAuthMiddleware(mockSocket, (err) => {
    nextError = err;
  });

  assert.equal(nextError, undefined);
  assert.equal(mockSocket.data.authenticated, true);
  assert.equal(mockSocket.data.isAdmin, true);
});
