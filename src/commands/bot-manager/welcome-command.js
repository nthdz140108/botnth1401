const SETTING_BY_COMMAND = Object.freeze({
  welcome: "welcomeGroup",
  wl: "welcomeGroup",
  wlc: "welcomeGroup",
  bye: "byeGroup",
  updategroup: "updateGroup",
});

export function getWelcomeSettingKey(commandName, prefix = "") {
  let normalized = String(commandName ?? "").trim().toLowerCase();
  const normalizedPrefix = String(prefix ?? "").trim().toLowerCase();

  if (normalizedPrefix && normalized.startsWith(normalizedPrefix)) {
    normalized = normalized.slice(normalizedPrefix.length);
  }

  return SETTING_BY_COMMAND[normalized] ?? null;
}
