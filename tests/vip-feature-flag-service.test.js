import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VipFeatureFlagService } from "../src/dashboard/vip-feature-flag-service.js";

test("vip feature flags default to the phase 0 catalog and persist atomically", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vip-flags-"));
  const service = new VipFeatureFlagService({ root });

  const initial = await service.read();
  assert.equal(initial.flags["vip.highRisk"], true);
  assert.equal(initial.flags["vip.ai"], true);

  const updated = await service.update({ "vip.highRisk": false, "vip.media": false });
  assert.equal(updated.flags["vip.highRisk"], false);
  assert.equal(updated.flags["vip.media"], false);
  assert.equal(updated.changedKeys.includes("vip.highRisk"), true);
  assert.equal(updated.changedKeys.includes("vip.media"), true);

  const persisted = JSON.parse(await fs.readFile(path.join(root, "mybot", "configs", "vip-feature-flags.json"), "utf8"));
  assert.equal(persisted["vip.highRisk"], false);
  assert.equal(persisted["vip.media"], false);
});

test("vip feature flag service rejects invalid keys and non-boolean values", async () => {
  const service = new VipFeatureFlagService({ root: await fs.mkdtemp(path.join(os.tmpdir(), "vip-flags-")) });

  await assert.rejects(() => service.update({ "vip.unknown": true }), (error) => {
    assert.equal(error.code, "VIP_FEATURE_FLAG_INVALID");
    return true;
  });

  await assert.rejects(() => service.update({ "vip.media": "yes" }), (error) => {
    assert.equal(error.code, "VIP_FEATURE_FLAG_INVALID");
    return true;
  });
});
