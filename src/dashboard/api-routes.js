import fs from "node:fs/promises";
import path from "node:path";
import { AuditStore } from "./audit-store.js";
import { BotRegistry } from "./bot-registry.js";
import { COMMAND_BEHAVIOR_SCHEMA, RESPONSE_TEMPLATE_VARIABLES, defaultBehaviorProfile } from "./command-behavior-schema.js";
import { BehaviorStore, validateBehaviorProfile } from "./command-behavior-store.js";
import { renderTemplate } from "./command-response-template.js";
import { CommandScanner, validateCommandOverrides } from "./command-scanner.js";
import { commandRegistry } from "../commands/command-registry.js";
import { CommandService } from "./command-service.js";
import { ConfigStore } from "./config-store.js";
import { CredentialService } from "./credential-service.js";
import { readLogs } from "./log-reader.js";
import { PrefixService } from "./prefix-service.js";
import { ChatPolicyService } from "./chat-policy-service.js";
import { RoleRegistryService } from "./role-registry-service.js";
import { createBotActionService, DELETE_CONFIRMATION } from "./bot-action-service.js";
import { ProviderConfigService } from "./provider-config-service.js";
import { Phase9DashboardService } from "./phase9-dashboard-service.js";
import { requestIdMiddleware, sendError, sendSuccess } from "./api-response.js";
import { CommandStudioService } from "./command-studio-service.js";
import { writeReloadRequest } from "../commands/mybot/System/reload-request.js";
import { parseFlexibleCookieInput, registerV4ControlRoutes } from "./v4-control-routes.js";
import { registerV5DashboardRoutes } from "./v5/v5-routes.js";
import {
  getProfile,
  updateProfile,
  updateStyle,
  resetStyle,
  redactProfile,
} from "../commands/mybot/System/mybot-profile-service.js";
import {
  getOwnerTrialStatus,
  getBangkokCalendarWeek,
} from "../commands/mybot/System/mybot-trial-ledger.js";


export function registerDashboardApi(app, options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const registry = options.registry || new BotRegistry({ root, pm2: options.pm2, portProbe: options.portProbe });
  const configStore = options.configStore || new ConfigStore({ backupDir: path.join(root, "logs", "dashboard-backups") });
  const auditStore = options.auditStore || new AuditStore({ root });
  const scanner = options.scanner || new CommandScanner({ root, registry: options.commandRegistry || commandRegistry });
  const commandService = options.commandService || new CommandService({ root, registry, scanner, configStore });
  const credentialService = options.credentialService || new CredentialService({ root, registry, configStore });
  const prefixService = options.prefixService || new PrefixService({ root, registry, configStore });
  const chatPolicyService = options.chatPolicyService || new ChatPolicyService({ root, registry, configStore });
  const providerConfigService = options.providerConfigService || new ProviderConfigService({ root });
  const phase9Service = options.phase9Service || new Phase9DashboardService({
    root,
    registry,
    vipRegistry: options.vipRegistry || options.commandRegistry || commandRegistry,
    providerConfigService,
    featureFlagService: options.featureFlagService,
    auditStore,
  });
  const actionService = options.actionService || createBotActionService({
    root,
    registry,
    configStore,
    auditStore,
    pm2Adapter: options.pm2Adapter || options.pm2,
    processAdapter: options.processAdapter,
  });
  const actions = options.actions || actionService;
  const roleRegistry = options.roleRegistryService || new RoleRegistryService({ root, registry, configStore, auditStore, actions });
  const qrSessionManager = options.qrSessionManager || null;
  const behaviorStore = options.behaviorStore || new BehaviorStore({ root, configStore });
  const studioService = options.studioService || new CommandStudioService({ root, auditStore, registry: options.commandRegistry || null });
  const adminRecoveryService = options.adminRecoveryService || null;

  // ---------------------------------------------------------------------------
  // Command Studio V2: per-command contracts, layered config, draft/apply flow
  // ---------------------------------------------------------------------------
  app.get("/api/command-studio/catalog", wrap(async (req, res) => sendSuccess(res, req, studioService.catalog())));
  app.get("/api/command-studio/coverage", wrap(async (req, res) => sendSuccess(res, req, studioService.coverage())));
  app.get("/api/command-studio/layers", wrap(async (req, res) => sendSuccess(res, req, await studioService.layers({
    botId: req.query.botId,
    threadId: req.query.threadId,
  }))));
  app.get("/api/command-studio/commands/:commandName/contract", wrap(async (req, res) => {
    const { contract, coverage, validationErrors } = studioService.contract(req.params.commandName);
    return sendSuccess(res, req, { contract, coverage, validationErrors });
  }));
  app.get("/api/command-studio/commands/:commandName/config", wrap(async (req, res) => sendSuccess(res, req, await studioService.config(req.params.commandName, {
    botId: req.query.botId,
    threadId: req.query.threadId,
  }))));
  app.get("/api/command-studio/commands/:commandName/draft", wrap(async (req, res) => sendSuccess(res, req, {
    draft: await studioService.getDraft({
      commandName: req.params.commandName,
      scope: req.query.scope || "global",
      botId: req.query.botId,
      threadId: req.query.threadId,
    }),
  })));
  app.put("/api/command-studio/commands/:commandName/draft", wrap(async (req, res) => {
    const result = await studioService.saveDraft({
      commandName: req.params.commandName,
      scope: req.body?.scope || "global",
      botId: req.body?.botId,
      threadId: req.body?.threadId,
      patch: req.body?.patch || {},
      resetKeys: req.body?.resetKeys || [],
      expectedRevision: req.body?.expectedRevision,
    });
    return sendSuccess(res, req, result);
  }));
  app.delete("/api/command-studio/commands/:commandName/draft", wrap(async (req, res) => {
    const result = await studioService.discardDraft({
      commandName: req.params.commandName,
      scope: req.query.scope || req.body?.scope || "global",
      botId: req.query.botId || req.body?.botId,
      threadId: req.query.threadId || req.body?.threadId,
    });
    return sendSuccess(res, req, result);
  }));
  app.post("/api/command-studio/commands/:commandName/validate", wrap(async (req, res) => {
    const result = await studioService.validate({
      commandName: req.params.commandName,
      scope: req.body?.scope || "global",
      botId: req.body?.botId,
      threadId: req.body?.threadId,
      values: req.body?.values || {},
    });
    if (!result.ok && result.errors.length > 0) {
      return sendError(res, req, 400, "COMMAND_VALIDATION_FAILED", result.errors.map((e) => `${e.path}: ${e.message}`).join("; "), { data: result });
    }
    return sendSuccess(res, req, result);
  }));
  app.post("/api/command-studio/commands/:commandName/preview", wrap(async (req, res) => {
    const result = await studioService.preview({
      commandName: req.params.commandName,
      scope: req.body?.scope || "global",
      botId: req.body?.botId,
      threadId: req.body?.threadId,
      values: req.body?.values || {},
    });
    return sendSuccess(res, req, result);
  }));
  app.post("/api/command-studio/commands/:commandName/apply", wrap(async (req, res) => {
    try {
      const result = await studioService.apply({
        commandName: req.params.commandName,
        scope: req.body?.scope || "global",
        botId: req.body?.botId,
        threadId: req.body?.threadId,
        values: req.body?.values || {},
        expectedRevision: req.body?.expectedRevision,
        requestId: req.requestId,
        actor: req.body?.actor || "dashboard",
        fromDraft: req.body?.fromDraft === true,
      });
      return sendSuccess(res, req, result);
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") return sendError(res, req, 409, error.code, error.message);
      if (error.code === "DRAFT_NOT_FOUND") return sendError(res, req, 404, error.code, error.message);
      throw error;
    }
  }));
  app.post("/api/command-studio/commands/:commandName/rollback", wrap(async (req, res) => {
    try {
      const result = await studioService.rollback({
        commandName: req.params.commandName,
        scope: req.body?.scope || "global",
        botId: req.body?.botId,
        threadId: req.body?.threadId,
        requestId: req.requestId,
      });
      return sendSuccess(res, req, result);
    } catch (error) {
      if (error.code === "ROLLBACK_TARGET_NOT_FOUND") return sendError(res, req, 404, error.code, error.message);
      throw error;
    }
  }));
  app.post("/api/command-studio/commands/:commandName/reset-override", wrap(async (req, res) => {
    const result = await studioService.resetOverride({
      commandName: req.params.commandName,
      scope: req.body?.scope || "global",
      botId: req.body?.botId,
      threadId: req.body?.threadId,
      requestId: req.requestId,
    });
    return sendSuccess(res, req, result);
  }));
  app.get("/api/command-studio/commands/:commandName/history", wrap(async (req, res) => {
    const entries = await studioService.history({
      commandName: req.params.commandName === "all" ? undefined : req.params.commandName,
      limit: Number(req.query.limit || 50),
    });
    return sendSuccess(res, req, { entries });
  }));
  app.get("/api/command-studio/migration/v1/:commandName", wrap(async (req, res) => {
    return sendSuccess(res, req, studioService.migrationPreviewV1(req.params.commandName));
  }));
  app.get("/api/command-studio/drafts", wrap(async (req, res) => sendSuccess(res, req, { drafts: await studioService.listDrafts() })));

  app.use(requestIdMiddleware);
  app.get("/api/system/primary-bot", wrap(async (req, res) => sendSuccess(res, req, await roleRegistry.read())));
  app.post("/api/system/admin-bot/swap", wrap(async (req, res) => {
    const targetBotId = req.body?.targetBotId;
    if (typeof targetBotId !== "string" || !targetBotId.trim()) {
      return sendError(res, req, 400, "INVALID_TARGET_BOT", "targetBotId is required");
    }
    const result = await roleRegistry.swapAdminBot(targetBotId.trim(), {
      requestId: req.requestId,
      actor: req.body?.actor || req.body?.requestedBy || "dashboard",
      confirm: Boolean(req.body?.confirm),
    });
    return sendSuccess(res, req, {
      oldAdminBotId: result.previousAdminBotId || null,
      newAdminBotId: result.adminBotId || result.primaryBotId || null,
      restartedBots: result.transaction?.restartedBots || [],
      health: {
        oldAdmin: "ok",
        newAdmin: "ok",
      },
      transactionId: result.transaction?.id || null,
      state: result,
    });
  }));
  app.post("/api/system/command-config/reload", wrap(async (req, res) => {
    const botId = String(req.body?.botId || "admin");
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) {
      return sendError(res, req, 400, "INVALID_BOT_ID", "botId must match [a-zA-Z0-9_-]");
    }
    const commandName = typeof req.body?.commandName === "string" && req.body.commandName.trim()
      ? req.body.commandName.trim().toLowerCase()
      : null;
    const reloadType = commandName ? "command-studio" : "command-config";
    const request = writeReloadRequest(botId, {
      reloadType,
      ...(commandName ? { commandName, revision: req.body?.revision ?? null, scope: req.body?.scope || "global" } : {}),
    });
    await auditStore.append({ requestId: req.requestId, action: `${reloadType}.reload-request`, botId, commandName });
    res.status(202);
    return sendSuccess(res, req, { requested: true, botId, requestedAt: request.requestedAt, reloadType, commandName });
  }));
  app.get("/api/system/command-config/reload-state", wrap(async (req, res) => {
    const botId = String(req.query.botId || "admin");
    if (!/^[a-zA-Z0-9_-]+$/.test(botId)) {
      return sendError(res, req, 400, "INVALID_BOT_ID", "botId must match [a-zA-Z0-9_-]");
    }
    try {
      const file = path.join(root, "mybot", "state", "reload", `${botId}.json`);
      const raw = await fs.readFile(file, "utf8");
      return sendSuccess(res, req, JSON.parse(raw));
    } catch {
      return sendSuccess(res, req, { botId, status: "unknown" });
    }
  }));
  if (qrSessionManager) {
    app.post("/api/bots/:id/actions/qr-login", wrap(async (req, res) => {
      const bot = await registry.describe(req.params.id);
      if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
      try {
        const result = await qrSessionManager.start(bot.id);
        res.status(202);
        return sendSuccess(res, req, result);
      } catch (error) {
        const status = error.status === 409 ? 409 : 502;
        const code = error.code || (status === 409 ? "QR_CONFLICT" : "QR_INIT_FAILED");
        return sendError(res, req, status, code, error.message || "Unable to start QR login");
      }
    }));
    app.get("/api/bots/:id/qr-login", wrap(async (req, res) => {
      const bot = await registry.describe(req.params.id);
      if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
      const state = await qrSessionManager.get(req.params.id);
      return sendSuccess(res, req, state || { botId: req.params.id, state: "idle", qrImage: null });
    }));
    app.delete("/api/bots/:id/qr-login", wrap(async (req, res) => {
      const bot = await registry.describe(req.params.id);
      if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
      return sendSuccess(res, req, { botId: req.params.id, cancelled: await qrSessionManager.cancel(req.params.id) });
    }));
    app.get("/api/system/qr-sessions", wrap(async (req, res) => {
      return sendSuccess(res, req, {
        sessions: await qrSessionManager.list(),
        activeCount: await qrSessionManager.activeCount(),
        maxConcurrentSessions: qrSessionManager.maxConcurrentSessions,
      });
    }));
  }
  app.get("/api/system/admin-recovery", wrap(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const session = req.dashboardSession || req.session || req.user;
    if (!session) {
      return sendError(res, req, 401, "AUTH_REQUIRED", "Authentication required to access admin recovery status");
    }
    if (app.locals?.webAdminCoordinator?.isActiveOrRecent?.()) {
      return sendSuccess(res, req, app.locals.webAdminCoordinator.getSnapshot());
    }
    const status = adminRecoveryService ? await adminRecoveryService.getStatus() : { state: "idle" };
    return sendSuccess(res, req, status);
  }));
  app.get("/api/commands/behavior-schema", wrap(async (req, res) => {
    return sendSuccess(res, req, { schema: COMMAND_BEHAVIOR_SCHEMA, variables: [...RESPONSE_TEMPLATE_VARIABLES, "{param:<key>}"] });
  }));

  app.get("/api/commands/:commandName/behavior", wrap(async (req, res) => {
    const global = await behaviorStore.getGlobal(req.params.commandName);
    return sendSuccess(res, req, { global, defaults: defaultBehaviorProfile() });
  }));

  const upsertGlobalBehavior = wrap(async (req, res, action) => {
    try {
      if (action === "reset") {
        const result = await behaviorStore.resetGlobal(req.params.commandName);
        await auditStore.append({ requestId: req.requestId, action: "command.behavior.reset", commandName: req.params.commandName, scope: "global" });
        return sendSuccess(res, req, { removed: true }, { backup: result.backup });
      }
      const validated = validateBehaviorProfile(req.body || {});
      if (!validated.ok) {
        return sendError(res, req, 400, "COMMAND_VALIDATION_FAILED", validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "), { data: validated.errors });
      }
      const result = await behaviorStore.setGlobal(req.params.commandName, sparseBehaviorProfile(req.body || {}));
      await auditStore.append({ requestId: req.requestId, action: "command.behavior.update", commandName: req.params.commandName, scope: "global", changedPaths: result.changedPaths });
      return sendSuccess(res, req, { value: findCommandEntry(result.value, req.params.commandName) }, { backup: result.backup });
    } catch (error) {
      if (error.code === "COMMAND_NOT_FOUND") return sendError(res, req, 404, error.code, error.message);
      throw error;
    }
  });

  app.put("/api/commands/:commandName/behavior", wrap(async (req, res) => upsertGlobalBehavior(req, res, "update")));
  app.delete("/api/commands/:commandName/behavior", wrap(async (req, res) => upsertGlobalBehavior(req, res, "reset")));

  app.get("/api/bots/:id/commands/:commandName/behavior", wrap(async (req, res) => {
    const global = await behaviorStore.getGlobal(req.params.commandName);
    const { override } = await behaviorStore.getForBot(req.params.id, req.params.commandName);
    return sendSuccess(res, req, {
      global,
      override,
      effective: BehaviorStore.effective(global, override),
      hasOverride: Boolean(override),
    });
  }));

  const upsertBotBehavior = wrap(async (req, res, action) => {
    try {
      if (action === "reset") {
        const result = await behaviorStore.resetForBot(req.params.id, req.params.commandName);
        await auditStore.append({ requestId: req.requestId, action: "command.behavior.reset", commandName: req.params.commandName, scope: "bot", botId: req.params.id });
        return sendSuccess(res, req, { removed: true }, { backup: result.backup });
      }
      const validated = validateBehaviorProfile(req.body || {});
      if (!validated.ok) {
        return sendError(res, req, 400, "COMMAND_VALIDATION_FAILED", validated.errors.map((e) => `${e.path}: ${e.message}`).join("; "), { data: validated.errors });
      }
      const result = await behaviorStore.setForBot(req.params.id, req.params.commandName, sparseBehaviorProfile(req.body || {}));
      await auditStore.append({ requestId: req.requestId, action: "command.behavior.update", commandName: req.params.commandName, scope: "bot", botId: req.params.id, changedPaths: result.changedPaths });
      return sendSuccess(res, req, { value: result.value?.[req.params.commandName] || null }, { backup: result.backup });
    } catch (error) {
      if (error.code === "COMMAND_NOT_FOUND") return sendError(res, req, 404, error.code, error.message);
      throw error;
    }
  });

  app.put("/api/bots/:id/commands/:commandName/behavior", wrap(async (req, res) => upsertBotBehavior(req, res, "update")));
  app.delete("/api/bots/:id/commands/:commandName/behavior", wrap(async (req, res) => upsertBotBehavior(req, res, "reset")));

  app.post("/api/commands/render-preview", wrap(async (req, res) => {
    const template = req.body?.template;
    if (typeof template !== "string") {
      return sendError(res, req, 400, "INVALID_TEMPLATE", "template must be a string");
    }
    return sendSuccess(res, req, { rendered: renderTemplate(template, req.body?.vars || {}) });
  }));
  app.get("/api/bots", wrap(async (req, res) => sendSuccess(res, req, { bots: await registry.list() })));
  app.get("/api/bots/:id", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    return sendSuccess(res, req, bot);
  }));
  app.get("/api/bots/:id/runtime", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    return sendSuccess(res, req, await registry.runtime(req.params.id));
  }));
  app.get("/api/bots/:id/profile", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const profile = getProfile(req.params.id, { root });
    return sendSuccess(res, req, redactProfile(profile));
  }));
  app.put("/api/bots/:id/profile", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    try {
      const result = updateProfile(req.params.id, req.body || {}, {
        root,
        expectedRevision: req.body?.expectedRevision,
        actor: req.dashboardSession?.username || "dashboard",
        auditStore,
      });
      return sendSuccess(res, req, redactProfile(result.profile), { backup: result.backup });
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") return sendError(res, req, 409, error.code, error.message);
      if (error.code === "INVALID_PROFILE") return sendError(res, req, 400, error.code, error.message, { details: error.details });
      throw error;
    }
  }));
  app.put("/api/bots/:id/style", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    try {
      const stylePatch = req.body?.style || req.body || {};
      const result = updateStyle(req.params.id, stylePatch, {
        root,
        expectedRevision: req.body?.expectedRevision,
        actor: req.dashboardSession?.username || "dashboard",
        auditStore,
      });
      return sendSuccess(res, req, redactProfile(result.profile), { backup: result.backup });
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") return sendError(res, req, 409, error.code, error.message);
      if (error.code === "INVALID_STYLE") return sendError(res, req, 400, error.code, error.message, { details: error.details });
      throw error;
    }
  }));
  app.post("/api/bots/:id/style/reset", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    try {
      const result = resetStyle(req.params.id, {
        root,
        expectedRevision: req.body?.expectedRevision,
        actor: req.dashboardSession?.username || "dashboard",
        auditStore,
      });
      return sendSuccess(res, req, redactProfile(result.profile), { backup: result.backup });
    } catch (error) {
      if (error.code === "REVISION_CONFLICT") return sendError(res, req, 409, error.code, error.message);
      throw error;
    }
  }));
  app.get("/api/owners/:ownerUid/trial-status", wrap(async (req, res) => {
    const status = getOwnerTrialStatus(req.params.ownerUid, { root });
    return sendSuccess(res, req, status);
  }));
  app.get("/api/bots/:id/showinfo", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const profile = getProfile(req.params.id, { root });
    const trialStatus = getOwnerTrialStatus(profile.ownerUid || req.params.id, { root });
    const runtime = await registry.runtime(req.params.id).catch(() => null);
    return sendSuccess(res, req, {
      botId: req.params.id,
      bot,
      profile: redactProfile(profile),
      trialStatus,
      runtime,
      currentBangkokWeek: getBangkokCalendarWeek(),
    });
  }));
  app.get("/api/mybot/showinfo", wrap(async (req, res) => {
    const session = req.dashboardSession || req.session || req.user;
    if (!session) {
      return sendError(res, req, 401, "AUTH_REQUIRED", "Authentication required to access showinfo");
    }

    const isSystemAdmin = Boolean(
      session.isAdmin ||
      session.role === "admin" ||
      session.role === "system_admin"
    );

    // Non-admin identity is strictly derived from session (prevent header/query spoofing)
    const effectiveOwnerUid = isSystemAdmin
      ? (req.query?.ownerUid || req.headers?.["x-owner-uid"] || null)
      : (session.ownerUid || session.uid || null);

    if (!isSystemAdmin && !effectiveOwnerUid) {
      return sendError(res, req, 401, "AUTH_REQUIRED", "Valid owner session identity required");
    }

    const bots = await registry.list();
    const currentBangkokWeek = getBangkokCalendarWeek();
    const showinfoList = [];
    for (const b of bots) {
      const profile = getProfile(b.id, { root });
      if (!isSystemAdmin) {
        const ownerUid = String(profile.ownerUid || b.id).trim();
        if (ownerUid !== String(effectiveOwnerUid).trim() && String(b.id).trim() !== String(effectiveOwnerUid).trim()) {
          continue;
        }
      } else if (effectiveOwnerUid) {
        const ownerUid = String(profile.ownerUid || b.id).trim();
        if (ownerUid !== String(effectiveOwnerUid).trim() && String(b.id).trim() !== String(effectiveOwnerUid).trim()) {
          continue;
        }
      }
      const trialStatus = getOwnerTrialStatus(profile.ownerUid || b.id, { root });
      showinfoList.push({
        botId: b.id,
        bot: b,
        profile: redactProfile(profile),
        trialStatus,
      });
    }
    return sendSuccess(res, req, {
      currentBangkokWeek,
      bots: showinfoList,
    });
  }));
  app.post("/api/bots/:id/actions/:action", wrapAction(actions, auditStore));

  app.get("/api/bots/:id/prefix", wrap(async (req, res) => {
    return sendSuccess(res, req, await prefixService.read(req.params.id));
  }));
  app.put("/api/bots/:id/prefix", wrap(async (req, res) => {
    const result = await prefixService.update(req.params.id, req.body?.prefix);
    await auditStore.append({ requestId: req.requestId, action: "prefix.update", botId: req.params.id, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.get("/api/bots/:id/chat-policy", wrap(async (req, res) => {
    const result = await chatPolicyService.read(req.params.id);
    return sendSuccess(res, req, { policy: publicChatPolicy(result) });
  }));
  app.put("/api/bots/:id/chat-policy", wrap(async (req, res) => {
    const result = await chatPolicyService.update(req.params.id, req.body || {});
    await auditStore.append({
      requestId: req.requestId,
      action: "chat-policy.update",
      botId: req.params.id,
      changedPaths: result.changedPaths,
    });
    return sendSuccess(res, req, { policy: result.policy }, result);
  }));
  app.post("/api/bots/actions/bulk", wrap(async (req, res) => {
    const { action } = req.body || {};
    const botIds = normalizeBotIds(req.body);
    if (botIds.length === 0) return sendError(res, req, 400, "INVALID_BOT_IDS", "botIds are required");
    if (!hasAction(actions, action)) return sendError(res, req, 503, "ACTION_UNAVAILABLE", `Action unavailable: ${action}`);
    if (action === "delete" && req.body?.confirm !== DELETE_CONFIRMATION) {
      return sendError(res, req, 400, "DELETE_CONFIRMATION_REQUIRED", "Bulk delete confirmation is required");
    }
    const result = typeof actions.bulk === "function"
      ? await actions.bulk(action, botIds, req.body || {})
      : await runBulkAction(actions, action, botIds, req.body || {});
    await auditStore.append({ requestId: req.requestId, action: `bots.bulk.${action}`, target: botIds.join(",") });
    if (result.partial && action === "delete") return sendError(res, req, 207, "PARTIAL_DELETE", "Some bot actions failed", { data: result });
    return sendSuccess(res, req, result);
  }));
  app.get("/api/logs", wrap(async (req, res) => {
    const logs = await readLogs({
      root,
      botId: req.query.botId ? String(req.query.botId) : undefined,
      severity: req.query.severity ? String(req.query.severity) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      limit: req.query.limit,
    });
    return sendSuccess(res, req, { logs });
  }));
  app.get("/api/provider-config", wrap(async (req, res) => {
    return sendSuccess(res, req, await providerConfigService.read());
  }));
  const handleProviderConfigWrite = wrap(async (req, res, allowFlatBody) => {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const error = new Error("Provider config values must be an object");
      error.code = "PROVIDER_CONFIG_INVALID";
      error.status = 400;
      throw error;
    }
    const hasValuesField = Object.prototype.hasOwnProperty.call(body, "values");
    const values = hasValuesField ? body.values : (allowFlatBody ? body : null);
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      const error = new Error("Provider config values must be an object");
      error.code = "PROVIDER_CONFIG_INVALID";
      error.status = 400;
      throw error;
    }
    const result = await providerConfigService.update(values);
    const latest = await providerConfigService.read();
    await auditStore.append({
      requestId: req.requestId,
      action: "provider-config.update",
      changedKeys: result.changedKeys,
    });
    const payload = allowFlatBody
      ? {
          keys: result.keys,
          groups: latest?.groups ?? result.groups ?? [],
          health: latest?.health ?? result.health ?? {},
        }
      : { keys: result.keys };
    return sendSuccess(res, req, payload, {
      backup: result.backup,
      changedKeys: result.changedKeys,
      restartRequired: true,
    });
  });
  app.post("/api/provider-config", wrap(async (req, res) => handleProviderConfigWrite(req, res, true)));
  app.get("/api/provider-health", wrap(async (req, res) => {
    const state = await providerConfigService.read();
    return sendSuccess(res, req, {
      updatedAt: new Date().toISOString(),
      health: state.health,
      groups: state.groups,
    });
  }));
  app.get("/api/vip/catalog", wrap(async (req, res) => sendSuccess(res, req, await phase9Service.getCommandCatalog())));
  app.get("/api/vip/feature-flags", wrap(async (req, res) => sendSuccess(res, req, await phase9Service.getFeatureFlags())));
  app.put("/api/vip/feature-flags", wrap(async (req, res) => {
    const result = await phase9Service.updateFeatureFlags(req.body || {});
    return sendSuccess(res, req, result.flags, result);
  }));
  app.get("/api/vip/provider-status", wrap(async (req, res) => sendSuccess(res, req, await phase9Service.getProviderStatus())));
  app.post("/api/vip/provider-status/refresh", wrap(async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return sendError(res, req, 400, "INVALID_PROVIDER_PATCH", "Provider patch must be an object");
    }
    const result = await phase9Service.refreshProviderKeys(req.body);
    return sendSuccess(res, req, result.keys, result);
  }));
  app.get("/api/vip/queue", wrap(async (req, res) => sendSuccess(res, req, await phase9Service.getQueueSnapshot())));
  app.get("/api/vip/audit", wrap(async (req, res) => {
    const limit = Number(req.query.limit || 100);
    const audit = await phase9Service.getAuditSummary({
      limit: Number.isFinite(limit) ? Math.max(1, Math.min(limit, 500)) : 100,
      query: req.query.query || "",
      action: req.query.action || "",
      exportFormat: req.query.format === "csv" ? "csv" : "json",
    });
    return sendSuccess(res, req, audit);
  }));
  app.get("/api/vip/audit/export", wrap(async (req, res) => {
    const audit = await phase9Service.getAuditSummary({
      limit: Number(Math.max(1, Math.min(Number(req.query.limit || 200), 500))),
      query: req.query.query || "",
      action: req.query.action || "",
      exportFormat: req.query.format === "csv" ? "csv" : "json",
    });
    res.setHeader("Content-Type", req.query.format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");
    return res.send(audit.export);
  }));
  app.post("/api/vip/migration-preview", wrap(async (req, res) => {
    const result = await phase9Service.previewMigration(req.body?.flags || req.body || {});
    return sendSuccess(res, req, result);
  }));
  app.put("/api/provider-config", wrap(async (req, res) => handleProviderConfigWrite(req, res, false)));
  app.get("/api/system/health", wrap(async (req, res) => {
    const overview = await registry.list();
    const providers = await providerConfigService.read();
    const vipFlags = await phase9Service.getFeatureFlags();
    const queue = await phase9Service.getQueueSnapshot();
    const { collectHealthExtensions } = await import("../observability/runtime-metrics.js");
    const extensions = await collectHealthExtensions().catch(() => ({}));
    let diskCleanup = null;
    try {
      const fsMod = await import("node:fs/promises");
      const diskStatusPath = path.join(root, ".runtime", "disk-cleanup", "status.json");
      const diskRaw = await fsMod.readFile(diskStatusPath, "utf8");
      diskCleanup = JSON.parse(diskRaw);
    } catch {}
    return sendSuccess(res, req, {
      status: "healthy",
      pid: process.pid,
      uptime: process.uptime(),
      bots: overview.length,
      providers: providers.health,
      vipFlags: vipFlags.flags,
      queue: queue.queues,
      diskCleanup,
      ...extensions,
      updatedAt: new Date().toISOString(),
    });
  }));
  const SNAPSHOT_REL_FILES = [
    "mybot/mybots.json",
    "mybot/configs/vip-feature-flags.json",
    "assets/data/group_settings.json",
    "assets/json-data/server-config.json",
  ];
  app.post("/api/system/disk-cleanup", wrap(async (req, res) => {
    const { DiskCleanupService } = await import("../runtime/disk-cleanup-service.js");
    const cleaner = new DiskCleanupService({ projectRoot: root });
    const result = await cleaner.run({ trigger: "dashboard_manual" });
    await auditStore.append({
      requestId: req.requestId,
      action: "system.disk-cleanup",
      bytesFreedTotal: result?.bytesFreedTotal || 0,
      filesFreedTotal: result?.filesFreedTotal || 0,
    });
    return sendSuccess(res, req, result);
  }));
  app.post("/api/system/backup", wrap(async (req, res) => {
    const snapshotDir = path.join(root, ".runtime", "backups", "dashboard-snapshot");
    await fs.rm(snapshotDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(snapshotDir, { recursive: true });
    const copied = [];
    for (const rel of SNAPSHOT_REL_FILES) {
      const src = path.join(root, rel);
      const dst = path.join(snapshotDir, rel);
      try {
        await fs.access(src);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        copied.push(rel);
      } catch {}
    }
    await fs.writeFile(
      path.join(snapshotDir, "manifest.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), files: copied }, null, 2),
      "utf8"
    );
    await auditStore.append({ requestId: req.requestId, action: "system.backup", files: copied });
    return sendSuccess(res, req, { backedUp: true, files: copied, createdAt: new Date().toISOString() });
  }));
  app.post("/api/system/restore", wrap(async (req, res) => {
    const snapshotDir = path.join(root, ".runtime", "backups", "dashboard-snapshot");
    const manifestPath = path.join(snapshotDir, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      return sendError(res, req, 404, "SNAPSHOT_NOT_FOUND", "Chưa có bản sao lưu hệ thống nào để khôi phục.");
    }
    const restored = [];
    for (const rel of SNAPSHOT_REL_FILES) {
      const src = path.join(snapshotDir, rel);
      const dst = path.join(root, rel);
      try {
        await fs.access(src);
        await fs.mkdir(path.dirname(dst), { recursive: true });
        await fs.copyFile(src, dst);
        restored.push(rel);
      } catch {}
    }
    await auditStore.append({ requestId: req.requestId, action: "system.restore", files: restored });
    return sendSuccess(res, req, { restored: true, files: restored, snapshotCreatedAt: manifest.createdAt || null });
  }));
  app.get("/api/dashboard/metrics", wrap(async (req, res) => {
    const bots = await registry.list();
    const queue = await phase9Service.getQueueSnapshot();
    const catalog = await phase9Service.getCommandCatalog();
    return sendSuccess(res, req, {
      bots: bots.length,
      running: bots.filter((bot) => bot.status === "running").length,
      vipCommands: catalog.commands.length,
      queued: queue.totalQueued,
      sampledAt: new Date().toISOString(),
    });
  }));
  app.get("/api/bots/:id/config", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    const files = {};
    for (const [key, file] of Object.entries(bot.paths || {})) {
      if (/credential|configfile/i.test(key)) continue;
      if (typeof file !== "string") continue;
      const resolvedFile = path.resolve(root, file);
      if (!resolvedFile.startsWith(rootPrefix)) continue;
      try {
        files[key] = JSON.parse(await fs.readFile(resolvedFile, "utf8"));
      } catch {
        files[key] = null;
      }
    }
    return sendSuccess(res, req, { botId: bot.id, files });
  }));
  app.get("/api/bots/:id/config/:pathKey", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const file = await resolveBotPath(bot, req.params.pathKey, root);
    if (!file) return sendError(res, req, 404, "PATH_NOT_FOUND", "Config path not found");
    return sendSuccess(res, req, JSON.parse(await fs.readFile(file, "utf8")));
  }));
  app.put("/api/bots/:id/config/:pathKey", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const file = await resolveBotPath(bot, req.params.pathKey, root);
    if (!file) return sendError(res, req, 404, "PATH_NOT_FOUND", "Config path not found");
    const result = await configStore.writeJson(file, req.body || {});
    await auditStore.append({ requestId: req.requestId, action: "config.update", botId: req.params.id, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.get("/api/bots/:id/credential", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    const credential = await credentialService.read(req.params.id);
    return sendSuccess(res, req, credential);
  }));
  app.post("/api/bots/:id/credential/reveal", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    return sendSuccess(res, req, await credentialService.reveal(req.params.id));
  }));
  app.put("/api/bots/:id/credential", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    const incoming = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? { ...req.body } : {};
    if (typeof incoming.cookie === "string" || Array.isArray(incoming.cookie)) {
      const parsed = parseFlexibleCookieInput(incoming.cookie);
      if (parsed) incoming.cookie = parsed;
    }
    if (req.params.id === "admin") {
      const adminDesc = await registry.describe("admin");
      if (!adminDesc?.configPath && app.locals?.webAdminCoordinator?.applyManualCredential) {
        await app.locals.webAdminCoordinator.applyManualCredential({
          cookiePayload: incoming.cookie || {},
          imei: incoming.imei || "",
          userAgent: incoming.userAgent || "",
          uid: incoming.uid || "admin",
          displayName: incoming.name || incoming.displayName || "Admin Bot",
          avatar: incoming.avatar || "",
        });
        await auditStore.append({ requestId: req.requestId, action: "credential.update", botId: "admin", changedPaths: ["cookie", "imei"] });
        return sendSuccess(res, req, { configured: true, state: "configured" });
      }
    }
    const result = await credentialService.update(req.params.id, incoming);
    if (req.params.id === "admin") {
      try {
        writeReloadRequest("admin", { reloadType: "credential", credentialPath: "assets/config.json" });
      } catch {}
    }
    await auditStore.append({ requestId: req.requestId, action: "credential.update", botId: req.params.id, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.post("/api/bots/:id/config/rollback", wrap(async (req, res) => {
    assertSafeBotParam(req.params.id);
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const file = await resolveBotPath(bot, req.body?.pathKey || req.query.pathKey, root);
    if (!file) return sendError(res, req, 404, "PATH_NOT_FOUND", "Config path not found");
    const result = await configStore.rollback(file, req.body?.backup);
    await auditStore.append({ requestId: req.requestId, action: "config.rollback", botId: req.params.id, backup: req.body?.backup });
    return sendSuccess(res, req, result.value, result);
  }));
  app.get("/api/commands/scan", wrap(async (req, res) => sendSuccess(res, req, await commandService.scan())));
  app.get("/api/commands", wrap(async (req, res) => sendSuccess(res, req, await commandService.list())));
  app.put("/api/commands/:commandName", wrap(async (req, res) => {
    const result = await commandService.updateGlobal(req.params.commandName, req.body || {});
    await auditStore.append({ requestId: req.requestId, action: "command.update", commandName: req.params.commandName, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.post("/api/commands", wrap(async (req, res) => {
    const result = await commandService.createGlobal(req.body || {});
    await auditStore.append({ requestId: req.requestId, action: "command.create", changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.delete("/api/commands/:commandName", wrap(async (req, res) => {
    const result = await commandService.deleteGlobal(req.params.commandName);
    await auditStore.append({ requestId: req.requestId, action: "command.delete", commandName: req.params.commandName, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.get("/api/bots/:id/commands", wrap(async (req, res) => sendSuccess(res, req, await commandService.listForBot(req.params.id))));
  app.put("/api/bots/:id/commands/:commandName", wrap(async (req, res) => {
    const result = await commandService.updateOverride(req.params.id, req.params.commandName, req.body || {});
    await auditStore.append({ requestId: req.requestId, action: "command.override.update", botId: req.params.id, commandName: req.params.commandName, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.delete("/api/bots/:id/commands/:commandName/override", wrap(async (req, res) => {
    const result = await commandService.deleteOverride(req.params.id, req.params.commandName);
    await auditStore.append({ requestId: req.requestId, action: "command.override.delete", botId: req.params.id, commandName: req.params.commandName, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.post("/api/bots/:id/commands/copy-from-admin", wrap(async (req, res) => {
    const result = await commandService.copyFromAdmin(req.params.id);
    await auditStore.append({ requestId: req.requestId, action: "command.copy-from-admin", botId: req.params.id, changedPaths: result.changedPaths });
    return sendSuccess(res, req, result.value, result);
  }));
  app.post("/api/commands/apply-all", wrap(async (req, res) => {
    const result = await commandService.applyAll(req.body || {});
    await auditStore.append({ requestId: req.requestId, action: "command.apply-all", commandName: req.body?.commandName, botIds: result.botIds });
    return sendSuccess(res, req, { botIds: result.botIds }, { restartRequired: true });
  }));
  app.post("/api/bots/:id/actions/promote-primary", wrap(async (req, res) => {
    const bot = await registry.describe(req.params.id);
    if (!bot) return sendError(res, req, 404, "BOT_NOT_FOUND", "Bot not found");
    const result = await roleRegistry.promotePrimary(req.params.id, {
      requestId: req.requestId,
      actor: req.body?.actor || req.body?.requestedBy || "dashboard",
    });
    return sendSuccess(res, req, result);
  }));

  registerV4ControlRoutes(app, {
    root,
    registry,
    configStore,
    auditStore,
    credentialService,
    prefixService,
    chatPolicyService,
    studioService,
    commandRegistry: options.commandRegistry || commandRegistry,
    qrSessionManager,
    adminRecoveryService,
    actions,
    getIo: options.getIo || (() => null),
  });

  registerV5DashboardRoutes(app, {
    root,
    registry,
    configStore,
    auditStore,
    prefixService,
    providerConfigService,
    studioService,
    commandRegistry: options.commandRegistry || commandRegistry,
    qrSessionManager,
    actions,
    getIo: options.getIo || (() => null),
  });
}

function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch((error) => {
    const code = error.code || "INTERNAL_ERROR";
    const status = error.status || 500;
    return sendError(res, req, status, code, error.message || "Unexpected error");
  });
}

function sparseBehaviorProfile(input) {
  const sparse = {};
  for (const group of COMMAND_BEHAVIOR_SCHEMA.groups) {
    for (const field of group.fields) {
      const value = getBehaviorPathValue(input, field.key);
      if (value === undefined) continue;
      setBehaviorPathValue(sparse, field.key, JSON.parse(JSON.stringify(value)));
    }
  }
  return sparse;
}

function findCommandEntry(doc, commandName) {
  return (Array.isArray(doc?.commands) ? doc.commands : []).find((entry) => entry.name === commandName) || null;
}

function getBehaviorPathValue(source, dottedPath) {
  return String(dottedPath).split(".").reduce((value, part) => (value && typeof value === "object" ? value[part] : undefined), source);
}

function setBehaviorPathValue(target, dottedPath, value) {
  const parts = String(dottedPath).split(".");
  let cursor = target;
  while (parts.length > 1) {
    cursor = cursor[parts.shift()] ||= {};
  }
  cursor[parts[0]] = value;
}

function wrapAction(actions, auditStore) {
  return wrap(async (req, res) => {
    const result = await runAction(actions, req.params.action, req.params.id, req.body || {});
    await auditStore.append({ requestId: req.requestId, action: `bots.${req.params.action}`, botId: req.params.id });
    return sendSuccess(res, req, result);
  });
}

async function runAction(actions, action, botId, payload = {}) {
  const fn = actions[action];
  if (!fn) throw actionError(503, "ACTION_UNAVAILABLE", `Action unavailable: ${action}`);
  return fn(botId, payload);
}

function hasAction(actions, action) {
  return ["start", "stop", "restart", "enable", "disable", "delete"].includes(action) && (typeof actions[action] === "function" || typeof actions.bulk === "function");
}

async function runBulkAction(actions, action, botIds, payload) {
  const results = [];
  for (const botId of [...new Set(botIds)]) {
    try { results.push({ botId, success: true, data: await runAction(actions, action, botId, payload) }); }
    catch (error) { results.push({ botId, success: false, error: { code: error.code || "ACTION_FAILED", message: error.message } }); }
  }
  return { action, results, partial: results.some((item) => !item.success) };
}

function normalizeBotIds(body = {}) {
  const values = Array.isArray(body.botIds) ? body.botIds : Array.isArray(body.ids) ? body.ids : [];
  return [...new Set(values.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

function actionError(status, code, message) {
  const error = new Error(message);
  Object.assign(error, { status, code });
  return error;
}

function assertSafeBotParam(botId) {
  if (typeof botId !== "string" || !botId.trim() || botId.includes("..") || /[\\/\0]/.test(botId) || !/^[a-zA-Z0-9._-]+$/.test(botId) || botId === "." || botId === "..") {
    throw actionError(400, "INVALID_BOT_ID", "Invalid bot id");
  }
}

async function resolveBotPath(bot, pathKey, root = process.cwd()) {
  assertSafeBotParam(String(bot?.id || ""));
  if (typeof pathKey !== "string" || !pathKey.trim() || pathKey.includes("..") || /[\\/\0]/.test(pathKey) || ["__proto__", "constructor", "prototype"].includes(pathKey)) {
    throw actionError(400, "INVALID_PATH_KEY", "Invalid config path key");
  }
  const pathsMap = bot?.paths && typeof bot.paths === "object" ? bot.paths : {};
  let candidate = null;
  if (Object.prototype.hasOwnProperty.call(pathsMap, pathKey)) {
    candidate = pathsMap[pathKey];
  } else if (Object.prototype.hasOwnProperty.call(pathsMap, pathKey.toLowerCase())) {
    candidate = pathsMap[pathKey.toLowerCase()];
  } else if (Object.prototype.hasOwnProperty.call(pathsMap, pathKey.toUpperCase())) {
    candidate = pathsMap[pathKey.toUpperCase()];
  } else if (Object.prototype.hasOwnProperty.call(bot, pathKey) && typeof bot[pathKey] === "string" && /(path|file)/i.test(pathKey)) {
    candidate = path.resolve(path.dirname(bot.botFile || bot.configPath || root), bot[pathKey]);
  }
  if (!candidate || typeof candidate !== "string") return null;
  const resolvedRoot = path.resolve(root);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  const resolved = path.resolve(resolvedRoot, candidate);
  if (!resolved.startsWith(rootPrefix)) {
    throw actionError(400, "INVALID_CONFIG_PATH", "Unsafe bot config path");
  }
  return resolved;
}

function publicChatPolicy(value) {
  return {
    botId: value.botId,
    groupEnabled: value.groupEnabled,
    privateEnabled: value.privateEnabled,
  };
}
