import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBotRuntimeContext,
} from "../src/utils/bot-runtime-context.js";
import { createBotConfig } from "../src/commands/mybot/System/pm2-manager.js";
import { createAllRequiredFilesWithCredentials } from "../src/commands/mybot/Manager/qr-login-command.js";
import { resetCache as resetEnvCache } from "../src/utils/env.js";

test("createAllRequiredFilesWithCredentials creates required directories and files for child bot without ReferenceError", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-prov-child-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });

  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    const childUid = "child-bot-uid-999";
    const ownerUid = "owner-uid-111";
    const botConfig = createBotConfig(childUid, 4567);
    const credentialsData = {
      cookie: { zpw_sek: "child_sek_val", zpw_version: 1 },
      imei: "child-imei-12345",
      name: "Child Bot Test",
      avatar: "https://example.com/avatar.png",
      userAgent: "Mozilla/5.0 ChildBot",
      uid: ownerUid, // owner / creator UID seeds the admin list
    };

    await createAllRequiredFilesWithCredentials(childUid, credentialsData, botConfig);

    // 1. Check legacy admin file exists and contains ONLY the child bot UID.
    // The owner/creator UID observed from the Main session is NOT a valid local
    // UID in the child session, so it must not be copied into the admin list
    // (fail-closed: only verified local identities are Supreme Admins).
    const legacyAdminPath = path.join(root, botConfig.adminFilePath);
    assert.equal(await fs.access(legacyAdminPath).then(() => true).catch(() => false), true, "Legacy admin file must exist");
    const legacyAdmins = JSON.parse(await fs.readFile(legacyAdminPath, "utf8"));
    assert.deepEqual(legacyAdmins.sort(), [childUid].sort(), "Child legacy admins must be [childUid] only (no foreign owner UID)");
    assert.equal(legacyAdmins.includes(ownerUid), false, "Owner UID from Main session must NOT be seeded");

    // 2. Check runtimeContext adminListPath exists and contains ONLY the child UID
    const runtimeContext = createBotRuntimeContext({ uid: childUid, ...botConfig });
    assert.equal(await fs.access(runtimeContext.adminListPath).then(() => true).catch(() => false), true, "Runtime admin file must exist");
    const runtimeAdmins = JSON.parse(await fs.readFile(runtimeContext.adminListPath, "utf8"));
    assert.deepEqual(runtimeAdmins.sort(), [childUid].sort(), "Child runtime admins must be [childUid] only (no foreign owner UID)");

    // 3. Check credential file
    const credPath = path.join(root, botConfig.configFilePath);
    assert.equal(await fs.access(credPath).then(() => true).catch(() => false), true, "Credential file must exist");
    const savedCred = JSON.parse(await fs.readFile(credPath, "utf8"));
    assert.equal(savedCred.imei, "child-imei-12345");

    // 4. Check bot config in mybot/bots
    const botConfigPath = path.join(root, "mybot", "bots", `${childUid}.json`);
    assert.equal(await fs.access(botConfigPath).then(() => true).catch(() => false), true, "Bot config file must exist");
    const savedBotConfig = JSON.parse(await fs.readFile(botConfigPath, "utf8"));
    assert.equal(savedBotConfig.name, childUid);

    // 5. Check command seed stub
    const legacyCommandPath = path.join(root, botConfig.commandFilePath);
    assert.equal(await fs.access(legacyCommandPath).then(() => true).catch(() => false), true);
    assert.equal(await fs.access(runtimeContext.commandConfigPath).then(() => true).catch(() => false), true);

    // 6. Check runtime directories
    assert.equal(await fs.access(runtimeContext.workspaceRoot).then(() => true).catch(() => false), true);
    assert.equal(await fs.access(runtimeContext.dataDir).then(() => true).catch(() => false), true);
    assert.equal(await fs.access(runtimeContext.logsDir).then(() => true).catch(() => false), true);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
  }
});

test("createAllRequiredFilesWithCredentials isolates child bot from Main Bot global admins", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-prov-isolation-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });

  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    // Write Main Bot state and global admin list
    await fs.writeFile(
      path.join(root, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "main-master-uid" }),
    );
    await fs.writeFile(
      path.join(root, "assets", "json-data", "list_admin.json"),
      JSON.stringify(["global-admin-main-1", "global-admin-main-2"]),
    );

    const childUid = "child-bot-isolated-888";
    const botConfig = createBotConfig(childUid, 4568);
    const credentialsData = {
      cookie: { zpw_sek: "child_isolated_sek" },
      imei: "child-isolated-imei",
      name: "Child Bot Isolated",
      avatar: "",
      userAgent: "Mozilla/5.0",
      uid: "", // no owner UID supplied → admin list contains the bot itself
    };

    await createAllRequiredFilesWithCredentials(childUid, credentialsData, botConfig);

    const runtimeContext = createBotRuntimeContext({ uid: childUid, ...botConfig });
    const runtimeAdmins = JSON.parse(await fs.readFile(runtimeContext.adminListPath, "utf8"));
    assert.equal(runtimeAdmins.includes("main-master-uid"), false, "Child must NOT inherit main master UID");
    assert.equal(runtimeAdmins.includes("global-admin-main-1"), false, "Child must NOT inherit global admin");
    // Child bot itself is always a Supreme Admin
    assert.equal(runtimeAdmins.includes(childUid), true, "Child bot itself must be in its own admin list");

    const legacyAdminPath = path.join(root, botConfig.adminFilePath);
    const legacyAdmins = JSON.parse(await fs.readFile(legacyAdminPath, "utf8"));
    assert.equal(legacyAdmins.includes(childUid), true, "Child bot itself must be in legacy admin list");
    assert.deepEqual(legacyAdmins, [childUid]);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
  }
});

test("createAllRequiredFilesWithCredentials merges and dedupes admin list for Main Bot (admin)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-prov-main-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot", "state"), { recursive: true });
  await fs.mkdir(path.join(root, "assets", "json-data"), { recursive: true });

  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    await fs.writeFile(
      path.join(root, "mybot", "state", "admin.json"),
      JSON.stringify({ uid: "main-master-uid" }),
    );
    await fs.writeFile(
      path.join(root, "assets", "json-data", "list_admin.json"),
      JSON.stringify(["global-admin-1", "duplicate-admin", "admin"]),
    );

    const botConfig = createBotConfig("admin", 5000);
    const credentialsData = {
      cookie: { zpw_sek: "main_admin_sek" },
      imei: "main-admin-imei",
      name: "Main Admin Bot",
      avatar: "",
      userAgent: "Mozilla/5.0",
    };

    await createAllRequiredFilesWithCredentials("admin", credentialsData, botConfig);

    const runtimeContext = createBotRuntimeContext({ uid: "admin", ...botConfig });
    const runtimeAdmins = JSON.parse(await fs.readFile(runtimeContext.adminListPath, "utf8"));
    assert.equal(runtimeAdmins.includes("main-master-uid"), true);
    assert.equal(runtimeAdmins.includes("global-admin-1"), true);
    assert.equal(runtimeAdmins.includes("duplicate-admin"), true);
    assert.equal(runtimeAdmins.includes("admin"), false, "Literal 'admin' must be filtered out");

    const legacyAdminPath = path.join(root, botConfig.adminFilePath);
    const legacyAdmins = JSON.parse(await fs.readFile(legacyAdminPath, "utf8"));
    assert.equal(legacyAdmins.includes("main-master-uid"), true);
    assert.equal(legacyAdmins.includes("global-admin-1"), true);
    assert.equal(legacyAdmins.includes("admin"), false);
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
  }
});

test("createAllRequiredFilesWithCredentials rejects child bot credentials matching main admin session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qr-prov-admin-check-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "mybot"), { recursive: true });

  const previousProjectRoot = process.env.PROJECT_ROOT;
  resetEnvCache();
  process.env.PROJECT_ROOT = root;

  try {
    // Write admin credential file in assets/config.json
    await fs.writeFile(
      path.join(root, "assets", "config.json"),
      JSON.stringify({
        cookie: [{ domain: ".zalo.me", name: "zpw_sek", value: "secret-admin-session-sek" }],
        imei: "admin-imei-xxx",
      }),
    );

    const childUid = "imposter-child-uid";
    const botConfig = createBotConfig(childUid, 4569);
    const hijackedCredentials = {
      cookie: [{ domain: ".zalo.me", name: "zpw_sek", value: "secret-admin-session-sek" }],
      imei: "different-imei",
      name: "Imposter",
      avatar: "",
    };

    await assert.rejects(
      async () => await createAllRequiredFilesWithCredentials(childUid, hijackedCredentials, botConfig),
      /trùng session admin/,
      "Must reject child bot provisioning with matching admin session",
    );
  } finally {
    if (previousProjectRoot === undefined) {
      delete process.env.PROJECT_ROOT;
    } else {
      process.env.PROJECT_ROOT = previousProjectRoot;
    }
    resetEnvCache();
  }
});
