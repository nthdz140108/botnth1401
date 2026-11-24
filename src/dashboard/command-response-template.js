const KNOWN_VARS = new Set(["prefix", "command", "user", "userId", "thread", "remaining", "reason"]);

export function renderTemplate(template, vars = {}) {
  if (typeof template !== "string" || template.trim() === "") return null;
  return template.replace(/\{([a-zA-Z]+)(?::([a-zA-Z0-9_-]+))?\}/g, (match, name, paramKey) => {
    if (name === "param") {
      if (!paramKey) return "";
      const value = vars.params?.[paramKey];
      return value === undefined || value === null ? "" : String(value);
    }
    if (!KNOWN_VARS.has(name)) return match;
    const value = vars[name];
    return value === undefined || value === null ? "" : String(value);
  });
}
