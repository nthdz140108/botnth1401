const SPECIAL_COMMANDS = Object.freeze(["todo", "learnnow", "sendp"]);

export function parseCommandContent(content, prefix) {
  if (typeof content !== "string" || typeof prefix !== "string") return null;
  const normalizedContent = content.trimStart();
  const comparableContent = normalizedContent.toLowerCase();
  const comparablePrefix = prefix.toLowerCase();
  if (!comparableContent.startsWith(comparablePrefix)) return null;

  const isSpecial = SPECIAL_COMMANDS.some((command) => {
    const specialPrefix = `${comparablePrefix}${command}`;
    return comparableContent === specialPrefix || comparableContent.startsWith(`${specialPrefix}_`);
  });
  const commandParts = isSpecial
    ? normalizedContent.split("_")
    : normalizedContent.slice(prefix.length).trim().split(/\s+/);
  const command = isSpecial
    ? commandParts[0].slice(prefix.length).toLowerCase()
    : commandParts[0].toLowerCase();

  return { command, commandParts };
}

export { SPECIAL_COMMANDS };
