import { normalizeName, findCustomCommand, isReservedCustomName } from "./store.js";

export function resolveCommandPartsToCustom(registryMatch, commandParts, root) {
  if (registryMatch.code !== "UNKNOWN_COMMAND") return null;
  if (!commandParts || commandParts.length === 0) return null;

  const name = normalizeName(commandParts[0]);
  if (!name) return null;
  if (isReservedCustomName(name)) return null;
  if (name === "cmdadd") return null;

  const command = findCustomCommand(name, root);
  if (!command) return null;
  if (command.conflict) return null;

  return {
    code: "RESOLVED_CUSTOM",
    definition: null,
    custom: command,
    args: commandParts.slice(1),
    matchedParts: [name],
    commandParts,
  };
}

export function isCustomCommandInvocation(registryMatch, commandParts, root) {
  return resolveCommandPartsToCustom(registryMatch, commandParts, root) !== null;
}
