import test from "node:test";
import assert from "node:assert/strict";

import { Phase9DashboardService } from "../src/dashboard/phase9-dashboard-service.js";

function createService(overrides = {}) {
  const auditEntries = [];
  const service = new Phase9DashboardService({
    root: overrides.root || process.cwd(),
    registry: overrides.registry || {
      list: async () => [
        { id: "admin", name: "admin", displayName: "Admin", status: "running" },
        { id: "bot-1", name: "sub-bot", displayName: "Sub Bot", status: "running" },
      ],
      definitions: [],
    },
    vipRegistry: overrides.vipRegistry || {
      definitions: [
        { name: "kick", aliases: ["sut"], permission: "adminBot", scope: "group", type: 3, countdown: 1, risk: "high" },
        { name: "downloadresource", aliases: [], permission: "adminBot", scope: "both", type: 3, countdown: 5, requiredConfig: ["HOANGDEV_API_KEY"] },
      ],
    },
    providerConfigService: overrides.providerConfigService || {
      read: async () => ({
        keys: [
          { name: "HOANGDEV_API_KEY", configured: true, masked: "********" },
        ],
        groups: [{ id: "utility", status: "healthy" }],
        health: { utility: { status: "healthy" } },
      }),
      update: async (values) => ({
        keys: Object.keys(values).map((name) => ({ name, configured: true, masked: "********" })),
        groups: [],
        health: {},
        changedKeys: Object.keys(values),
        backup: { file: "/tmp/provider.bak" },
      }),
    },
    featureFlagService: overrides.featureFlagService || {
      read: async () => ({ flags: { "vip.media": true, "vip.ai": true, "vip.group": true, "vip.utility": true, "vip.highRisk": true } }),
      update: async (patch) => ({ flags: patch, changedKeys: Object.keys(patch), backup: { file: "/tmp/flags.bak" } }),
    },
    auditStore: overrides.auditStore || {
      append: async (entry) => { auditEntries.push(entry); return entry; },
      list: async () => [
        { timestamp: "2026-08-16T00:00:00.000Z", action: "provider-config.update", requestId: "req-1" },
        { timestamp: "2026-08-16T00:01:00.000Z", action: "vip.flags.update", requestId: "req-2" },
      ],
    },
  });
  return { service, auditEntries };
}

test("phase 9 catalog exposes status and provider dependencies", async () => {
  const { service } = createService();
  const catalog = await service.getCommandCatalog();
  assert.equal(catalog.commands.length, 2);
  assert.equal(catalog.commands[1].enabled, true);
  assert.equal(catalog.commands[1].providerDependency, "HOANGDEV_API_KEY");
  assert.equal(catalog.commands[0].riskLevel, "high");
});

test("phase 9 feature flag updates append audit entries", async () => {
  const { service, auditEntries } = createService();
  const result = await service.updateFeatureFlags({ "vip.highRisk": true });
  assert.equal(result.flags["vip.highRisk"], true);
  assert.equal(auditEntries.at(-1).action, "vip.flags.update");
});

test("phase 9 migration preview and audit export are normalized", async () => {
  const { service } = createService();
  const preview = await service.previewMigration({ "vip.highRisk": false });
  assert.deepEqual(preview.changedKeys, ["vip.highRisk"]);
  const audit = await service.getAuditSummary({ exportFormat: "csv" });
  assert.match(audit.export, /provider-config\.update/);
  assert.match(audit.export, /vip\.flags\.update/);
});
