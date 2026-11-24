import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplate } from "../src/dashboard/command-response-template.js";

test("replaces known variables", () => {
  const out = renderTemplate("Hey {user}, lệnh {prefix}{command} còn {remaining}s!", {
    prefix: "!", command: "help", user: "Nam", remaining: 42,
  });
  assert.equal(out, "Hey Nam, lệnh !help còn 42s!");
});

test("renders param values via {param:key}", () => {
  const out = renderTemplate("Giới hạn hiện tại: {param:limit}", {
    params: { limit: 10 },
  });
  assert.equal(out, "Giới hạn hiện tại: 10");
});

test("unknown variables are preserved verbatim", () => {
  assert.equal(renderTemplate("{khongton tai} {reason}", { reason: "x" }), "{khongton tai} x");
});

test("missing known variables become empty string", () => {
  assert.equal(renderTemplate("a{user}b", {}), "ab");
});

test("empty or non-string template yields null so caller falls back", () => {
  assert.equal(renderTemplate("", {}), null);
  assert.equal(renderTemplate(null, {}), null);
  assert.equal(renderTemplate(123, {}), null);
});

test("non-string values are coerced to string", () => {
  assert.equal(renderTemplate("{remaining}s", { remaining: 5 }), "5s");
  assert.equal(renderTemplate("{param:flag}", { params: { flag: true } }), "true");
});
