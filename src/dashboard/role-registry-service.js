import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STATE = Object.freeze({
  schemaVersion: 1,
  adminBotId: "admin",
  primaryBotId: null,
  previousPrimaryBotId: null,
  promotedAt: null,
  updatedAt: null,
  transaction: null,
});

export class RoleRegistryService {
  constructor({ root = process.cwd(), registry, configStore, auditStore = null, actions = null } = {}) {
    if (!registry) throw new Error("registry is required");
    if (!configStore) throw new Error("configStore is required");
    this.root = path.resolve(root);
    this.registry = registry;
    this.configStore = configStore;
    this.auditStore = auditStore;
    this.actions = actions;
    this.filePath = path.join(this.root, "mybot", "role-registry.json");
    this.lockPath = `${this.filePath}.lock`;
  }

  async read() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return normalizeState(data);
    } catch (error) {
      if (error.code === "ENOENT") return { ...DEFAULT_STATE };
      throw error;
    }
  }

  async swapAdminBot(targetBotId, { requestId = null, actor = "dashboard", confirm = false } = {}) {
    if (!confirm) {
      const error = new Error("Swap confirmation required");
      error.status = 400;
      error.code = "SWAP_CONFIRMATION_REQUIRED";
      throw error;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const lock = await acquireLock(this.lockPath);
    const now = new Date().toISOString();
    const transactionId = randomUUID();
    let snapshot = null;

    try {
      snapshot = await this.read();
      const currentAdminBotId = snapshot.adminBotId || snapshot.primaryBotId || "admin";
      if (targetBotId === currentAdminBotId) {
        const error = new Error("Target bot is already the admin bot");
        error.status = 409;
        error.code = "SAME_BOT";
        throw error;
      }
      if (snapshot.transaction?.status === "in-progress") {
        const error = new Error("Role swap already in progress");
        error.status = 409;
        error.code = "ROLE_SWAP_IN_PROGRESS";
        throw error;
      }

      await this.validateCandidate(targetBotId, currentAdminBotId);
      const inProgress = {
        ...snapshot,
        adminBotId: currentAdminBotId,
        primaryBotId: targetBotId,
        previousAdminBotId: currentAdminBotId,
        updatedAt: now,
        transaction: {
          id: transactionId,
          status: "in-progress",
          targetBotId,
          previousAdminBotId: currentAdminBotId,
          previousPrimaryBotId: snapshot.primaryBotId || currentAdminBotId,
          requestId,
          actor,
          startedAt: now,
        },
      };
      await this.configStore.writeJson(this.filePath, inProgress);

      const restartedBots = [];
      try {
        if (currentAdminBotId && this.actions?.restart) {
          const restartAdmin = await this.actions.restart(currentAdminBotId);
          if (restartAdmin === false) throw new Error(`Unable to restart ${currentAdminBotId}`);
          restartedBots.push(currentAdminBotId);
        }
        if (this.actions?.restart) {
          const restartTarget = await this.actions.restart(targetBotId);
          if (restartTarget === false) throw new Error(`Unable to restart ${targetBotId}`);
          restartedBots.push(targetBotId);
        }

        const [oldAdmin, newAdmin] = await Promise.all([
          this.registry.describe(currentAdminBotId),
          this.registry.describe(targetBotId),
        ]);
        if (!oldAdmin || !newAdmin || oldAdmin.connected === false || newAdmin.connected === false) {
          const error = new Error("One or more bots failed health check after restart");
          error.status = 409;
          error.code = "BOT_UNHEALTHY";
          throw error;
        }

        const committed = {
          schemaVersion: 1,
          adminBotId: targetBotId,
          primaryBotId: targetBotId,
          previousAdminBotId: currentAdminBotId,
          previousPrimaryBotId: snapshot.primaryBotId || currentAdminBotId,
          promotedAt: now,
          updatedAt: now,
          transaction: {
            id: transactionId,
            status: "committed",
            targetBotId,
            previousAdminBotId: currentAdminBotId,
            previousPrimaryBotId: snapshot.primaryBotId || currentAdminBotId,
            restartedBots,
            requestId,
            actor,
            startedAt: now,
            completedAt: now,
          },
        };
        const result = await this.configStore.writeJson(this.filePath, committed);
        await this.auditStore?.append?.({
          action: "system.swap-admin-bot",
          actor,
          requestId,
          transactionId,
          previousAdminBotId: currentAdminBotId,
          adminBotId: targetBotId,
        });
        return result.value;
      } catch (error) {
        const restoredSnapshot = {
          ...snapshot,
          transaction: snapshot?.transaction?.status === "in-progress" ? null : (snapshot?.transaction || null),
        };
        try {
          await this.configStore.writeJson(this.filePath, restoredSnapshot);
        } catch (rollbackError) {
          error.rollbackError = rollbackError.message;
          try {
            await fs.writeFile(this.filePath, `${JSON.stringify(restoredSnapshot, null, 2)}\n`, "utf8");
          } catch {}
        }
        if (currentAdminBotId && currentAdminBotId !== targetBotId && restartedBots.includes(currentAdminBotId) && this.actions?.restart) {
          try {
            await this.actions.restart(currentAdminBotId);
          } catch (restartError) {
            error.rollbackAdminError = restartError.message;
          }
        }
        throw error;
      }
    } finally {
      await releaseLock(lock);
    }
  }

  async promotePrimary(botId, { requestId = null, actor = "dashboard" } = {}) {
    const candidate = await this.registry.describe(botId);
    if (!candidate) {
      const error = new Error("Bot not found");
      error.status = 404;
      error.code = "BOT_NOT_FOUND";
      throw error;
    }
    if (candidate.enabled === false || candidate.status === "disabled") {
      const error = new Error("Bot is disabled");
      error.status = 409;
      error.code = "BOT_DISABLED";
      throw error;
    }
    if (candidate.connected === false) {
      const error = new Error("Bot health check failed");
      error.status = 409;
      error.code = "BOT_UNHEALTHY";
      throw error;
    }
    if (candidate.credential?.state && candidate.credential.state !== "configured") {
      const error = new Error("Bot credential is missing");
      error.status = 409;
      error.code = "BOT_CREDENTIAL_MISSING";
      throw error;
    }
    if (["error", "credential_dead"].includes(String(candidate.status || "").toLowerCase())) {
      const error = new Error("Bot health check failed");
      error.status = 409;
      error.code = "BOT_UNHEALTHY";
      throw error;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const lock = await acquireLock(this.lockPath);
    let snapshot = null;
    const now = new Date().toISOString();
    const transactionId = randomUUID();

    try {
      snapshot = await this.read();
      if (snapshot.primaryBotId === botId) {
        return {
          ...snapshot,
          transaction: {
            id: transactionId,
            status: "noop",
            botId,
            requestId,
            actor,
            startedAt: now,
            completedAt: now,
          },
        };
      }

      const inProgress = {
        ...snapshot,
        transaction: {
          id: transactionId,
          status: "in-progress",
          botId,
          previousPrimaryBotId: snapshot.primaryBotId || null,
          requestId,
          actor,
          startedAt: now,
        },
        updatedAt: now,
      };
      await this.configStore.writeJson(this.filePath, inProgress);

      const previousPrimaryBotId = snapshot.primaryBotId || null;
      if (previousPrimaryBotId && previousPrimaryBotId !== botId && this.actions?.stop) {
        await this.actions.stop(previousPrimaryBotId);
      }
      if (this.actions?.start) {
        const started = await this.actions.start(botId);
        if (started === false) throw new Error("Unable to start promoted primary bot");
      }

      const promoted = await this.registry.describe(botId);
      if (!promoted || promoted.enabled === false || promoted.status === "disabled" || promoted.connected === false) {
        throw new Error("Promoted primary bot is not healthy");
      }

      const completed = {
        schemaVersion: 1,
        primaryBotId: botId,
        previousPrimaryBotId,
        promotedAt: now,
        updatedAt: now,
        transaction: {
          id: transactionId,
          status: "committed",
          botId,
          previousPrimaryBotId,
          requestId,
          actor,
          startedAt: now,
          completedAt: now,
        },
      };
      const result = await this.configStore.writeJson(this.filePath, completed);
      await this.auditStore?.append?.({
        action: "system.promote-primary",
        botId,
        previousPrimaryBotId: snapshot.primaryBotId || null,
        requestId,
        actor,
        transactionId,
      });
      return result.value;
    } catch (error) {
      if (snapshot) {
        try {
          await this.configStore.writeJson(this.filePath, snapshot);
        } catch (rollbackError) {
          error.rollbackError = rollbackError.message;
        }
      }
      if (snapshot?.primaryBotId && snapshot.primaryBotId !== botId && this.actions?.start) {
        try {
          await this.actions.start(snapshot.primaryBotId);
        } catch (restartError) {
          error.rollbackPrimaryError = restartError.message;
        }
      }
      throw error;
    } finally {
      await releaseLock(lock);
    }
  }

  async validateCandidate(botId, currentAdminBotId) {
    const candidate = await this.registry.describe(botId);
    if (!candidate) {
      const error = new Error("Bot not found");
      error.status = 404;
      error.code = "BOT_NOT_FOUND";
      throw error;
    }
    if (botId === currentAdminBotId) {
      const error = new Error("Target bot is already the admin bot");
      error.status = 409;
      error.code = "SAME_BOT";
      throw error;
    }
    if (candidate.enabled === false || candidate.status === "disabled") {
      const error = new Error("Bot is disabled");
      error.status = 409;
      error.code = "BOT_DISABLED";
      throw error;
    }
    if (candidate.credential?.state && candidate.credential.state !== "configured") {
      const error = new Error("Bot credential is missing");
      error.status = 409;
      error.code = "BOT_CREDENTIAL_MISSING";
      throw error;
    }
    if (candidate.connected === false || ["error", "credential_dead"].includes(String(candidate.status || "").toLowerCase())) {
      const error = new Error("Bot health check failed");
      error.status = 409;
      error.code = "BOT_UNHEALTHY";
      throw error;
    }
    return candidate;
  }
}

export async function readRoleRegistry(filePath) {
  try {
    const data = JSON.parse(await fs.readFile(filePath, "utf8"));
    return normalizeState(data);
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULT_STATE };
    throw error;
  }
}

async function acquireLock(lockPath) {
  try {
    const handle = await fs.open(lockPath, "wx");
    return { handle, lockPath };
  } catch (error) {
    if (error.code === "EEXIST") {
      const lockError = new Error("Role registry is locked");
      lockError.status = 409;
      lockError.code = "ROLE_REGISTRY_LOCKED";
      throw lockError;
    }
    throw error;
  }
}

async function releaseLock(lock) {
  if (!lock) return;
  try {
    await lock.handle.close();
  } catch {}
  try {
    await fs.unlink(lock.lockPath);
  } catch {}
}

function normalizeState(value = {}) {
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    adminBotId: typeof value.adminBotId === "string" ? value.adminBotId : (typeof value.primaryBotId === "string" ? value.primaryBotId : "admin"),
    primaryBotId: typeof value.primaryBotId === "string" ? value.primaryBotId : null,
    previousPrimaryBotId: typeof value.previousPrimaryBotId === "string" ? value.previousPrimaryBotId : null,
    promotedAt: value.promotedAt || null,
    updatedAt: value.updatedAt || null,
    transaction: value.transaction && typeof value.transaction === "object" ? value.transaction : null,
  };
}
