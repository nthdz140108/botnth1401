function run(initializers, names) {
  names.forEach((name) => initializers[name]?.());
}

export function initAutomationWorkspace(initializers) {
  run(initializers, ["initCommandSearch", "initCommandFilter", "initAutoReplyPage", "initChatSettings"]);
}

if (typeof window !== "undefined") window.MYBOT_WORKSPACES = { ...window.MYBOT_WORKSPACES, initAutomationWorkspace };
