export const COMMAND_STATE_KEYS = Object.freeze(["active", "permission", "countdown", "alias"]);

function normalizeCommandKey(value) {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

function pickCommandState(entry) {
  if (!entry || typeof entry !== "object") return null;
  const state = {};
  for (const key of COMMAND_STATE_KEYS) {
    if (entry[key] !== undefined) state[key] = entry[key];
  }
  return Object.keys(state).length > 0 ? state : null;
}

export function extractCommandState(commands) {
  const stateByName = new Map();
  for (const entry of Array.isArray(commands) ? commands : []) {
    if (!entry || typeof entry !== "object") continue;
    const name = normalizeCommandKey(entry.name ?? entry.command);
    if (!name) continue;
    const state = pickCommandState(entry);
    if (state) stateByName.set(name, state);
  }
  return stateByName;
}

export function composeRuntimeCommandConfig({ catalog, runtimeFile } = {}) {
  const safeCatalog = catalog && typeof catalog === "object" ? catalog : {};
  const safeRuntimeFile = runtimeFile && typeof runtimeFile === "object" && !Array.isArray(runtimeFile)
    ? runtimeFile
    : {};
  const catalogCommands = Array.isArray(safeCatalog.commands) ? safeCatalog.commands : [];
  const stateByName = extractCommandState(safeRuntimeFile.commands);

  const commands = catalogCommands.map((command) => {
    if (!command || typeof command !== "object") return command;
    const state = stateByName.get(normalizeCommandKey(command.name));
    const composed = state ? { ...command, ...state } : { ...command };
    composed.active = composed.active !== false;
    return composed;
  });

  const prefix = typeof safeRuntimeFile.prefix === "string" && safeRuntimeFile.prefix.trim()
    ? safeRuntimeFile.prefix
    : typeof safeCatalog.prefix === "string" && safeCatalog.prefix.trim()
      ? safeCatalog.prefix
      : "!";

  return {
    prefix,
    commands,
  };
}

export function createCommandSeedStub(prefix = "!") {
  return {
    prefix,
    commands: [],
  };
}

function isSameStateValue(key, left, right) {
  if (key === "active") return (left !== false) === (right !== false);
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function toStateOnlyCommandConfig(config = {}, { catalog } = {}) {
  const safeConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const prefix = typeof safeConfig.prefix === "string" && safeConfig.prefix.trim() ? safeConfig.prefix : "!";
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.commands)) {
    const stateByName = extractCommandState(safeConfig.commands);
    const commands = [...stateByName.entries()].map(([name, state]) => ({ name, ...state }));
    return { prefix, commands };
  }

  const catalogByName = new Map();
  for (const entry of catalog.commands) {
    if (entry && typeof entry === "object" && entry.name) {
      catalogByName.set(normalizeCommandKey(entry.name), entry);
    }
  }

  const commands = [];
  for (const entry of Array.isArray(safeConfig.commands) ? safeConfig.commands : []) {
    if (!entry || typeof entry !== "object" || !entry.name) continue;
    const name = normalizeCommandKey(entry.name);
    const catalogEntry = catalogByName.get(name);
    if (!catalogEntry) continue;
    const state = {};
    for (const key of COMMAND_STATE_KEYS) {
      if (entry[key] === undefined) continue;
      if (!isSameStateValue(key, entry[key], catalogEntry[key])) {
        state[key] = entry[key];
      }
    }
    if (Object.keys(state).length > 0) {
      commands.push({ name, ...state });
    }
  }
  return { prefix, commands };
}
