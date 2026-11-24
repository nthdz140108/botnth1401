import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import {
  getStudioContractCatalog,
  buildCoverageMatrix,
  getCommandStudioContract,
} from "../commands/studio/contracts.js";
import {
  validateStudioContract,
  contractFieldIndex,
} from "../commands/studio/contract-v2.js";
import {
  mergeCommandLayers,
  getPath,
  setPath,
  removePath,
} from "../commands/studio/config-resolver.js";
import {
  readLayerDoc,
  atomicWriteJson,
  bumpRevision,
  layerRevision,
  globalStudioPath,
  botStudioPath,
  groupOverridePath,
  draftsPath,
  appendHistory,
  readHistory,
  invalidateStudioCache,
  isValidBotId,
  isValidThreadId,
} from "../commands/studio/sparse-store.js";
import {
  resolveRuntimeAdapter,
  defaultAdapterRegistry,
} from "../commands/studio/runtime-adapters.js";
import { migrateBehaviorProfileToV2 } from "../commands/studio/behavior-bridge.js";

export class CommandStudioService {
  constructor({ root = process.cwd(), auditStore = null, registry = null } = {}) {
    this.root = path.resolve(root);
    this.auditStore = auditStore;
    this.registry = registry;
    this.backupDir = path.join(this.root, "logs", "dashboard-backups");
  }

  catalog() {
    const catalog = getStudioContractCatalog(this.registry ? { registry: this.registry } : {});
    return {
      builtAt: catalog.builtAt,
      total: catalog.contracts.length,
      commands: catalog.contracts.map((contract) => ({
        commandName: contract.commandName,
        aliases: contract.aliases,
        permission: contract.permission,
        scope: contract.scope,
        status: contract.status,
        phase: contract.phase,
        adapter: contract.adapter,
        tabs: contract.tabs.map((tab) => ({ id: tab.id, title: tab.title })),
        handlerRef: {
          module: contract.handlerRef.module,
          export: contract.handlerRef.export,
          dependencies: contract.handlerRef.dependencies,
          providers: contract.handlerRef.providers,
        },
      })),
      errors: catalog.errors,
    };
  }

  coverage() {
    return buildCoverageMatrix(this.registry ? { registry: this.registry } : {});
  }

  contract(commandName) {
    const contract = getCommandStudioContract(commandName);
    if (!contract) throw serviceError(404, "COMMAND_NOT_FOUND", `No studio contract for ${commandName}`);
    const validation = validateStudioContract(contract);
    return { contract, coverage: validation.ok ? "FULL" : "PARTIAL", validationErrors: validation.errors };
  }

  #layerFile(scope, botId, threadId) {
    if (scope === "global") return globalStudioPath(this.root);
    if (scope === "bot") {
      if (!isValidBotId(botId)) throw serviceError(400, "INVALID_BOT_ID", "botId required for bot scope");
      return botStudioPath(this.root, botId);
    }
    if (scope === "group") {
      if (!isValidBotId(botId) || !isValidThreadId(threadId)) {
        throw serviceError(400, "INVALID_THREAD_ID", "botId and threadId required for group scope");
      }
      return groupOverridePath(this.root, botId, threadId);
    }
    throw serviceError(400, "INVALID_SCOPE", "scope must be global|bot|group");
  }

  async config(commandName, { botId, threadId } = {}) {
    const { contract } = this.contract(commandName);
    const paths = {
      global: globalStudioPath(this.root),
      bot: isValidBotId(botId) ? botStudioPath(this.root, botId) : null,
      group: botId && threadId ? groupOverridePath(this.root, botId, threadId) : null,
    };
    const layers = {};
    const revisions = {};
    for (const scope of ["global", "bot", "group"]) {
      const file = paths[scope];
      if (!file) continue;
      const doc = await readLayerDoc(file);
      revisions[scope] = layerRevision(doc);
      layers[scope] = doc;
    }
    const resolved = mergeCommandLayers({ contract, layers });
    return {
      commandName: contract.commandName,
      adapter: contract.adapter,
      effective: resolved.effective,
      provenance: resolved.provenance,
      revisions,
    };
  }

  async layers({ botId, threadId } = {}) {
    const out = {};
    const specs = [["global", globalStudioPath(this.root)]];
    if (isValidBotId(botId)) {
      specs.push(["bot", botStudioPath(this.root, botId)]);
      if (threadId) specs.push(["group", groupOverridePath(this.root, botId, threadId)]);
    }
    for (const [scope, file] of specs) {
      const doc = await readLayerDoc(file);
      out[scope] = { revision: layerRevision(doc), commands: doc.commands };
    }
    return out;
  }

  async #readDrafts() {
    try {
      const raw = JSON.parse(await fsp.readFile(draftsPath(this.root), "utf8"));
      return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch {
      return {};
    }
  }

  async #writeDrafts(drafts) {
    await atomicWriteJson(draftsPath(this.root), drafts, { backupDir: this.backupDir });
  }

  static draftKey({ scope, botId, threadId, commandName }) {
    return [scope || "global", botId || "-", threadId || "-", String(commandName).toLowerCase()].join("|");
  }

  async saveDraft({ commandName, scope = "global", botId, threadId, patch = {}, resetKeys = [], expectedRevision }) {
    const { contract } = this.contract(commandName);
    validateScopeFields(contract, patch, resetKeys, scope);
    const layerFile = this.#layerFile(scope, botId, threadId);
    const doc = await readLayerDoc(layerFile);
    const revision = layerRevision(doc);
    if (expectedRevision !== undefined && Number(expectedRevision) !== revision) {
      throw serviceError(409, "REVISION_CONFLICT", `Expected revision ${expectedRevision} but layer is at ${revision}`);
    }
    const drafts = await this.#readDrafts();
    const key = CommandStudioService.draftKey({ scope, botId, threadId, commandName });
    const existing = drafts[key];
    drafts[key] = {
      commandName: contract.commandName,
      scope,
      botId: botId || null,
      threadId: threadId || null,
      patch: mergePatch(existing?.patch, patch),
      resetKeys: [...new Set([...(existing?.resetKeys || []), ...resetKeys])],
      baseRevision: revision,
      updatedAt: new Date().toISOString(),
    };
    await this.#writeDrafts(drafts);
    return { draftKey: key, draft: drafts[key] };
  }

  async discardDraft({ commandName, scope = "global", botId, threadId }) {
    this.contract(commandName);
    const drafts = await this.#readDrafts();
    const key = CommandStudioService.draftKey({ scope, botId, threadId, commandName });
    const removed = Boolean(drafts[key]);
    delete drafts[key];
    if (removed) await this.#writeDrafts(drafts);
    return { discarded: removed };
  }

  async getDraft({ commandName, scope = "global", botId, threadId }) {
    this.contract(commandName);
    const drafts = await this.#readDrafts();
    return drafts[CommandStudioService.draftKey({ scope, botId, threadId, commandName })] || null;
  }

  async listDrafts() {
    return this.#readDrafts();
  }

  async validate({ commandName, scope = "global", botId, threadId, values = {} }) {
    const { contract } = this.contract(commandName);
    const schemaErrors = validateStudioValues(contract, values);
    validateScopeFields(contract, values, [], scope);
    const current = await this.config(commandName, { botId, threadId });
    const effectiveMerged = { ...current.effective };
    for (const [key, value] of Object.entries(values)) effectiveMerged[key] = value;
    const adapter = resolveRuntimeAdapter(contract);
    const adapterResult = adapter.validate({ contract, values: effectiveMerged });
    const adapterErrors = adapterResult?.ok === false ? adapterResult.errors : [];
    let draftConflict = null;
    const draft = await this.getDraft({ commandName, scope, botId, threadId });
    if (draft) {
      const layerFile = this.#layerFile(scope, botId, threadId);
      const doc = await readLayerDoc(layerFile);
      if (layerRevision(doc) !== draft.baseRevision) {
        draftConflict = { code: "DRAFT_STALE", baseRevision: draft.baseRevision, currentRevision: layerRevision(doc) };
      }
    }
    return {
      ok: schemaErrors.length === 0 && adapterErrors.length === 0 && !draftConflict,
      errors: [...schemaErrors, ...adapterErrors],
      draftConflict,
    };
  }

  async preview({ commandName, scope = "global", botId, threadId, values = {} }) {
    const { contract } = this.contract(commandName);
    const adapter = resolveRuntimeAdapter(contract);
    const current = await this.config(commandName, { botId, threadId });
    const effectiveMerged = { ...current.effective };
    for (const [key, value] of Object.entries(values)) effectiveMerged[key] = value;
    const preview = await adapter.preview({
      contract,
      values: effectiveMerged,
      layers: await this.#layerDocsFor(commandName, { botId, threadId }),
    });
    return {
      ...preview,
      changedPaths: diffKeys(current.effective, values),
      currentRevision: current.revisions[scope] ?? null,
    };
  }

  async #layerDocsFor(commandName, { botId, threadId }) {
    const docs = {};
    docs.global = await readLayerDoc(globalStudioPath(this.root));
    if (isValidBotId(botId)) {
      docs.bot = await readLayerDoc(botStudioPath(this.root, botId));
      if (threadId) docs.group = await readLayerDoc(groupOverridePath(this.root, botId, threadId));
    }
    return docs;
  }

  async apply({ commandName, scope = "global", botId, threadId, values = {}, expectedRevision, requestId = "n/a", actor = "dashboard", fromDraft = false }) {
    const { contract } = this.contract(commandName);
    let appliedValues = values;
    if (fromDraft) {
      const draft = await this.getDraft({ commandName, scope, botId, threadId });
      if (!draft) throw serviceError(404, "DRAFT_NOT_FOUND", "No draft saved for this scope/command");
      appliedValues = draft.patch;
    }
    const layerFile = this.#layerFile(scope, botId, threadId);
    const doc = await readLayerDoc(layerFile);
    const currentRevision = layerRevision(doc);
    if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
      throw serviceError(409, "REVISION_CONFLICT", `Expected revision ${expectedRevision} but layer is at ${currentRevision}`);
    }

    const validation = await this.validate({ commandName, scope, botId, threadId, values: appliedValues });
    if (!validation.ok) {
      throw serviceError(400, "COMMAND_VALIDATION_FAILED", validation.errors.map((e) => `${e.path}: ${e.message}`).join("; "), { data: validation.errors });
    }

    const adapter = resolveRuntimeAdapter(contract);
    const current = await this.config(commandName, { botId, threadId });
    const effectiveMerged = { ...current.effective };
    for (const [key, value] of Object.entries(appliedValues)) effectiveMerged[key] = value;
    const dryRun = await adapter.preview({
      contract,
      values: effectiveMerged,
      layers: await this.#layerDocsFor(commandName, { botId, threadId }),
    });

    const previousCommands = JSON.parse(JSON.stringify(doc.commands));
    const previousMeta = JSON.parse(JSON.stringify(doc.meta));
    const previousDoc = { meta: previousMeta, commands: previousCommands };

    doc.commands[contract.commandName] = {
      ...(doc.commands[contract.commandName] || {}),
      values: stripUndefined(appliedValues),
    };
    bumpRevision(doc);

    let backup = null;
    try {
      backup = await atomicWriteJson(layerFile, doc, { backupDir: this.backupDir });
      invalidateStudioCache(layerFile);
      const adapterResult = await adapter.apply({
        contract,
        values: effectiveMerged,
        patch: appliedValues,
        previousValues: previousCommands[contract.commandName]?.values || {},
      });
      await appendHistory(this.root, {
        action: "studio.apply",
        requestId,
        actor,
        scope,
        botId: botId || null,
        threadId: threadId || null,
        commandName: contract.commandName,
        revision: doc.meta.revision,
        changedPaths: Object.keys(appliedValues).sort(),
        previousDoc,
        preview: dryRun?.diff ? { diff: dryRun.diff } : undefined,
        adapterAck: adapterResult || null,
      });
      if (this.auditStore) {
        await this.auditStore.append({
          requestId,
          action: "command-studio.apply",
          commandName: contract.commandName,
          scope,
          botId: botId || undefined,
          threadId: threadId || undefined,
          changedPaths: Object.keys(appliedValues).sort(),
          revision: doc.meta.revision,
        });
      }
      return {
        applied: true,
        revision: doc.meta.revision,
        backup,
        adapter: contract.adapter,
        adapterResult: adapterResult || null,
        changedPaths: Object.keys(appliedValues).sort(),
      };
    } catch (error) {
      await atomicWriteJson(layerFile, previousDoc, { backupDir: this.backupDir });
      invalidateStudioCache(layerFile);
      await appendHistory(this.root, {
        action: "studio.apply-failed",
        requestId,
        scope,
        botId: botId || null,
        threadId: threadId || null,
        commandName: contract.commandName,
        failedAt: new Date().toISOString(),
        error: error.message,
      }).catch(() => {});
      throw error;
    }
  }

  async rollback({ commandName, scope = "global", botId, threadId, requestId = "n/a" }) {
    const { contract } = this.contract(commandName);
    const layerFile = this.#layerFile(scope, botId, threadId);
    const entries = await readHistory(this.root, 300);
    const entry = entries.find((item) => item.action === "studio.apply"
      && item.commandName === contract.commandName
      && (item.scope || "global") === scope
      && (item.botId || null) === (botId || null)
      && (item.threadId || null) === (threadId || null)
      && item.previousDoc);
    if (!entry) throw serviceError(404, "ROLLBACK_TARGET_NOT_FOUND", "No apply history found to roll back");

    const doc = await readLayerDoc(layerFile);
    const restored = JSON.parse(JSON.stringify(entry.previousDoc));
    restored.meta = { ...(restored.meta || {}), revision: layerRevision(doc) + 1, updatedAt: new Date().toISOString(), rolledBackTo: entry.revision };
    await atomicWriteJson(layerFile, restored, { backupDir: this.backupDir });
    invalidateStudioCache(layerFile);

    const adapter = resolveRuntimeAdapter(contract);
    let adapterResult = null;
    try {
      adapterResult = await adapter.rollback({ previousValues: restored.commands?.[contract.commandName]?.values || {} });
    } catch {
      adapterResult = { pendingBotAck: true };
    }
    await appendHistory(this.root, {
      action: "studio.rollback",
      requestId,
      scope,
      botId: botId || null,
      threadId: threadId || null,
      commandName: contract.commandName,
      revision: restored.meta.revision,
      rolledBackTo: entry.revision,
      adapterAck: adapterResult,
    });
    if (this.auditStore) {
      await this.auditStore.append({
        requestId,
        action: "command-studio.rollback",
        commandName: contract.commandName,
        scope,
        revision: restored.meta.revision,
      });
    }
    return { rolledBack: true, revision: restored.meta.revision, rolledBackTo: entry.revision, adapterResult };
  }

  async resetOverride({ commandName, scope = "global", botId, threadId, requestId = "n/a" }) {
    const { contract } = this.contract(commandName);
    const layerFile = this.#layerFile(scope, botId, threadId);
    const doc = await readLayerDoc(layerFile);
    if (!doc.commands[contract.commandName]) {
      return { removed: false, revision: layerRevision(doc) };
    }
    const previousDoc = JSON.parse(JSON.stringify(doc));
    delete doc.commands[contract.commandName];
    bumpRevision(doc);
    await atomicWriteJson(layerFile, doc, { backupDir: this.backupDir });
    invalidateStudioCache(layerFile);
    await appendHistory(this.root, {
      action: "studio.reset",
      requestId,
      scope,
      botId: botId || null,
      threadId: threadId || null,
      commandName: contract.commandName,
      revision: doc.meta.revision,
      previousDoc,
    });
    return { removed: true, revision: doc.meta.revision };
  }

  async history({ commandName, limit = 50 }) {
    const entries = await readHistory(this.root, 500);
    return entries.filter((entry) => !commandName || entry.commandName === String(commandName).toLowerCase()).slice(0, limit);
  }

  migrationPreviewV1(commandName) {
    let globalDoc;
    try {
      globalDoc = JSON.parse(fs.readFileSync(path.join(this.root, "assets", "json-data", "command.json"), "utf8"));
    } catch {
      return { migrated: false, reason: "command.json unreadable" };
    }
    const entry = (globalDoc.commands || []).find((c) => c.name === commandName);
    if (!entry?.behavior) return { migrated: false, reason: "no V1 behavior profile" };
    return { migrated: true, ...migrateBehaviorProfileToV2(commandName, entry.behavior) };
  }
}

function mergePatch(existingPatch = {}, incomingPatch = {}) {
  const merged = JSON.parse(JSON.stringify(existingPatch));
  for (const [key, value] of Object.entries(incomingPatch)) merged[key] = value;
  return merged;
}

export function validateStudioValues(contract, values = {}) {
  const errors = [];
  const fields = contractFieldIndex(contract);
  for (const key of Object.keys(values)) {
    const field = fields.get(key);
    if (!field) {
      errors.push({ path: key, message: "Unknown field" });
      continue;
    }
    if (field.readOnly) {
      errors.push({ path: key, message: "Field is read-only (declared in contract)" });
      continue;
    }
    const error = validateFieldValueType(field, values[key]);
    if (error) errors.push({ path: key, message: error });
  }
  for (const [, field] of fields) {
    if (field.required && getPath(values, field.key) === undefined) {
      errors.push({ path: field.key, message: "Required field missing" });
    }
  }
  return errors;
}

function validateFieldValueType(field, value) {
  if (value === undefined) return null;
  if (value === null && field.nullable) return null;
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "Must be a boolean";
    case "number": {
      if (value === null) return field.nullable ? null : "Must be a number";
      const num = Number(value);
      if (!Number.isFinite(num)) return "Must be a number";
      if (field.min !== undefined && num < field.min) return `Must be ≥ ${field.min}`;
      if (field.max !== undefined && num > field.max) return `Must be ≤ ${field.max}`;
      return null;
    }
    case "select":
      return field.options.includes(value) ? null : `Must be one of: ${field.options.join(", ")}`;
    case "string":
    case "text":
    case "template":
    case "emoji":
      return typeof value === "string" ? null : "Must be a string";
    case "table": {
      if (!Array.isArray(value)) return "Must be an array";
      for (const row of value) {
        if (!row || typeof row !== "object" || Array.isArray(row)) return "Table rows must be objects";
        for (const column of field.columns || []) {
          const cell = row[column.key];
          if (cell === undefined || cell === "" || cell === null) continue;
          if (column.type === "number" && !Number.isFinite(Number(cell))) return `Column ${column.key} must be numeric`;
          if (column.type === "boolean" && typeof cell !== "boolean") return `Column ${column.key} must be boolean`;
          if (column.control === "select" && cell !== "" && !column.options.includes(cell)) return `Column ${column.key} must be one of: ${column.options.join(", ")}`;
        }
      }
      return null;
    }
    default:
      return null;
  }
}

function validateScopeFields(contract, patch, resetKeys, scope) {
  const fields = contractFieldIndex(contract);
  for (const key of [...Object.keys(patch || {}), ...resetKeys]) {
    const field = fields.get(key);
    if (!field) throw serviceError(400, "UNKNOWN_FIELD", `Unknown studio field: ${key}`);
    if (field.readOnly) throw serviceError(400, "READ_ONLY_FIELD", `Field is read-only: ${key}`);
    if (!field.allowedScopes.includes(scope)) {
      throw serviceError(400, "SCOPE_NOT_ALLOWED", `Field ${key} cannot be overridden at scope '${scope}' (allowed: ${field.allowedScopes.join(", ")})`);
    }
  }
}

function diffKeys(effective, values) {
  return Object.keys(values || {}).filter((key) => JSON.stringify(values[key]) !== JSON.stringify(effective?.[key]));
}

function stripUndefined(values) {
  const output = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (value === undefined) continue;
    output[key] = value;
  }
  return output;
}

function serviceError(status, code, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  Object.assign(error, extra);
  return error;
}

export { setPath, removePath };
