import test from "node:test";
import assert from "node:assert/strict";
import { apiRequest, redactSecrets } from "../../dashboard/src/api/client.js";

test("adds request IDs and redacts secret fields", async () => {
  let seen;
  const result = await apiRequest("/api/example", { fetch: async (_url, options) => {
    seen = options;
    return new Response(JSON.stringify({ data: { name: "bot", token: "hidden", nested: { password: "hidden" } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  } });
  assert.match(seen.headers.get("X-Request-ID"), /^req_|^[0-9a-f-]{36}$/i);
  assert.deepEqual(result, { success: true, data: { name: "bot", token: "[REDACTED]", nested: { password: "[REDACTED]" } }, requestId: seen.headers.get("X-Request-ID") });
});

test("normalizes non-2xx API errors while retaining request ID", async () => {
  await assert.rejects(() => apiRequest("/api/example", { fetch: async () => new Response(JSON.stringify({ error: "No access" }), { status: 403, statusText: "Forbidden" }) }), (error) => {
    assert.equal(error.success, false);
    assert.equal(error.error, "No access");
    assert.equal(error.status, 403);
    assert.ok(error.requestId);
    return true;
  });
});

test("redacts recursively without mutating input", () => {
  const value = { cookie: "secret", list: [{ apiKey: "x" }], safe: "ok" };
  assert.deepEqual(redactSecrets(value), { cookie: "[REDACTED]", list: [{ apiKey: "[REDACTED]" }], safe: "ok" });
  assert.equal(value.cookie, "secret");
});
