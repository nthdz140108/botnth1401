import fs from "node:fs/promises";
import path from "node:path";

const DEFAULTS = Object.freeze({
  webPort: "2000",
  webHost: "127.0.0.1",
});

export async function seedCleanInstall({ root = process.env.MYBOT_DATA_DIR || "/data/mybot", now = () => new Date().toISOString() } = {}) {
  const dataRoot = path.resolve(root);
  const timestamp = now();
  const dirs = [
    "bots",
    "state",
    "credentials",
    "logs",
    "sessions",
    "configs",
    "settings",
    "json-data",
    "workspaces",
    path.join("workspaces", "admin"),
    path.join("workspaces", "pending"),
    path.join("workspaces", "pending", "admin"),
    path.join("logs", "admin"),
    path.join("settings", "admin"),
    path.join("json-data", "admin"),
    path.join("resources"),
    path.join("resources", "gif"),
    path.join("temp"),
  ];

  for (const dir of dirs) {
    await fs.mkdir(path.join(dataRoot, dir), { recursive: true });
  }

  const roleRegistryPath = path.join(dataRoot, "role-registry.json");
  const myBotsPath = path.join(dataRoot, "mybots.json");
  const adminConfigPath = path.join(dataRoot, "bots", "admin.json");
  const adminStatePath = path.join(dataRoot, "state", "admin.json");
  const webConfigPath = path.join(dataRoot, "web-config.json");
  const managerPath = path.join(dataRoot, "manager.json");
  const commandPath = path.join(dataRoot, "json-data", "command-admin.json");
  const groupSettingsPath = path.join(dataRoot, "settings", "groupSettings-admin.json");
  const prophylacticPath = path.join(dataRoot, "json-data", "prophylactic.json");
  const dataGamePath = path.join(dataRoot, "json-data", "data-game.json");
  const adminWorkspaceManifest = path.join(dataRoot, "workspaces", "admin", "bootstrap.json");
  const pendingWorkspaceManifest = path.join(dataRoot, "workspaces", "pending", "admin", "bootstrap.json");
  const cleanInstallManifest = path.join(dataRoot, "state", "clean-install.json");

  const adminConfig = {
    name: "admin",
    displayName: "Admin Bot",
    webPort: DEFAULTS.webPort,
    webHost: DEFAULTS.webHost,
    status: "pending",
    enabled: true,
    database: "nthdz",
    bootstrapState: "pending",
    createdAt: timestamp,
    lastUpdated: timestamp,
    configFilePath: "mybot/bots/admin-credential.json",
    WEB_CONFIG_PATH: "mybot/web-config.json",
    MANAGER_FILE_PATH: "mybot/manager.json",
    groupSettingsPath: "mybot/settings/groupSettings-admin.json",
    commandFilePath: "mybot/json-data/command-admin.json",
    logDir: "mybot/logs/admin",
    resourceDir: "mybot/resources",
    tempDir: "mybot/temp",
    dataGifPath: "mybot/resources/gif",
    PROPHYLACTIC_CONFIG_PATH: "mybot/json-data/prophylactic.json",
    DATA_GAME_FILE_PATH: "mybot/json-data/data-game.json",
    workspacePath: "mybot/workspaces/admin",
    pendingWorkspacePath: "mybot/workspaces/pending/admin",
  };

  const adminState = {
    pid: null,
    status: "pending",
    bootstrapState: "pending",
    cookieDead: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    workspacePath: "mybot/workspaces/admin",
    pendingWorkspacePath: "mybot/workspaces/pending/admin",
  };

  const myBots = {
    admin: {
      name: "admin",
      displayName: "Admin Bot",
      status: "pending",
      enabled: true,
      database: "nthdz",
      webPort: DEFAULTS.webPort,
      webHost: DEFAULTS.webHost,
      bootstrapState: "pending",
      createdAt: timestamp,
      lastUpdated: timestamp,
      workspacePath: "mybot/workspaces/admin",
      pendingWorkspacePath: "mybot/workspaces/pending/admin",
    },
  };

  await writeJsonIfMissing(roleRegistryPath, {
    schemaVersion: 1,
    primaryBotId: null,
    previousPrimaryBotId: null,
    promotedAt: null,
    updatedAt: timestamp,
    transaction: null,
  });
  await writeJsonIfMissing(myBotsPath, myBots);
  await writeJsonIfMissing(adminConfigPath, adminConfig);
  await writeJsonIfMissing(adminStatePath, adminState);
  await writeJsonIfMissing(webConfigPath, { selectedGroups: {}, selectedFriends: {} });
  await writeJsonIfMissing(managerPath, { onBotPrivate: true });
  await writeJsonIfMissing(commandPath, { prefix: "!", commands: [] });
  await writeJsonIfMissing(groupSettingsPath, {});
  await writeJsonIfMissing(prophylacticPath, {
    prophylacticUploadAttachment: { enable: false, lastBlocked: "", numRequestZalo: 0 },
  });
  await writeJsonIfMissing(dataGamePath, {});
  await writeJsonIfMissing(adminWorkspaceManifest, {
    botId: "admin",
    workspace: "admin",
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    source: "clean-install",
  });
  await writeJsonIfMissing(pendingWorkspaceManifest, {
    botId: "admin",
    workspace: "pending/admin",
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    source: "clean-install",
  });
  await writeJsonIfMissing(cleanInstallManifest, {
    createdAt: timestamp,
    root: dataRoot,
    roleRegistryPath: path.relative(dataRoot, roleRegistryPath),
    myBotsPath: path.relative(dataRoot, myBotsPath),
    adminConfigPath: path.relative(dataRoot, adminConfigPath),
    adminStatePath: path.relative(dataRoot, adminStatePath),
    workspacePaths: [
      path.relative(dataRoot, adminWorkspaceManifest),
      path.relative(dataRoot, pendingWorkspaceManifest),
    ],
  });

  return {
    root: dataRoot,
    createdAt: timestamp,
    paths: {
      roleRegistryPath,
      myBotsPath,
      adminConfigPath,
      adminStatePath,
      webConfigPath,
      managerPath,
      commandPath,
      groupSettingsPath,
      prophylacticPath,
      dataGamePath,
      adminWorkspaceManifest,
      pendingWorkspaceManifest,
      cleanInstallManifest,
    },
  };
}

async function writeJsonIfMissing(filePath, value) {
  try {
    await fs.access(filePath);
    return false;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temp, filePath);
  return true;
}
