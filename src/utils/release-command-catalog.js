import defaults from "./release-command-defaults.js";

// Versioned deployments keep assets/mybot in shared storage. Ship additive
// command metadata as release code so an update never overwrites live settings.
export function withReleaseCommandDefaults(catalog = {}, env = process.env) {
  if (!env.MYBOT_CODE_COMMIT) return catalog;
  const commands = Array.isArray(catalog.commands) ? catalog.commands : [];
  const names = new Set(commands.map((command) => String(command?.name || "").trim().toLowerCase()));
  const additions = defaults.filter((command) => !names.has(command.name));
  return { ...catalog, commands: [...commands, ...structuredClone(additions)] };
}
