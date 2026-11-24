// Offline runtime smoke for the per-instance authorization refactor.
// Simulates a freshly provisioned child bot workspace and drives the whole
// chain: provisioning seed -> authorization snapshot -> receive gates ->
// command router dispatch -> handler invocation -> decision log.
//
// Usage: node scripts/smoke-instance-auth.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import process from "node:process";

import { getInitialAdminList, seedRuntimeFiles } from "../src/utils/bot-runtime-context.js";
import { resolveInstanceAuthorization, listInstanceSupremeAdmins } from "../src/utils/instance-authorization.js";
import { canProcessChat } from "../src/automations/chat-access-policy.js";
import { createCommandDefinition, executeCommand } from "../src/commands/command-router.js";
import { logAuthorizationDecision } from "../src/utils/authorization-log.js";

const results = [];
function check(name, condition, extra = "") {
  const ok = Boolean(condition);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` (${extra})` : ""}`);
  if (!ok) process.exitCode = 1;
}

const MAIN_UID = "900000000000000001";
const CHILD_UID = "900000000000000002";
const HIGH_ADMIN_UID = "900000000000000009";
const MAIN_ADMIN_UID = "900000000000000077";
const OUTSIDER_UID = "900000000000000999";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-instance-auth-"));
fs.mkdirSync(path.join(root, "mybot", "state"), { recursive: true });
fs.mkdirSync(path.join(root, "assets", "data"), { recursive: true });
fs.mkdirSync(path.join(root, "mybot", "instances", "admin", "data"), { recursive: true });
fs.writeFileSync(path.join(root, "mybot", "state", "admin.json"), JSON.stringify({ uid: MAIN_UID }));
fs.writeFileSync(path.join(root, "assets", "data", "list_admin_high.json"), JSON.stringify([HIGH_ADMIN_UID]));
fs.writeFileSync(path.join(root, "assets", "data", "list_admin_high_command.json"), JSON.stringify([]));
fs.writeFileSync(
  path.join(root, "mybot", "instances", "admin", "data", "admin-list.json"),
  JSON.stringify([MAIN_UID, MAIN_ADMIN_UID]),
);

const workspaceRoot = path.join(root, "mybot", "instances", CHILD_UID);
const dataDir = path.join(workspaceRoot, "data");
const context = {
  uid: CHILD_UID,
  projectRoot: root,
  workspaceRoot,
  instanceRoot: workspaceRoot,
  dataDir,
  logsDir: path.join(workspaceRoot, "logs"),
  tempDir: path.join(workspaceRoot, "temp"),
  resourcesDir: path.join(workspaceRoot, "resources"),
  generatedDir: path.join(workspaceRoot, "generated"),
  stateDir: path.join(workspaceRoot, "state"),
  adminFilePath: path.join(root, "mybot", "configs", `list_admin-${CHILD_UID}.json`),
  commandConfigPath: path.join(dataDir, "command.json"),
  groupSettingsPath: path.join(dataDir, "group-settings.json"),
  adminListPath: path.join(dataDir, "admin-list.json"),
};

seedRuntimeFiles(context);
seedRuntimeFiles(context); // re-provision must be idempotent

const overrides = {
  highFilePath: path.join(root, "assets", "data", "list_admin_high.json"),
  highCommandPath: path.join(root, "assets", "data", "list_admin_high_command.json"),
  botAdminsPath: context.adminListPath,
};

console.log("=== runtime identity ===");
console.log("smoke root      :", root);
console.log("pid             :", process.pid);
let commit = "unknown";
try {
  commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {}
console.log("commit          :", commit);
const resolverSource = fs.readFileSync(
  new URL("../src/utils/instance-authorization.js", import.meta.url),
  "utf8",
);
let fingerprint = "";
for (const ch of resolverSource) fingerprint = ((fingerprint * 31) + ch.charCodeAt(0)) >>> 0;
console.log("resolver fp     :", fingerprint.toString(16).padStart(8, "0"));

console.log("=== provisioning ===");
const seededAdmins = JSON.parse(fs.readFileSync(context.adminListPath, "utf8")).sort();
check("provisioned child has exactly [childUid, mainUid]", JSON.stringify(seededAdmins) === JSON.stringify([CHILD_UID, MAIN_UID].sort()), seededAdmins.join(","));
check("global high admin NOT copied into child", !seededAdmins.includes(OUTSIDER_UID));

console.log("=== authorization snapshot ===");
const supremes = listInstanceSupremeAdmins({ instanceUid: CHILD_UID, instanceKind: "child", projectRoot: root, overrides });
check("supreme list contains MAIN-BOT, SELF, MAIN-ADMIN, FILE", JSON.stringify(supremes.map((e) => e.source)) === JSON.stringify(["MAIN-BOT", "SELF", "MAIN-ADMIN", "FILE"]), supremes.map((e) => e.source).join(","));

const snapshots = new Map();
for (const uid of [CHILD_UID, MAIN_UID, MAIN_ADMIN_UID, HIGH_ADMIN_UID, OUTSIDER_UID]) {
  snapshots.set(uid, resolveInstanceAuthorization({
    senderId: uid,
    threadId: "",
    instanceUid: CHILD_UID,
    instanceKind: "child",
    projectRoot: root,
    overrides,
  }));
}
check("child self is adminLevelHigh", snapshots.get(CHILD_UID).isAdminLevelHigh && snapshots.get(CHILD_UID).source === "instanceSelf");
check("main-bot UID is adminLevelHigh", snapshots.get(MAIN_UID).isAdminLevelHigh && snapshots.get(MAIN_UID).source === "mainBot");
check("main-admin is adminLevelHigh", snapshots.get(MAIN_ADMIN_UID).isAdminLevelHigh && snapshots.get(MAIN_ADMIN_UID).source === "mainBotAdminList");
check("global-high is adminLevelHigh", snapshots.get(HIGH_ADMIN_UID).isAdminLevelHigh && snapshots.get(HIGH_ADMIN_UID).source === "globalHighFile");
check("outsider stays member on child", snapshots.get(OUTSIDER_UID).role === "member");

console.log("=== gates (private/group disabled) ===");
for (const uid of [CHILD_UID, MAIN_UID, MAIN_ADMIN_UID, HIGH_ADMIN_UID]) {
  const snap = snapshots.get(uid);
  const privatePass = canProcessChat({ chatScope: "private", privateEnabled: false, isGlobalAdmin: snap.isAdminLevelHigh });
  const groupPass = canProcessChat({ chatScope: "group", groupEnabled: false, isGlobalAdmin: snap.isAdminLevelHigh, isBotAdmin: snap.isBotAdmin, isGroupAdmin: false });
  check(`${uid} passes private gate while disabled`, privatePass);
  check(`${uid} passes group gate while disabled`, groupPass);
}
check("outsider blocked by private gate while disabled", !canProcessChat({
  chatScope: "private",
  privateEnabled: false,
  isGlobalAdmin: snapshots.get(OUTSIDER_UID).isAdminLevelHigh,
}));

console.log("=== dispatch to handler ===");
const handlerCalls = [];
const highRiskCommand = createCommandDefinition({
  name: "spamsms",
  permission: "all",
  type: 1,
  handler: async () => { handlerCalls.push("spamsms"); return true; },
});
async function dispatchAs(uid) {
  const snap = snapshots.get(uid);
  const permissionLevel = snap.isAdminLevelHigh ? "adminLevelHigh" : snap.role === "member" ? "all" : snap.role;
  return executeCommand({
    scope: "private",
    args: [],
    dependencies: {},
    dbReady: true,
    config: {},
    permissionLevel,
    isAdminLevelHighest: snap.isAdminLevelHigh,
    isMainBotAdmin: snap.isMainBotAdmin,
    instanceKind: snap.instanceKind,
  }, highRiskCommand);
}
check("self runs high-risk command", (await dispatchAs(CHILD_UID)).code === "HANDLED");
check("main-bot runs high-risk command", (await dispatchAs(MAIN_UID)).code === "HANDLED");
check("main-admin runs high-risk command", (await dispatchAs(MAIN_ADMIN_UID)).code === "HANDLED");
check("global-high runs high-risk command", (await dispatchAs(HIGH_ADMIN_UID)).code === "HANDLED");
check("outsider denied high-risk command", (await dispatchAs(OUTSIDER_UID)).code === "PERMISSION_DENIED");
check("handler executed exactly four times (once per supreme)", JSON.stringify(handlerCalls) === JSON.stringify(["spamsms", "spamsms", "spamsms", "spamsms"]), handlerCalls.join(","));

console.log("=== decision log ===");
logAuthorizationDecision({
  instanceKind: "child",
  instanceUid: CHILD_UID,
  senderId: MAIN_UID,
  threadId: "",
  scope: "private",
  role: snapshots.get(MAIN_UID).role,
  source: snapshots.get(MAIN_UID).source,
  command: "spamsms",
  verdict: "allowed",
}, { projectRoot: root });
const logLines = fs.readFileSync(path.join(root, "logs", "authorization-decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const lastRecord = logLines.at(-1);
check("decision log records kind/uid/sender/role/source/command/verdict",
  lastRecord.instanceKind === "child" && lastRecord.instanceUid === CHILD_UID &&
  lastRecord.senderId === MAIN_UID && lastRecord.role === "adminLevelHigh" &&
  lastRecord.source === "mainBot" && lastRecord.command === "spamsms" && lastRecord.verdict === "allowed");
check("decision log free of credentials/session fields", !Object.keys(lastRecord).some((k) => /cookie|imei|password|session/i.test(k)));

fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`=== smoke summary: ${results.length - failed}/${results.length} checks passed ===`);
if (failed > 0) process.exitCode = 1;
