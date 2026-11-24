import test from "node:test";
import assert from "node:assert/strict";
import { apiRequest } from "../../dashboard/src/app/api.js";

test("serializes JSON bodies and reads JSON responses", async () => {
  let seen;
  const result = await apiRequest("/api/example", {
    method: "POST",
    body: { prefix: "!", nested: { enabled: true } },
    fetch: async (_url, options) => {
      seen = options;
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(seen.method, "POST");
  assert.equal(seen.headers.get("Content-Type"), "application/json");
  assert.equal(seen.body, JSON.stringify({ prefix: "!", nested: { enabled: true } }));
  assert.deepEqual(result, { success: true, data: { ok: true } });
});

test("reads text responses and exposes request metadata on failures", async () => {
  await assert.rejects(() => apiRequest("/api/example", {
    fetch: async () => new Response("denied", {
      status: 403,
      statusText: "Forbidden",
      headers: { "X-Request-ID": "req_123" },
    }),
  }), (error) => {
    assert.equal(error.message, "Forbidden");
    assert.equal(error.status, 403);
    assert.equal(error.requestId, "req_123");
    assert.equal(error.data, "denied");
    return true;
  });
});

test("redacts sensitive response data unless credential reveal explicitly opts in", async () => {
  const fetch = async () => new Response(JSON.stringify({ success: true, data: { raw: { cookie: { token: "secret" } } } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const masked = await apiRequest("/api/bots/child/credential/reveal", { fetch });
  assert.equal(masked.data.raw.cookie, "[REDACTED]");
  const revealed = await apiRequest("/api/bots/child/credential/reveal", { fetch, allowSensitive: true });
  assert.equal(revealed.data.raw.cookie.token, "secret");
  const nonReveal = await apiRequest("/api/example", { fetch, allowSensitive: true });
  assert.equal(nonReveal.data.raw.cookie, "[REDACTED]");
});
