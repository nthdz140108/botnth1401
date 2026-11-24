function run(initializers, names) {
  names.forEach((name) => initializers[name]?.());
}

export function initBotsWorkspace(initializers) {
  run(initializers, ["initBotManagementPage", "initBotControlButtons", "initRunningBotsPage"]);
}

if (typeof window !== "undefined") window.MYBOT_WORKSPACES = { ...window.MYBOT_WORKSPACES, initBotsWorkspace };
