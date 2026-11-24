/**
 * Runtime exit guard.
 *
 * Isolates Main-bot status updates from child-bot processes. The child launcher
 * and each child bot process share the same project root, so an unconditional
 * `updateAdminBotStatus("stopped")` on a child's exit would wrongly flip the
 * Main bot record to "stopped". This guard decides whether the current process
 * is allowed to update the Main bot status on exit.
 *
 * - Only a process whose runtime descriptor says it IS the main instance may
 *   update the Main bot status.
 * - Child processes (MYBOT_INSTANCE_KIND=child or descriptor.isChild) must
 *   update ONLY their own instance record, never the Main bot.
 */
export function shouldUpdateMainStatusOnExit(descriptor = null) {
  if (descriptor && typeof descriptor === "object") {
    if (descriptor.isChild === true) return false;
    if (descriptor.isMain === true) return true;
  }
  const envKind = String(process.env.MYBOT_INSTANCE_KIND || "").trim().toLowerCase();
  if (envKind === "child") return false;
  if (envKind === "main") return true;
  // Default to main-safety: without a descriptor claiming Main, do not touch
  // the Main bot status (fail-closed).
  return false;
}

/**
 * Resolve the instance record key that THIS process is allowed to update on exit.
 * Returns "admin" for the Main process, the child bot key for child processes,
 * and null when we cannot determine ownership (caller should skip the update).
 */
export function resolveExitStatusOwner({ descriptor = null, botKey = "" } = {}) {
  if (descriptor && typeof descriptor === "object") {
    if (descriptor.isChild === true) {
      return String(descriptor.botKey || botKey || "child").trim();
    }
    if (descriptor.isMain === true) return "admin";
  }
  const envKind = String(process.env.MYBOT_INSTANCE_KIND || "").trim().toLowerCase();
  if (envKind === "child") return String(process.env.BOT_KEY || process.env.BOT_NAME || process.env.BOT_UID || botKey || "child").trim();
  if (envKind === "main") return "admin";
  const envKey = String(process.env.BOT_KEY || process.env.BOT_NAME || process.env.BOT_UID || "").trim();
  if (envKey && envKey.toLowerCase() !== "admin") return envKey;
  return null;
}
