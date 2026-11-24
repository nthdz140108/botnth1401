import { normalizeCommandName, isValidCustomName, isReservedCustomName, RESERVED_SUBCOMMANDS } from "./store.js";

export const PARSE_CREATE = "create";
export const PARSE_LIST = "list";
export const PARSE_REMOVE = "remove";
export const PARSE_INVALID = "invalid";

export function parseCmdaddInput(input) {
  if (typeof input !== "string") return { kind: PARSE_INVALID, reason: "EMPTY" };
  const trimmed = input.trim();
  if (!trimmed) return { kind: PARSE_INVALID, reason: "EMPTY" };

  const parts = trimmed.split(/\s+/);
  const first = normalizeCommandName(parts[0]);
  if (!first) return { kind: PARSE_INVALID, reason: "EMPTY" };

  if (first === "list") {
    return {
      kind: PARSE_LIST,
      page: parsePage(parts[1]),
      raw: trimmed,
    };
  }

  if (first === "remove") {
    const target = parts[1];
    if (!target) return { kind: PARSE_INVALID, reason: "REMOVE_MISSING_TARGET" };
    return { kind: PARSE_REMOVE, target: normalizeCommandName(target), raw: trimmed };
  }

  if (RESERVED_SUBCOMMANDS.includes(first)) {
    return { kind: PARSE_INVALID, reason: "RESERVED_SUBCOMMAND" };
  }

  // Split at the first "|" separator; text before is the name, text after is content.
  const pipeIndex = trimmed.indexOf("|");
  const name = normalizeCommandName(pipeIndex === -1 ? trimmed : trimmed.slice(0, pipeIndex));
  const text = pipeIndex === -1 ? "" : trimmed.slice(pipeIndex + 1).trim();

  if (!isValidCustomName(name)) {
    return { kind: PARSE_INVALID, reason: "INVALID_NAME" };
  }
  if (isReservedCustomName(name)) {
    return { kind: PARSE_INVALID, reason: "RESERVED_NAME" };
  }
  if (pipeIndex === -1) {
    return { kind: PARSE_INVALID, reason: "MISSING_TEXT", name };
  }
  if (!text) {
    return { kind: PARSE_INVALID, reason: "EMPTY_TEXT", name };
  }

  return {
    kind: PARSE_CREATE,
    name,
    text,
    raw: trimmed,
  };
}

function parsePage(value) {
  const parsed = parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}
