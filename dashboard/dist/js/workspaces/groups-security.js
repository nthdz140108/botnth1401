function run(initializers, names) {
  names.forEach((name) => initializers[name]?.());
}

export function initGroupsSecurityWorkspace(initializers) {
  run(initializers, ["initSaveGroupSettingsBtn", "initAdminManagement", "initScanGroups", "initMutePage", "initWhitelistPage", "initAntiPage", "initBlockListPage"]);
}

if (typeof window !== "undefined") window.MYBOT_WORKSPACES = { ...window.MYBOT_WORKSPACES, initGroupsSecurityWorkspace };
