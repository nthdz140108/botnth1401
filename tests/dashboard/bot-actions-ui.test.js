import test from "node:test";
import assert from "node:assert/strict";
import { createBotActions } from "../../dashboard/src/app/bot-actions.js";

test("UI action helper confirms delete, sends botIds, refreshes, and navigates", async () => {
  const calls = [];
  const navigations = [];
  let refreshed = 0;
  const actions = createBotActions({
    request: async (url, options) => { calls.push({ url, options }); return { data: { results: [{ botId: "child", success: true }] } }; },
    refresh: async () => { refreshed += 1; },
    navigate: (route) => navigations.push(route),
    confirmDelete: async () => "DELETE_SELECTED_BOTS",
  });
  const result = await actions.bulk("delete", ["child", "child"], { reason: "maintenance" });
  assert.deepEqual(calls[0].options.body, { action: "delete", botIds: ["child"], reason: "maintenance", confirm: "DELETE_SELECTED_BOTS" });
  assert.deepEqual(result.successfulIds, ["child"]);
  assert.deepEqual(result.failedIds, []);
  assert.equal(refreshed, 1);
  assert.deepEqual(navigations, ["overview"]);
});

test("UI action helper keeps failed IDs and rejects a weak delete confirmation", async () => {
  const actions = createBotActions({ request: async () => ({ data: { results: [{ botId: "child", success: false }] } }), confirmDelete: async () => "DELETE" });
  await assert.rejects(() => actions.bulk("delete", ["child"]), { code: "DELETE_CONFIRMATION_REQUIRED" });
  const result = await createBotActions({ request: async () => ({ data: { results: [{ botId: "child", success: false }, { botId: "ok", success: true }] } }), confirmDelete: async () => "DELETE_SELECTED_BOTS" }).bulk("stop", ["child", "ok"]);
  assert.deepEqual(result.failedIds, ["child"]);
  assert.deepEqual(result.successfulIds, ["ok"]);
});
