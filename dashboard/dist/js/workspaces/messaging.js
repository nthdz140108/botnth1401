function run(initializers, names) {
  names.forEach((name) => initializers[name]?.());
}

export function initMessagingWorkspace(initializers) {
  run(initializers, ["initSendButtons", "initRecentMessagesPage"]);
}

if (typeof window !== "undefined") window.MYBOT_WORKSPACES = { ...window.MYBOT_WORKSPACES, initMessagingWorkspace };
