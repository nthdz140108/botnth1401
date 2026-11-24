import test from "node:test";
import assert from "node:assert/strict";
import { validateAuthToken, createAuthGuardMiddleware } from "../src/web-service/auth-guard.js";

test("validateAuthToken checks expected token and bearer format", () => {
  process.env.BOT_WEB_AUTH_TOKEN = "secret-token-xyz";

  assert.equal(validateAuthToken("secret-token-xyz"), true);
  assert.equal(validateAuthToken("Bearer secret-token-xyz"), true);
  assert.equal(validateAuthToken("wrong-token"), false);
  assert.equal(validateAuthToken(""), false);
  assert.equal(validateAuthToken(null), false);
});

test("authGuardMiddleware blocks missing or invalid tokens with 401/403", () => {
  process.env.BOT_WEB_AUTH_TOKEN = "valid-token-123";
  const guard = createAuthGuardMiddleware();

  // Missing token
  let status = null;
  let json = null;
  const mockRes = {
    status(s) {
      status = s;
      return this;
    },
    json(j) {
      json = j;
    },
  };

  guard({ headers: {}, ip: "192.168.1.100", method: "POST" }, mockRes, () => {
    assert.fail("Should not call next on missing token");
  });
  assert.equal(status, 401);

  // Invalid token
  status = null;
  guard({ headers: { authorization: "Bearer wrong-token" }, ip: "192.168.1.100", method: "POST" }, mockRes, () => {
    assert.fail("Should not call next on invalid token");
  });
  assert.equal(status, 403);

  // Valid token
  let nextCalled = false;
  guard({ headers: { authorization: "Bearer valid-token-123" }, ip: "192.168.1.100", method: "POST" }, mockRes, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});
