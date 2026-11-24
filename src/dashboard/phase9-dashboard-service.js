import fs from "node:fs/promises";
import path from "node:path";

import { VipFeatureFlagService } from "./vip-feature-flag-service.js";
import { ProviderConfigService } from "./provider-config-service.js";

const HIGH_RISK_KEYWORDS = ["spam", "ddos", "bulk", "regmail", "sms"];
export class Phase9DashboardService {
  constructor({
    root = process.cwd(),
    registry = null,
    vipRegistry = null,
    providerConfigService = null,
    featureFlagService = null,
    auditStore = null,
  } = {}) {
    this.root = path.resolve(root);
    this.registry = registry;
    this.vipRegistry = vipRegistry;
    this.providerConfigService = providerConfigService || new ProviderConfigService({ root: this.root });
    this.featureFlagService = featureFlagService || new VipFeatureFlagService({ root: this.root });
    this.auditStore = auditStore;
  }

  async getDashboardSnapshot() {
    const [catalog, flags, providerConfig, auditSummary, queue] = await Promise.all([
      this.getCommandCatalog(),
      this.getFeatureFlags(),
      this.getProviderStatus(),
      this.getAuditSummary(),
      this.getQueueSnapshot(),
    ]);
    return { catalog, flags, providerConfig, auditSummary, queue, generatedAt: new Date().toISOString() };
  }

  async getCommandCatalog() {
    const definitions = Array.from(this.vipRegistry?.definitions || []);
    const providerState = await this.providerConfigService.read();
    const enabledFlags = await this.featureFlagService.read();
    const flagMap = enabledFlags.flags || {};
    return {
      commands: definitions.map((definition) => toCatalogItem(definition, providerState, flagMap)),
      grouped: groupCommands(definitions),
    };
  }

  async getFeatureFlags() {
    return this.featureFlagService.read();
  }

  async updateFeatureFlags(patch) {
    const result = await this.featureFlagService.update(patch);
    await this.auditStore?.append?.({
      action: "vip.flags.update",
      changedKeys: result.changedKeys,
      backup: result.backup?.file || null,
    });
    return result;
  }

  async getProviderStatus() {
    const state = await this.providerConfigService.read();
    return {
      groups: state.groups || [],
      health: state.health || {},
      keys: state.keys || [],
    };
  }

  async refreshProviderKeys(values) {
    const result = await this.providerConfigService.update(values);
    await this.auditStore?.append?.({
      action: "provider-config.refresh",
      changedKeys: result.changedKeys,
      backup: result.backup?.file || null,
    });
    return redactProviderKeys(result);
  }

  async getQueueSnapshot() {
    const bots = await this.registry.list();
    const queues = {
      download: summarizeQueue("download", bots, (bot) => bot.status === "running" || bot.status === "starting"),
      highRisk: summarizeQueue("highRisk", bots, (bot) => bot.status === "running" && HIGH_RISK_KEYWORDS.some((word) => `${bot.name} ${bot.displayName}`.toLowerCase().includes(word))),
    };
    return { queues, totalQueued: Object.values(queues).reduce((sum, queue) => sum + queue.pending, 0), sampledAt: new Date().toISOString() };
  }

  async getAuditSummary({ limit = 100, query = "", action = "", exportFormat = "json" } = {}) {
    const entries = await this.auditStore?.list?.({ limit }) || [];
    const normalizedQuery = String(query || "").trim().toLowerCase();
    const normalizedAction = String(action || "").trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      const haystack = JSON.stringify(entry).toLowerCase();
      return (!normalizedQuery || haystack.includes(normalizedQuery)) && (!normalizedAction || String(entry.action || "").toLowerCase().includes(normalizedAction));
    });
    return {
      entries: filtered,
      total: filtered.length,
      exportFormat,
      export: exportFormat === "csv" ? exportAuditCsv(filtered) : JSON.stringify(filtered, null, 2),
      stale: false,
    };
  }

  async previewMigration(nextFlags) {
    const current = await this.featureFlagService.read();
    const next = nextFlags && typeof nextFlags === "object" && !Array.isArray(nextFlags) ? nextFlags : {};
    const merged = { ...current.flags, ...next };
    const changed = Object.keys(merged).filter((key) => current.flags[key] !== merged[key]);
    return {
      preview: changed.map((key) => ({ key, from: current.flags[key], to: merged[key] })),
      backupPath: path.join(this.root, "logs", "dashboard-backups"),
      changedKeys: changed,
    };
  }
}

function toCatalogItem(definition, providerState, flagMap) {
  const providerDependency = Array.isArray(definition.requiredConfig) ? definition.requiredConfig.join(", ") : "";
  const enabled = flagEnabled(definition, flagMap);
  return {
    name: definition.name,
    aliases: Array.from(definition.aliases || []),
    permission: definition.permission || "all",
    scope: definition.scope || "both",
    type: definition.type ?? 0,
    countdown: definition.countdown ?? 0,
    risk: definition.risk || "normal",
    riskLevel: definition.risk || "normal",
    active: definition.active !== false,
    enabled,
    disabled: !enabled,
    providerDependency,
    health: providerHealthFor(definition, providerState),
    requiredConfig: Array.isArray(definition.requiredConfig) ? definition.requiredConfig : [],
    requiredDependencies: Array.isArray(definition.requiredDependencies) ? definition.requiredDependencies : [],
    minArgs: definition.minArgs ?? 0,
  };
}

function providerHealthFor(definition, providerState) {
  const deps = Array.isArray(definition.requiredConfig) ? definition.requiredConfig : [];
  if (!deps.length) return "healthy";
  const allConfigured = deps.every((key) => providerState.keys?.some((item) => item.name === key && item.configured));
  return allConfigured ? "healthy" : "missing";
}

function flagEnabled(definition, flags) {
  const group = definition.risk === "critical" || definition.risk === "high" ? "vip.highRisk" : definition.requiredConfig?.length ? "vip.ai" : "vip.utility";
  if (Object.prototype.hasOwnProperty.call(flags, group)) return Boolean(flags[group]);
  return true;
}

function groupCommands(definitions) {
  const grouped = new Map();
  for (const definition of definitions) {
    const section = definition.risk === "critical" || definition.risk === "high" ? "highRisk" : definition.requiredConfig?.length ? "provider" : "utility";
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(definition.name);
  }
  return Object.fromEntries(grouped.entries());
}

function summarizeQueue(name, bots, predicate) {
  const matched = bots.filter(predicate);
  return {
    name,
    pending: Math.max(0, matched.length),
    running: matched.filter((bot) => bot.status === "running").length,
    idle: bots.length - matched.length,
    sample: matched.slice(0, 5).map((bot) => bot.id),
  };
}

function exportAuditCsv(entries) {
  const header = ["timestamp", "action", "botId", "commandName", "target", "requestId"];
  const rows = [header.join(",")];
  for (const entry of entries) {
    rows.push(header.map((key) => csvValue(entry[key] ?? "")).join(","));
  }
  return rows.join("\n");
}

function csvValue(value) {
  const text = String(value ?? "");
  return /[,"\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

function redactProviderKeys(result) {
  return {
    ...result,
    keys: Array.isArray(result.keys) ? result.keys.map(({ name, configured, masked }) => ({ name, configured, masked })) : [],
    groups: Array.isArray(result.groups) ? result.groups.map((group) => ({
      ...group,
      configuredKeys: Array.isArray(group.configuredKeys) ? group.configuredKeys.map((item) => ({ name: item.name, masked: item.masked })) : [],
    })) : [],
  };
}
