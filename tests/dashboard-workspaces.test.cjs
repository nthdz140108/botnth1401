const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "../dashboard/public/js/workspaces");

async function workspace(name, exportName) {
  const module = await import(pathToFileURL(path.join(root, `${name}.js`)).href);
  return module[exportName];
}

test("workspace modules invoke only their assigned initializers", async () => {
  const calls = [];
  const bots = await workspace("bots", "initBotsWorkspace");
  const automation = await workspace("automation", "initAutomationWorkspace");
  const messaging = await workspace("messaging", "initMessagingWorkspace");
  const groups = await workspace("groups-security", "initGroupsSecurityWorkspace");
  const system = await workspace("system", "initSystemWorkspace");

  bots({ initBotManagementPage: () => calls.push("fleet"), initBotControlButtons: () => calls.push("control"), initRunningBotsPage: () => calls.push("running") });
  automation({ initCommandSearch: () => calls.push("search"), initCommandFilter: () => calls.push("filter"), initAutoReplyPage: () => calls.push("replies"), initChatSettings: () => calls.push("chat") });
  messaging({ initSendButtons: () => calls.push("compose"), initRecentMessagesPage: () => calls.push("recent") });
  groups({ initSaveGroupSettingsBtn: () => calls.push("settings"), initAdminManagement: () => calls.push("admins"), initScanGroups: () => calls.push("scan"), initMutePage: () => calls.push("mute"), initWhitelistPage: () => calls.push("whitelist"), initAntiPage: () => calls.push("protection"), initBlockListPage: () => calls.push("block") });
  system({ initCredentialsManagement: () => calls.push("credentials"), initClearLogsBtn: () => calls.push("logs") });

  assert.deepEqual(calls, ["fleet", "control", "running", "search", "filter", "replies", "chat", "compose", "recent", "settings", "admins", "scan", "mute", "whitelist", "protection", "block", "credentials", "logs"]);
});

test("workspace modules tolerate unavailable legacy sections", async () => {
  const bots = await workspace("bots", "initBotsWorkspace");
  assert.doesNotThrow(() => bots({ initBotManagementPage: null }));
});

test("credentials remain masked until an operator explicitly reveals them", async () => {
  const { createCredentialsController } = await import(pathToFileURL(path.join(root, "system.js")).href);
  const dom = new JSDOM("<!doctype html><body><textarea id='credCookie'></textarea><input id='credImei'><input id='credUserAgent'><input id='credPhone'><input id='credZaloId'><button id='revealCredentials'></button></body>");
  let requests = 0;
  const controller = createCredentialsController({ document: dom.window.document, fetchImpl: async () => {
    requests += 1;
    return { ok: true, json: async () => ({ cookie: "secret", imei: "device" }) };
  } });

  controller.initialize();
  assert.equal(requests, 0);
  assert.equal(dom.window.document.getElementById("credCookie").value, "");
  await controller.reveal();
  assert.equal(requests, 1);
  assert.equal(dom.window.document.getElementById("credCookie").value, "secret");
  dom.window.close();
});
