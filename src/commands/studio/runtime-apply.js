import { getCommandStudioContract } from "./contracts.js";
import { resolveCommandConfigSync } from "./config-resolver.js";
import { applySecretsToEnv } from "./behavior-bridge.js";
import { getOrCreateSendtaskSchedulerManager } from "../../service-debug/scheduler/sendtask-scheduler-manager.js";

export function buildSendtaskSchedulesFromStudio({ root = process.env.PROJECT_ROOT || process.cwd(), botId }) {
  const contract = getCommandStudioContract("sendtask");
  if (!contract) throw new Error("sendtask studio contract missing");
  const resolved = resolveCommandConfigSync({ root, commandName: "sendtask", contract, botId });
  const effective = resolved.effective;
  const rows = Array.isArray(effective["schedules.items"]) ? effective["schedules.items"] : [];
  const fallbackQuery = effective["sources.tiktokQueryFallback"] || "nhạc chill cảnh đẹp {{timestamp}}";
  const defaultTimezone = effective["schedules.timezone"] || "Asia/Ho_Chi_Minh";
  const schedules = rows
    .filter((row) => row && typeof row === "object" && row.enabled !== false)
    .map((row) => {
      // Fallback mặc định girl-video/default; chuỗi rỗng = người dùng chủ động tắt fallback
      const hasExplicitFallbackKind = typeof row.fallbackKind === "string";
      return {
        id: row.id,
        cron: row.cron,
        timezone: row.timezone || defaultTimezone,
        kind: row.kind,
        category: row.category || "default",
        queryTemplate: row.queryTemplate || fallbackQuery,
        caption: row.caption || "",
        ttlMinutes: Number(row.ttlMinutes) > 0 ? Number(row.ttlMinutes) : 60,
        fallbackKind: hasExplicitFallbackKind ? row.fallbackKind : "girl-video",
        fallbackCategory: row.fallbackCategory || (hasExplicitFallbackKind ? "" : "default"),
      };
    });
  return {
    schedules,
    schedulerEnabled: effective["schedules.enabled"] !== false,
    retry: {
      maxRetries: Number.isFinite(effective["operation.retry.maxRetries"]) ? effective["operation.retry.maxRetries"] : 2,
      backoffMs: Number.isFinite(effective["operation.retry.backoffMs"]) ? effective["operation.retry.backoffMs"] : 1500,
    },
    provenance: resolved.provenance,
  };
}

export function createStudioRuntimeApplier({ root = process.env.PROJECT_ROOT || process.cwd(), getBotId, initializeSchedulerFn } = {}) {
  return async function applyStudioCommand(request = {}) {
    const commandName = String(request.commandName || "").toLowerCase();
    if (!commandName) throw new Error("commandName is required for command-studio reload");
    const appliedSecrets = [];
    try {
      const contract = getCommandStudioContract(commandName);
      if (!contract) throw new Error(`No studio contract for ${commandName}`);
      let scheduleSummary = null;
      if (contract.adapter === "sendtask-scheduler") {
        if (typeof initializeSchedulerFn !== "function") throw new Error("initializeScheduler dependency unavailable");
        const studio = buildSendtaskSchedulesFromStudio({ root, botId: request.botId || getBotId?.() });
        if (studio.schedulerEnabled) {
          // Reload tái sử dụng manager hiện có (get-or-create) và sync diff,
          // không tạo bộ job thứ hai.
          const init = await initializeSchedulerFn({ schedules: studio.schedules, retry: studio.retry });
          scheduleSummary = init.result;
        } else {
          // Scheduler bị tắt: hủy toàn bộ job đang chạy trên manager hiện có.
          const manager = getOrCreateSendtaskSchedulerManager();
          scheduleSummary = await manager.sync([]);
        }
      }
      const secrets = collectSecretValues(contract, request.values || {});
      appliedSecrets.push(...applySecretsToEnv(secrets));
      return { ok: true, commandName, revision: request.revision ?? null, scheduleSummary };
    } catch (error) {
      const failure = new Error(error.message);
      failure.commandName = commandName;
      throw failure;
    }
  };
}

function collectSecretValues(contract, values) {
  const secrets = {};
  for (const tab of contract.tabs) {
    for (const field of tab.fields) {
      if (field.key.startsWith("secrets.") && typeof values[field.key] === "string" && values[field.key]) {
        secrets[field.key] = values[field.key];
      }
    }
  }
  return secrets;
}
