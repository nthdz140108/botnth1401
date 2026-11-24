import { validateStudioContract } from "./contract-v2.js";
import { mergeCommandLayers, getPath } from "./config-resolver.js";
import {
  SENDTASK_GIRL_CATEGORIES,
  SENDTASK_SOURCE_KINDS,
  SENDTASK_FALLBACK_KINDS,
} from "./sendtask-defaults.js";

export function createDefaultConfigAdapter() {
  return {
    id: "default-config",
    validate({ contract, values }) {
      const contractCheck = validateStudioContract(contract);
      if (!contractCheck.ok) return { ok: false, errors: contractCheck.errors };
      return { ok: true, errors: [] };
    },
    async preview({ contract, values }) {
      return { adapter: this.id, commandName: contract.commandName, changes: summarizeChanges(values), dryRun: true };
    },
    async apply(context) {
      return { applied: true, adapter: this.id, ...summarizeChanges(context.values) };
    },
    async rollback() {
      return { rolledBack: true, adapter: this.id };
    },
  };
}

function summarizeChanges(values = {}) {
  return Object.keys(values).sort();
}

export function crossFieldValidateSendtask(values) {
  const errors = [];
  const schedules = values["schedules.items"];
  if (!Array.isArray(schedules)) {
    errors.push({ path: "schedules.items", message: "Must be an array of schedule records" });
    return { ok: false, errors };
  }
  if (schedules.length !== 24) {
    errors.push({ path: "schedules.items", message: `sendtask requires exactly 24 hourly schedules, got ${schedules.length}` });
  }
  const seenCron = new Map();
  schedules.forEach((row, index) => {
    const path = `schedules.items[${index}]`;
    if (!row || typeof row !== "object") {
      errors.push({ path, message: "Schedule row must be an object" });
      return;
    }
    if (!/^hour-\d{2}$/.test(String(row.id || ""))) errors.push({ path: `${path}.id`, message: "id must match hour-00..hour-23" });
    if (!isValidCron(row.cron)) errors.push({ path: `${path}.cron`, message: `Invalid cron expression: ${row.cron}` });
    if (seenCron.has(row.cron) && row.enabled !== false) errors.push({ path: `${path}.cron`, message: `Duplicate cron ${row.cron} would double-send` });
    seenCron.set(row.cron, index);
    if (!SENDTASK_SOURCE_KINDS.includes(row.kind)) errors.push({ path: `${path}.kind`, message: `kind must be one of ${SENDTASK_SOURCE_KINDS.join(", ")}` });
    if (row.kind === "girl-video" && row.category && !SENDTASK_GIRL_CATEGORIES.includes(row.category)) {
      errors.push({ path: `${path}.category`, message: `category must be one of ${SENDTASK_GIRL_CATEGORIES.join(", ")}` });
    }
    if (row.kind === "tiktok-search" && !String(row.queryTemplate || "").trim()) {
      errors.push({ path: `${path}.queryTemplate`, message: "tiktok-search requires queryTemplate" });
    }
    const rawFallbackKind = row.fallbackKind === undefined || row.fallbackKind === null
      ? ""
      : String(row.fallbackKind);
    if (rawFallbackKind !== "" && !SENDTASK_FALLBACK_KINDS.includes(rawFallbackKind)) {
      errors.push({ path: `${path}.fallbackKind`, message: `fallbackKind must be empty or one of ${SENDTASK_FALLBACK_KINDS.join(", ")}` });
    }
    if (rawFallbackKind === "" || SENDTASK_FALLBACK_KINDS.includes(rawFallbackKind)) {
      const fallbackCategory = row.fallbackCategory === undefined || row.fallbackCategory === null
        ? ""
        : String(row.fallbackCategory);
      if (fallbackCategory !== "" && !SENDTASK_GIRL_CATEGORIES.includes(fallbackCategory)) {
        errors.push({ path: `${path}.fallbackCategory`, message: `fallbackCategory must be empty or one of ${SENDTASK_GIRL_CATEGORIES.join(", ")}` });
      }
    }
    const ttl = Number(row.ttlMinutes);
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 1440) errors.push({ path: `${path}.ttlMinutes`, message: "ttlMinutes must be between 1 and 1440" });
  });
  return { ok: errors.length === 0, errors };
}

function isValidCron(cron) {
  if (typeof cron !== "string") return false;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  return parts.every((part, index) => part === "*" || part.split(",").every((chunk) => {
    const stepSplit = chunk.split("/");
    const base = stepSplit[0];
    if (base === "*" ) return true;
    if (/^\d+$/.test(base)) {
      const num = Number(base);
      if (num < ranges[index][0] || num > ranges[index][1]) return false;
      if (index === 4 && num === 7) return true;
      return true;
    }
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (!rangeMatch) return false;
    return Number(rangeMatch[1]) <= Number(rangeMatch[2]);
  }));
}

export function createSendtaskSchedulerAdapter({ getManager }) {
  return {
    id: "sendtask-scheduler",
    validate({ values }) {
      return crossFieldValidateSendtask(values);
    },
    async preview({ contract, values, layers }) {
      const manager = getManager();
      const desired = normalizeSchedules(values);
      const diff = manager ? manager.diff(desired) : { toSchedule: [], toCancel: [], unchanged: 0 };
      return { adapter: this.id, commandName: contract.commandName, dryRun: true, diff };
    },
    async apply({ contract, values }) {
      const validation = this.validate({ contract, values });
      if (!validation.ok) return { applied: false, ...validation };
      const manager = getManager();
      if (!manager) throw adapterError(503, "SCHEDULER_UNAVAILABLE", "SendTask scheduler manager is not running in this process");
      const result = await manager.sync(normalizeSchedules(values));
      return { applied: true, adapter: this.id, revision: manager.revision, ...result };
    },
    async rollback({ previousValues }) {
      const manager = getManager();
      if (!manager) throw adapterError(503, "SCHEDULER_UNAVAILABLE", "SendTask scheduler manager is not running in this process");
      const result = await manager.rollback();
      return { rolledBack: true, adapter: this.id, ...result };
    },
  };
}

function normalizeSchedules(values) {
  const rows = Array.isArray(values?.["schedules.items"]) ? values["schedules.items"] : [];
  return rows.map((row) => ({ ...row, enabled: row.enabled !== false })).filter((row) => row.enabled);
}

export function resolveRuntimeAdapter(contract, { adapters } = {}) {
  const registry = adapters || defaultAdapterRegistry();
  const adapter = registry.get(contract.adapter) || registry.get("default-config");
  if (!adapter) throw adapterError(500, "ADAPTER_NOT_FOUND", `No runtime adapter for ${contract.adapter}`);
  return adapter;
}

const sharedRegistry = new Map();

export function defaultAdapterRegistry({ sendtaskManagerGetter } = {}) {
  if (!sharedRegistry.size) {
    sharedRegistry.set("default-config", createDefaultConfigAdapter());
    sharedRegistry.set(
      "sendtask-scheduler",
      createSendtaskSchedulerAdapter({
        getManager: sendtaskManagerGetter || (() => globalThis.__sendtaskSchedulerManager || null),
      }),
    );
  }
  return sharedRegistry;
}

export function effectiveValuesForContract(contract, layers) {
  return mergeCommandLayers({ contract, layers }).effective;
}

export function readValue(values, key) {
  return getPath(values, key);
}

function adapterError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}
