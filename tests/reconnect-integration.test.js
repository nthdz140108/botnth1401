import test from "node:test";
import assert from "node:assert/strict";
import { createReconnectCoordinator } from "../src/core/reconnect-coordinator.js";

test("reconnect coordinator receives dynamic getApi and invokes onReconnect callback", async () => {
  let apiVersion = 1;
  const reconnectedApis = [];

  const coordinator = createReconnectCoordinator({
    backoffSchedule: [5, 10],
    jitterRatio: 0,
    getApi: () => ({ version: apiVersion }),
    onReconnect: async (api) => {
      reconnectedApis.push(api?.version);
    },
  });

  coordinator.schedule("initial_drop");
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(reconnectedApis.length, 1);
  assert.equal(reconnectedApis[0], 1);

  // Simulate credential reload updating the API instance
  apiVersion = 2;
  coordinator.schedule("credential_reload");
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(reconnectedApis.length, 2);
  assert.equal(reconnectedApis[1], 2);

  coordinator.dispose();
});
