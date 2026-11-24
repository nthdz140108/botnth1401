export async function performRuntimeReload(request = {}, dependencies = {}) {
  const reloadType = request.reloadType || "credential";

  if (reloadType === "command-studio") {
    if (typeof dependencies.applyStudioCommand !== "function") {
      throw new Error("applyStudioCommand dependency is required for command-studio reload");
    }
    try {
      const result = await dependencies.applyStudioCommand(request);
      const nextState = {
        uid: request.uid || "",
        requestId: request.requestId || "",
        reloadType,
        commandName: request.commandName || null,
        revision: request.revision ?? null,
        scope: request.scope || "global",
        status: "ready",
        result: result?.scheduleSummary ? { scheduleSummary: result.scheduleSummary } : null,
        completedAt: new Date().toISOString(),
        error: null,
      };
      if (typeof dependencies.writeReloadState === "function") {
        return dependencies.writeReloadState(request.uid || "", nextState);
      }
      return nextState;
    } catch (error) {
      const failedState = {
        uid: request.uid || "",
        requestId: request.requestId || "",
        reloadType,
        commandName: request.commandName || null,
        revision: request.revision ?? null,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message,
      };
      if (typeof dependencies.writeReloadState === "function") {
        return dependencies.writeReloadState(request.uid || "", failedState);
      }
      throw error;
    }
  }

  if (reloadType !== "command-config") {
    return {
      uid: request.uid || "",
      requestId: request.requestId || "",
      status: "ignored",
      reloadType,
    };
  }

  if (typeof dependencies.reloadCommandConfig !== "function") {
    throw new Error("reloadCommandConfig dependency is required");
  }

  const commandConfig = dependencies.reloadCommandConfig() || {};
  const nextPrefix = typeof commandConfig.prefix === "string" && commandConfig.prefix.trim()
    ? commandConfig.prefix
    : "!";

  if (typeof dependencies.setGlobalPrefix === "function") {
    dependencies.setGlobalPrefix(nextPrefix);
  }

  const nextState = {
    uid: request.uid || "",
    requestId: request.requestId || "",
    reloadType,
    status: "ready",
    prefix: nextPrefix,
    completedAt: new Date().toISOString(),
    error: null,
  };

  if (typeof dependencies.writeReloadState === "function") {
    return dependencies.writeReloadState(request.uid || "", nextState);
  }

  return nextState;
}
