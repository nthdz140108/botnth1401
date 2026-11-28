import fs from "fs";
import path from "path";
import { spawn, exec } from "child_process";
import net from "net";
import { fileURLToPath } from "url";
import { readIdentityHandshake } from "./identity-handshake.js";
import { writeReloadRequest } from "./reload-request.js";
import { consumeRestartRequest } from "../../../utils/restart-request.js";
import { writeJsonAtomic } from "./json-state.js";
import { createBotRuntimeContext, getInitialAdminList } from "../../../utils/bot-runtime-context.js";
import { createCommandSeedStub } from "../../../utils/command-runtime-state.js";
import { getProjectRoot } from "../../../utils/env.js";
import { resolveManagedBotTarget, resolveManagedBotList, resolveBotPaths, resolveManagedBotTargetRecord } from "./mybot-identity.js";
import { PM2Adapter } from "../../../runtime/pm2-adapter.js";
import { createLaunchDescriptor } from "../../../runtime/launch-descriptor.js";
import { probeBotReadiness, createBotReadinessService } from "../../../runtime/runtime-readiness.js";
import { withRegistryLock } from "./registry-lock.js";
import { loadMyBotsRegistry, saveMyBotsRegistry } from "./mybots-registry.js";
import { beginBotStartOperation, invalidateBotStartOperation, isBotStartOperationCurrent, withCurrentBotStartOperation } from "./bot-lifecycle-operation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultProjectRoot = path.resolve(__dirname, "../../../..");

function getEffectiveRoot(customRoot = null) {
  return customRoot ? path.resolve(customRoot) : getProjectRoot();
}

function getMyBotPaths(customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const myBotDir = path.join(root, "mybot");
  return {
    projectRoot: root,
    myBotDir,
    botsDir: path.join(myBotDir, "bots"),
    myBotsPath: path.join(myBotDir, "mybots.json"),
    adminCredentialPath: path.join(root, "assets", "config.json"),
    launcherPath: path.join(root, "index.js"),
    botIndexPath: path.join(root, "src", "bootstrap.js"),
    stateDir: path.join(myBotDir, "state"),
  };
}

const isWindows = process.platform === "win32";

const spawnedProcesses = new Map();
const startingBots = new Map();
const restartingBots = new Map();
const launchGenerations = new Map();

export function getBotLaunchGeneration(botKey, projectRoot = null) {
  return launchGenerations.get(`${getEffectiveRoot(projectRoot)}:${botKey}`) || 0;
}

export async function cancelPendingBotStart(targetOrUid, { projectRoot = null } = {}) {
  const root = getEffectiveRoot(projectRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  const token = `${root}:${target.key}`;
  launchGenerations.set(token, (launchGenerations.get(token) || 0) + 1);
  await invalidateBotStartOperation(target.key, { root });
  await Promise.allSettled([startingBots.get(token), restartingBots.get(token)].filter(Boolean));
}

async function stopCancelledLaunchIfOwned(botKey, pid, root, adapter = new PM2Adapter({ projectRoot: root })) {
  if (!pid) return;
  return withRegistryLock(path.join(root, "mybot", "mybots.json"), async () => {
    const latest = loadMyBotsRegistry(path.join(root, "mybot", "mybots.json"))[botKey];
    if (latest?.desiredStatus !== "stopped") return;
    const current = await adapter.listMyBotProcesses();
    if (!current.some(proc => proc.name === botKey && Number(proc.pid) === Number(pid))) return;
    try { process.kill(Number(pid), "SIGTERM"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  });
}

export function checkPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.connect(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function checkBotHealth(targetOrUid, webPort, timeout = 30000, customRoot = null, dependencies = {}) {
  const root = getEffectiveRoot(customRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  const descriptor = createLaunchDescriptor({ kind: target.key === "admin" ? "main" : "child", botKey: target.key, uid: target.uid, projectRoot: root, webPort });
  descriptor.accountUid = target.rawRecord?.accountUid || target.accountUid || (target.uid !== target.key ? target.uid : null);
  const service = createBotReadinessService({ root, ...dependencies });
  const result = await service.waitFor({ descriptor, timeoutMs: timeout, intervalMs: 100 });
  return { ...result, healthy: result.ready === true, method: "runtime-readiness", error: result.ready ? null : result.reason };
}

function getBotConfigPath(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const paths = resolveBotPaths(targetOrUid, root);
  return paths.readConfigPath;
}

function getBotStartupLogPath(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const paths = resolveBotPaths(targetOrUid, root);
  return paths.startupLogPath;
}

function ensureBotLogDir(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const paths = resolveBotPaths(targetOrUid, root);
  fs.mkdirSync(paths.logDir, { recursive: true });
}

function cookieSignature(cookieData) {
  const cookies = Array.isArray(cookieData)
    ? cookieData
    : Array.isArray(cookieData?.cookies)
      ? cookieData.cookies
      : [];
  return cookies
    .map((cookie) => [
      String(cookie?.domain || ""),
      String(cookie?.path || ""),
      String(cookie?.name || cookie?.key || ""),
      String(cookie?.value || ""),
      String(cookie?.sameSite || ""),
      cookie?.httpOnly ? "1" : "0",
      cookie?.secure ? "1" : "0",
    ].join("|"))
    .sort()
    .join("::");
}

function readCredentialSignature(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return cookieSignature(parsed?.cookie);
  } catch {
    return "";
  }
}

function readJsonSafe(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function credentialsLookLikeAdmin(credentialsData, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { adminCredentialPath } = getMyBotPaths(root);
  const signature = cookieSignature(credentialsData?.cookie);
  if (!signature) return false;
  const adminSignature = readCredentialSignature(adminCredentialPath);
  return Boolean(adminSignature) && signature === adminSignature;
}

function appendStartupLog(targetOrUid, message, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  try {
    ensureBotLogDir(targetOrUid, root);
    fs.appendFileSync(getBotStartupLogPath(targetOrUid, root), `${new Date().toISOString()} ${message}\n`);
  } catch (error) {
    console.error(`Không thể ghi startup log cho bot ${typeof targetOrUid === "object" ? (targetOrUid.key || targetOrUid.uid) : targetOrUid}: ${error.message}`);
  }
}

export function readBotWebPort(targetOrUid, customRoot = null) {
  try {
    const root = getEffectiveRoot(customRoot);
    const { myBotsPath } = getMyBotPaths(root);
    const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
    if (target?.webPort && Number.isFinite(parseInt(target.webPort, 10)) && parseInt(target.webPort, 10) > 0) {
      return parseInt(target.webPort, 10);
    }
    const paths = target?.paths || resolveBotPaths(targetOrUid, root);
    if (fs.existsSync(paths.readConfigPath)) {
      const botConfig = JSON.parse(fs.readFileSync(paths.readConfigPath, "utf8"));
      const parsed = parseInt(botConfig.webPort, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    if (fs.existsSync(myBotsPath)) {
      const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8"));
      const raw = myBots?.[target?.key] || myBots?.[target?.uid] || (typeof targetOrUid === "string" ? myBots[targetOrUid] : null);
      const parsed = parseInt(raw?.webPort, 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch (error) {
    console.warn(`Không thể đọc webPort của bot ${typeof targetOrUid === "object" ? (targetOrUid.key || targetOrUid.uid) : targetOrUid}: ${error.message}`);
  }
  return null;
}

const activeTerminalWatchers = new Map();

function readBotStateSafe(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  const uidsToCheck = [target?.uid, target?.key, typeof targetOrUid === "string" ? targetOrUid : null].filter(Boolean);
  for (const u of uidsToCheck) {
    try {
      const statePath = path.join(root, "mybot", "state", `${u}.json`);
      if (fs.existsSync(statePath)) {
        return JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
      }
    } catch {}
  }
  return null;
}

function getBotDisplayName(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotsPath } = getMyBotPaths(root);
  try {
    if (fs.existsSync(myBotsPath)) {
      const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, ""));
      const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry: myBots });
      const record = myBots[target?.key] || myBots[target?.uid] || (typeof targetOrUid === "string" ? myBots[targetOrUid] : null);
      return record?.displayName || record?.name || target?.displayName || target?.key || targetOrUid;
    }
  } catch {}
  return typeof targetOrUid === "object" ? (targetOrUid.displayName || targetOrUid.key || targetOrUid.uid) : targetOrUid;
}

async function killProcessTree(pid) {
  if (!pid) return;
  if (isWindows) {
    return new Promise((resolve) => {
      const child = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      child.on("close", () => resolve(true));
      child.on("error", () => resolve(false));
    });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function startTerminalProcessWatcher(targetOrUid, consolePid, nodePid, webPort, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  const watcherKey = target.key;
  if (activeTerminalWatchers.has(watcherKey)) {
    clearInterval(activeTerminalWatchers.get(watcherKey));
  }
  const timer = setInterval(async () => {
    let consoleAlive = consolePid ? await isProcessAlive(consolePid) : false;
    let nodeAlive = nodePid ? await isProcessAlive(nodePid) : false;
    let portInUse = webPort ? await checkPortInUse(webPort) : false;

    if (!consoleAlive && !nodeAlive && !portInUse) {
      clearInterval(timer);
      activeTerminalWatchers.delete(watcherKey);
      appendStartupLog(target, `Terminal closed / process stopped for ${target.key}`, root);
      await updateMyBotRecord(target, {
        status: "stopped",
        pid: null,
        consolePid: null,
        lastUpdated: new Date().toISOString(),
      }, root);
    }
  }, 3000);
  if (timer.unref) timer.unref();
  activeTerminalWatchers.set(watcherKey, timer);
}

function clearBotStartupState(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  spawnedProcesses.delete(target.key);
  spawnedProcesses.delete(target.uid);
  startingBots.delete(target.key);
  startingBots.delete(target.uid);
}

export async function removeSpawnedRecord(targetOrUid, pid = null, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  clearBotStartupState(targetOrUid, root);
  try {
    await updateMyBotRecord(targetOrUid, (bot) => {
      if (pid && String(bot.pid) !== String(pid)) return bot;
      delete bot.pid;
      delete bot.consolePid;
      if (String(bot.status).toLowerCase() === "starting") {
        bot.status = "stopped";
      }
      bot.lastUpdated = new Date().toISOString();
      return bot;
    }, root);
  } catch (error) {
    console.error(`Không thể dọn state cho bot ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid}: ${error.message}`);
  }
}

export async function updateMyBotRecord(targetOrUid, updater, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  return withRegistryLock(path.join(root, "mybot", "mybots.json"), () => updateMyBotRecordLocked(targetOrUid, updater, root));
}

async function updateMyBotRecordLocked(targetOrUid, updater, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotsPath } = getMyBotPaths(root);
  if (!fs.existsSync(myBotsPath)) return false;
  let myBots = {};
  try {
    myBots = loadMyBotsRegistry(myBotsPath);
  } catch (error) {
    throw error;
  }

  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry: myBots });
  const rawKey = typeof targetOrUid === "object" && targetOrUid ? (targetOrUid.key || targetOrUid.uid) : targetOrUid;

  let matchedKey = null;
  if (target?.key && myBots[target.key]) {
    matchedKey = target.key;
  } else if (target?.uid && myBots[target.uid]) {
    matchedKey = target.uid;
  } else if (rawKey && myBots[rawKey]) {
    matchedKey = rawKey;
  } else {
    for (const [k, v] of Object.entries(myBots)) {
      if (k === target.key || k === target.uid || v?.uid === target.uid || v?.uid === target.key || v?.key === target.key) {
        matchedKey = k;
        break;
      }
    }
  }

  if (!matchedKey || !myBots[matchedKey]) return false;

  const currentVal = myBots[matchedKey];
  const nextValue = typeof updater === "function" ? updater({ ...currentVal }) : { ...currentVal, ...updater };
  myBots[matchedKey] = nextValue;
  saveMyBotsRegistry(myBots, myBotsPath);
  return true;
}

async function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export async function checkSpawnedProcessStatus(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotsPath } = getMyBotPaths(root);
  try {
    if (!fs.existsSync(myBotsPath)) {
      return { running: false, status: "not_found" };
    }
    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, ""));
    const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry: myBots });
    const botInfo = myBots[target.key] || myBots[target.uid] || (typeof targetOrUid === "string" ? myBots[targetOrUid] : null);
    if (!botInfo) {
      return { running: false, status: "not_found" };
    }
    const state = readBotStateSafe(target, root);
    const pid = botInfo.pid ? parseInt(botInfo.pid, 10) : (state?.pid ? parseInt(state.pid, 10) : null);
    const consolePid = botInfo.consolePid ? parseInt(botInfo.consolePid, 10) : (state?.consolePid ? parseInt(state.consolePid, 10) : null);

    if (!pid && !consolePid) {
      return { running: false, status: "no_pid" };
    }

    let nodeAlive = pid ? await isProcessAlive(pid) : false;
    let consoleAlive = consolePid ? await isProcessAlive(consolePid) : false;

    if (nodeAlive || consoleAlive) {
      return { running: true, status: "running", pid: nodeAlive ? pid : consolePid, consolePid };
    }

    // Process is dead, synchronize state if it was starting / running
    if (["running", "starting"].includes(botInfo.status)) {
      await updateMyBotRecord(target, {
        status: "stopped",
        pid: null,
        consolePid: null,
        lastUpdated: new Date().toISOString(),
      }, root);
    }

    return { running: false, status: "stopped", pid };
  } catch (error) {
    console.error(`Lỗi kiểm tra spawned process ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid}: ${error.message}`);
    return { running: false, status: "error" };
  }
}

export async function resolveBotRuntimeState(targetOrUid, { customRoot = null, registry = null } = {}) {
  const root = getEffectiveRoot(customRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry });
  const key = String(target?.key || (typeof targetOrUid === "object" ? (targetOrUid?.key || targetOrUid?.uid) : targetOrUid) || "").trim();
  const isMain = Boolean(target?.isMain || key.toLowerCase() === "admin" || target?.uid === "admin");

  if (isMain) {
    let mainAlive = Boolean(process.pid);
    let pm2Running = false;
    let pm2Pid = null;

    try {
      const pm2Res = await checkPM2Status("admin");
      if (pm2Res && pm2Res.running === true) {
        pm2Running = true;
        pm2Pid = pm2Res.pid || null;
      }
    } catch {}

    if (pm2Running) {
      return {
        running: true,
        status: "running",
        source: "pm2",
        pid: pm2Pid || process.pid,
      };
    }

    if (mainAlive) {
      return {
        running: true,
        status: "running",
        source: "main-process",
        pid: process.pid,
      };
    }

    return {
      running: false,
      status: "stopped",
      source: "main-process",
      pid: null,
    };
  }

  let spawnedRes = null;
  try {
    spawnedRes = await checkSpawnedProcessStatus(target, root);
  } catch {}

  let pm2Res = null;
  try {
    pm2Res = await checkPM2Status(key);
  } catch {}

  const isSpawnedRunning = Boolean(spawnedRes && spawnedRes.running === true);
  const isPm2Running = Boolean(pm2Res && pm2Res.running === true);

  if (isSpawnedRunning || isPm2Running) {
    const activePid = spawnedRes?.pid || pm2Res?.pid || null;
    const port = Number(target.webPort || target.rawRecord?.webPort || 4444);
    const descriptor = {
      kind: isMain ? "main" : "child",
      botKey: key || target.uid,
      webPort: port,
    };
    const procSnapshot = {
      status: "online",
      pid: activePid,
    };

    try {
      const probe = await probeBotReadiness({
        descriptor,
        process: procSnapshot,
        expectedPid: activePid,
      });

      return {
        running: probe.ready === true,
        ready: probe.ready === true,
        status: probe.status,
        reason: probe.reason,
        source: isSpawnedRunning ? "spawned-process" : "pm2",
        pid: activePid,
      };
    } catch (probeErr) {
      return {
        running: false,
        ready: false,
        status: "error",
        reason: probeErr.message || "readiness-probe-failed",
        source: isSpawnedRunning ? "spawned-process" : "pm2",
        pid: activePid,
      };
    }
  }

  const regStatus = target?.status || target?.rawRecord?.status || "stopped";
  if (regStatus === "rejected") {
    return {
      running: false,
      status: "rejected",
      source: "registry",
      pid: null,
    };
  }

  if (regStatus === "starting") {
    return {
      running: false,
      status: "starting",
      source: "registry",
      pid: null,
    };
  }

  return {
    running: false,
    status: "stopped",
    source: "spawned-process",
    pid: null,
  };
}


export async function killSpawnedProcess(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotsPath } = getMyBotPaths(root);
  try {
    const myBots = fs.existsSync(myBotsPath) ? JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, "")) : {};
    const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry: myBots });
    let killed = false;

    // 1. Direct handle created by runtime (single source of truth for direct-spawn)
    const activeChild = spawnedProcesses.get(target.key) || spawnedProcesses.get(target.uid);
    if (activeChild && typeof activeChild.kill === "function") {
      try {
        if (activeChild.pid) await killProcessTree(activeChild.pid);
        activeChild.kill("SIGKILL");
        killed = true;
      } catch {}
      spawnedProcesses.delete(target.key);
      spawnedProcesses.delete(target.uid);
    }

    await updateMyBotRecord(target, {
      pid: null,
      consolePid: null,
      status: "stopped",
      lastUpdated: new Date().toISOString(),
    }, root);
    return killed;
  } catch (error) {
    console.error(`Lỗi kill spawned process ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid}: ${error.message}`);
    return false;
  }
}

export async function saveSpawnedPid(targetOrUid, pid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  try {
    await updateMyBotRecord(targetOrUid, { pid: String(pid) }, root);
  } catch (error) {
    console.error(`Lỗi lưu PID cho bot ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid}: ${error.message}`);
  }
}

export async function getSpawnedPid(targetOrUid, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotsPath } = getMyBotPaths(root);
  try {
    if (!fs.existsSync(myBotsPath)) return null;
    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, ""));
    const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry: myBots });
    const botInfo = myBots[target.key] || myBots[target.uid] || (typeof targetOrUid === "string" ? myBots[targetOrUid] : null);
    if (botInfo && botInfo.pid) {
      return parseInt(botInfo.pid, 10);
    }
    const state = readBotStateSafe(target, root);
    if (state && state.pid) {
      return parseInt(state.pid, 10);
    }
  } catch (error) {
    console.error(`Lỗi đọc PID cho bot ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid}: ${error.message}`);
  }
  return null;
}

export async function restartPM2Process(processName) {
  const adapter = new PM2Adapter({ projectRoot: defaultProjectRoot });
  try {
    const result = await adapter.restartBot(processName);
    if (result.success) {
      console.log(`Successfully restarted PM2 process: ${processName}`);
      return true;
    }
    console.error(`Failed to restart PM2 process ${processName}: ${result.reason}`);
    return false;
  } catch (error) {
    console.error(`Error restarting PM2 process ${processName}: ${error.message}`);
    return false;
  }
}

export function restartBotRuntime(targetOrUid, options = {}) {
  if (!targetOrUid) return Promise.resolve({ success: false, reason: "no_uid" });
  const root = getEffectiveRoot(options.projectRoot);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  const effectiveBotUid = String(target.uid || target.key || targetOrUid).trim();
  const botKey = String(target.key || target.uid || targetOrUid).trim();

  const lockKey = `${root}:${botKey}`;
  const existing = restartingBots.get(lockKey);
  if (existing) return existing;

  const operation = (async () => {
    const operationId = await beginBotStartOperation(botKey, { root, operationId: options.operationId });
    if (effectiveBotUid && effectiveBotUid !== "admin") {
      consumeRestartRequest(effectiveBotUid, root, { maxAgeMs: 120_000 });
    }
    if (botKey && botKey !== "admin" && botKey !== effectiveBotUid) {
      consumeRestartRequest(botKey, root, { maxAgeMs: 120_000 });
    }
    const previousPid = await getSpawnedPid(target, root);
    const pm2Status = await checkPM2Status(botKey);
    if (pm2Status.running) {
      const restarted = await restartPM2Process(botKey);
      if (restarted) {
        const health = await checkBotHealth(target, readBotWebPort(target, root), options.readinessTimeoutMs || 60000, root);
        if (!isBotStartOperationCurrent(botKey, operationId, { root })) {
          await stopCancelledLaunchIfOwned(botKey, health.identity?.pid, root);
          return { success: false, code: "START_CANCELLED", reason: "START_CANCELLED" };
        }
        return { success: health.healthy, method: "pm2", botKey, pid: health.identity?.pid || null, previousPid, health, reason: health.healthy ? "ready" : health.reason };
      }
    }

    // Kill any existing spawned / terminal process
    await killSpawnedProcess(target, root);

    // Wait for port release if webPort was in use
    const isMock = Boolean(options.env?.TEST_MOCK_LAUNCH === "true");
    const webPort = isMock ? null : readBotWebPort(target, root);
    if (webPort && !isMock) {
      const waitStart = Date.now();
      while (Date.now() - waitStart < 5000) {
        const inUse = await checkPortInUse(webPort);
        if (!inUse) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const launchResult = await startBotWithLauncher(target, { ...options, operationId, projectRoot: root });
    return {
      ...launchResult,
      previousPid,
      botKey,
      uid: effectiveBotUid,
    };
  })();

  let tracked;
  tracked = operation.finally(() => {
    if (restartingBots.get(lockKey) === tracked) restartingBots.delete(lockKey);
  });
  restartingBots.set(lockKey, tracked);
  return tracked;
}

export async function deletePM2Process(processName, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const adapter = new PM2Adapter({ projectRoot: root });
  return await adapter.deleteBot(processName);
}


export async function checkBotExists(uidFrom, customRoot = null) {
  try {
    if (!uidFrom) return { exists: false };
    const root = customRoot || getProjectRoot();
    const str = String(uidFrom).trim();
    const isNum = /^\d+$/.test(str) && str.length < 10;
    const targets = resolveManagedBotTarget({
      selector: isNum ? { type: "index", value: parseInt(str, 10) } : { type: "uid", value: str },
      callerUid: str,
      projectRoot: root,
    });
    if (targets && targets.length > 0) {
      const target = targets[0];
      const rawDb = target.rawRecord?.database || target.database || "";
      const fallbackDb = target.isMain ? "nthdz" : (target.uid || target.key || "");
      return {
        exists: true,
        botInfo: {
          ...(target.rawRecord || {}),
          key: target.key,
          uid: target.uid,
          ownerUid: target.ownerUid,
          ownerName: target.ownerName,
          nameServer: target.nameServer,
          displayName: target.displayName,
          status: target.status,
          webPort: target.webPort,
          database: rawDb && String(rawDb).trim() !== "" ? rawDb : fallbackDb,
          expiryAt: target.expiryAt,
          trialStatus: target.trialStatus,
          isMain: target.isMain,
        },
        target,
      };
    }
    const registryPath = path.join(root, "mybot", "mybots.json");
    if (fs.existsSync(registryPath)) {
      const myBots = JSON.parse(fs.readFileSync(registryPath, "utf8").replace(/^\uFEFF/, ""));
      if (myBots[str]) {
        return { exists: true, botInfo: myBots[str] };
      }
    }
    return { exists: false };
  } catch (error) {
    console.error(`Lỗi kiểm tra bot: ${error.message}`);
    return { exists: false };
  }
}

export async function checkPM2Status(processName) {
   return new Promise((resolve) => {
     const pm2Command = isWindows ? "pm2.cmd" : "pm2";
     let timer = null;
     let pm2Process;
     try {
       pm2Process = spawn(pm2Command, ["describe", processName], {
         stdio: "pipe",
         windowsHide: isWindows,
         shell: isWindows,
       });
     } catch (error) {
       // Windows cannot spawn .cmd files without a shell; PM2 is optional
       // because the launcher also tracks directly spawned bot processes.
       resolve({ running: false, status: "error", error: error.code || error.message });
       return;
     }
     let output = "";
     let errorOutput = "";
     pm2Process.stdout?.on("data", (data) => {
       output += data.toString();
     });
     pm2Process.stderr?.on("data", (data) => {
       errorOutput += data.toString();
     });
     pm2Process.on("close", (code) => {
       if (timer) clearTimeout(timer);
       if (code === 0 && output.includes("online")) {
         resolve({ running: true, status: "online" });
       } else if (code === 0 && output.includes("stopped")) {
         resolve({ running: false, status: "stopped" });
       } else {
         resolve({ running: false, status: "not_found" });
       }
     });
     pm2Process.on("error", () => {
       if (timer) clearTimeout(timer);
       resolve({ running: false, status: "error" });
     });
     timer = setTimeout(() => {
       try { pm2Process.kill(); } catch {}
       resolve({ running: false, status: "timeout" });
     }, 10000);
   });
 }

export async function stopPM2Process(processName) {
  return new Promise((resolve) => {
    const pm2Command = isWindows ? "pm2.cmd" : "pm2";
    let timer = null;
    let pm2Process;
    try {
      pm2Process = spawn(pm2Command, ["stop", processName], {
        stdio: "pipe",
        windowsHide: isWindows,
        shell: isWindows,
      });
    } catch (error) {
      console.error(`Error stopping PM2 process: ${error.message}`);
      resolve(false);
      return;
    }
    let output = "";
    let errorOutput = "";
    pm2Process.stdout?.on("data", (data) => {
      output += data.toString();
    });
    pm2Process.stderr?.on("data", (data) => {
      errorOutput += data.toString();
    });
    pm2Process.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        console.log(`Successfully stopped PM2 process: ${processName}`);
        resolve(true);
      } else {
        console.error(`Failed to stop PM2 process: ${processName}`);
        if (errorOutput) console.error(`Error: ${errorOutput}`);
        resolve(false);
      }
    });
    pm2Process.on("error", (error) => {
      if (timer) clearTimeout(timer);
      console.error(`Error stopping PM2 process: ${error.message}`);
      resolve(false);
    });
    timer = setTimeout(() => {
      try { pm2Process.kill(); } catch {}
      console.error(`Timeout stopping PM2 process: ${processName}`);
      resolve(false);
    }, 15000);
  });
}

export async function startBotWithLauncher(targetOrUid, options = {}) {
  if (!targetOrUid) return { success: false, reason: "no_uid" };
  const root = getEffectiveRoot(options.projectRoot);
  const { botIndexPath } = getMyBotPaths(root);
  const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root });
  const effectiveBotUid = String(target.uid || target.key || targetOrUid).trim();
  const botKey = String(target.key || target.uid || targetOrUid).trim();
  const paths = target.paths || resolveBotPaths(target, root);

  const lockKey = `${root}:${botKey}`;
  if (startingBots.has(lockKey)) {
    return startingBots.get(lockKey);
  }

  const generation = launchGenerations.get(lockKey) || 0;
  let operationId = null;
  const isCancelled = () => (launchGenerations.get(lockKey) || 0) !== generation || !isBotStartOperationCurrent(botKey, operationId, { root });
  const startPromise = (async () => {
    if (options.env?.TEST_MOCK_LAUNCH === "true") {
      return { success: true, pid: 99999, consolePid: 88888, reason: "mock" };
    }
    operationId = await beginBotStartOperation(botKey, { root, operationId: options.operationId });

    const isBootstrapOnly = Boolean(options.skipHealthCheck || options.env?.QR_BOOTSTRAP_ONLY === "true");
    const webPort = isBootstrapOnly ? null : readBotWebPort(target, root);
    if (!webPort && !isBootstrapOnly) {
      const message = `Không tìm thấy webPort hợp lệ cho bot ${botKey} (UID: ${effectiveBotUid})`;
      appendStartupLog(target, message, root);
      throw new Error(message);
    }

    const readCredPath = paths.readCredentialPath;
    if (effectiveBotUid !== "admin" && botKey !== "admin" && credentialsLookLikeAdmin(readJsonSafe(readCredPath, {}), root)) {
      const message = `Credential của bot ${botKey} đang trùng session admin; dừng khởi động để tránh đá session bot chính.`;
      appendStartupLog(target, message, root);
      throw new Error(message);
    }

    if (webPort && (await checkPortInUse(webPort))) {
      const health = await checkBotHealth(target, webPort, 1000, root);
      if (!health.healthy) return { success: false, reason: "PORT_IN_USE", health };
      await withCurrentBotStartOperation(botKey, operationId, { root }, () => updateMyBotRecord(target, { status: "running", desiredStatus: "running", lastUpdated: new Date().toISOString() }, root));
      return { success: true, pid: health.identity?.pid || null, consolePid: null, reason: "already_running", health };
    }

    if (!fs.existsSync(botIndexPath)) {
      const message = `Không tìm thấy bot entrypoint: ${botIndexPath}`;
      appendStartupLog(target, message, root);
      const err = new Error(message);
      err.code = "ERR_ENTRYPOINT_NOT_FOUND";
      err.entrypoint = botIndexPath;
      throw err;
    }

    ensureBotLogDir(target, root);
    if (!isBootstrapOnly) {
      if (effectiveBotUid && effectiveBotUid !== "admin") {
        consumeRestartRequest(effectiveBotUid, root, { maxAgeMs: 120_000 });
      }
      if (botKey && botKey !== "admin" && botKey !== effectiveBotUid) {
        consumeRestartRequest(botKey, root, { maxAgeMs: 120_000 });
      }
    }
    appendStartupLog(target, `Starting bot key=${botKey} uid=${effectiveBotUid} on port ${webPort || "bootstrap"}`, root);

    // NOTE: The old flow deleted the PM2 process before every start. That is
    // removed — PM2Adapter.startBot() uses start-or-adopt semantics and never
    // deletes a running process.

    // For bootstrap-only: headless spawn
    if (isBootstrapOnly) {
      const childEnv = {
        ...process.env,
        MYBOT_INSTANCE_KIND: "child",
        BOT_UID: effectiveBotUid,
        BOT_KEY: botKey,
        BOT_NAME: String(options.botName || botKey),
        CONFIG_PATH: String(options.configPath || paths.readConfigPath),
        PROJECT_ROOT: String(root),
        WEB_PORT: String(webPort || ""),
        BOT_MANAGED: "true",
        ...(options.env || {}),
      };
      let child;
      try {
        child = spawn(process.execPath, [botIndexPath, String(effectiveBotUid)], {
          cwd: root,
          env: childEnv,
          detached: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (spawnError) {
        appendStartupLog(target, `Spawn threw synchronously: ${spawnError.message}`, root);
        throw spawnError;
      }
      spawnedProcesses.set(lockKey, child);
      spawnedProcesses.set(botKey, child);
      return { success: true, pid: child.pid, consolePid: null, reason: "bootstrap" };
    }

    // PM2 is the single source of truth for bot runtime (all platforms).
    // The legacy Windows CMD-window launcher has been removed; production
    // startup goes through the PM2 adapter with start-or-adopt semantics.
    {
      const descriptor = createLaunchDescriptor({
        kind: botKey === "admin" ? "main" : "child",
        botKey,
        uid: effectiveBotUid,
        projectRoot: root,
        webPort,
      });
      descriptor.accountUid = target.rawRecord?.accountUid || target.accountUid || (target.uid !== target.key ? target.uid : null);
      const adapter = new PM2Adapter({ projectRoot: root });
      const result = await adapter.startBot(descriptor);

      if (!result.success) {
        appendStartupLog(target, `PM2 start failed: ${result.reason} ${result.detail || ""}`, root);
        await updateMyBotRecord(target, { startError: result.reason || "pm2_start_failed" }, root).catch(() => {});
        throw new Error(`PM2 start failed for ${botKey}: ${result.reason}`);
      }

      await updateMyBotRecord(target, {
        status: "starting",
        lastUpdated: new Date().toISOString(),
      }, root);

      const service = createBotReadinessService({ adapter, root });
      const health = await service.waitFor({ descriptor, timeoutMs: options.readinessTimeoutMs || 60000 });
      if (health.ready) {
          if (isCancelled()) {
            await stopCancelledLaunchIfOwned(botKey, health.identity?.pid, root, adapter);
            return { success: false, code: "START_CANCELLED", reason: "START_CANCELLED" };
          }
          const nodePid = health.identity?.pid || null;
          await withCurrentBotStartOperation(botKey, operationId, { root }, () => updateMyBotRecord(target, {
            pid: nodePid ? String(nodePid) : null,
            consolePid: null,
            status: "running",
            desiredStatus: "running",
            startError: null,
            lastUpdated: new Date().toISOString(),
          }, root));
          appendStartupLog(target, `Healthy under PM2 pm2Name=${descriptor.pm2Name} pid=${nodePid} port=${webPort}`, root);
          return { success: true, pid: nodePid, consolePid: null, reason: result.reason, health };
      }

      appendStartupLog(target, `Startup timeout under PM2: port=${webPort}`, root);
      await updateMyBotRecord(target, { startError: "startup_timeout" }, root).catch(() => {});
      return { success: false, pid: null, consolePid: null, reason: "startup_timeout" };
    }
  })().finally(() => {
    startingBots.delete(lockKey);
  });

  startingBots.set(lockKey, startPromise);
  return startPromise;
}

export async function waitForPM2Process(processName, maxWaitTime = 60000) {
  const startTime = Date.now();
  const checkInterval = 2000;
  while (Date.now() - startTime < maxWaitTime) {
    const status = await checkPM2Status(processName);
    if (status.running && status.status === "online") {
      console.log(`Bot ${processName} is now running in PM2`);
      return true;
    }
    if (status.status === "stopped") {
      console.log(`Bot ${processName} stopped in PM2`);
      return false;
    }
    console.log(`Waiting for bot ${processName}... Status: ${status.status}`);
    await new Promise(resolve => setTimeout(resolve, checkInterval));
  }
  console.log(`Timeout waiting for bot ${processName} to start`);
  return false;
}

export async function updateBotStatus(targetOrUid, status, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  try {
    const updated = await updateMyBotRecord(targetOrUid, {
      status,
      lastUpdated: new Date().toISOString(),
    }, root);
    if (!updated) {
      throw new Error(`Bot ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid} không tồn tại trong danh sách`);
    }
    console.log(`Đã cập nhật trạng thái bot ${typeof targetOrUid === "object" ? targetOrUid.key : targetOrUid} thành ${status}`);
  } catch (error) {
    console.error(`Lỗi cập nhật trạng thái bot: ${error.message}`);
    throw error;
  }
}

export async function checkExistingBot(targetOrUid, customRoot = null) {
  try {
    const root = getEffectiveRoot(customRoot);
    const { myBotsPath } = getMyBotPaths(root);
    if (!fs.existsSync(myBotsPath)) {
      return { exists: false };
    }
    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, ""));
    const target = resolveManagedBotTargetRecord(targetOrUid, { projectRoot: root, registry: myBots });
    const existingBot = myBots[target.key] || myBots[target.uid] || (typeof targetOrUid === "string" ? myBots[targetOrUid] : null);
    if (!existingBot) {
      return { exists: false };
    }
    const pm2Status = await checkPM2Status(target.key);
    if (pm2Status.running) {
      return { exists: true, message: "Tài khoản bot này đang hoạt động!" };
    }
    const spawnedStatus = await checkSpawnedProcessStatus(target, root);
    if (spawnedStatus.running) {
      return { exists: true, message: "Tài khoản bot này đang hoạt động!" };
    }
    switch (existingBot.status) {
      case "running":
        return { exists: true, message: "Tài khoản bot này đang hoạt động!" };
      case "trialExpired":
        return { exists: true, message: "Bạn đã hết thời gian dùng thử! Hãy gia hạn bot của bạn." };
      case "expired":
        return { exists: true, message: "Bot của bạn đã hết hạn! Hãy gia hạn để tiếp tục sử dụng." };
      case "stopping":
        return { exists: true, message: "Bot của bạn đang trong trạng thái bảo trì! Hãy liên hệ admin." };
      case "stopped":
        return { exists: true, message: "Bot của bạn đang dừng! Hãy sử dụng lệnh start để khởi động lại thay vì tạo mới." };
      default:
        return { exists: true, message: "Tài khoản Zalo này đã được tạo BOT từ trước." };
    }
  } catch (error) {
    console.error(`Lỗi kiểm tra bot hiện có: ${error.message}`);
    return { exists: false };
  }
}

export function getAvailablePort(customRoot = null) {
  try {
    const root = getEffectiveRoot(customRoot);
    const { myBotsPath } = getMyBotPaths(root);
    if (!fs.existsSync(myBotsPath)) {
      return 4444;
    }
    const maxPort = Math.max(6666, Number(process.env.MYBOT_PORT_SCAN_END) || 65000);
    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8").replace(/^\uFEFF/, ""));
    const usedPorts = Object.values(myBots).map(bot => parseInt(bot.webPort, 10)).filter(p => Number.isFinite(p));
    for (let port = 4444; port <= maxPort; port++) {
      if (!usedPorts.includes(port)) {
        return port;
      }
    }
    throw new Error(`Không còn port khả dụng (4444-${maxPort})`);
  } catch (error) {
    console.error(`Lỗi lấy port: ${error.message}`);
    throw error;
  }
}

export function validateCredentials(args, prefix, aliasCommand) {
  const defaultUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  if (!Array.isArray(args) || args.length === 0) {
    return { valid: false, message: "Thiếu thông tin đăng nhập!" };
  }
  let imeiToken = args[0];
  let cookieToken = args[1];
  let uaTokens = args.slice(2);

  if (args.length >= 3 && !/^[{\[]/.test(String(args[1])) && /^[{\[]/.test(String(args[2]))) {
    imeiToken = args[1];
    cookieToken = args[2];
    uaTokens = args.slice(3);
  }

  let cookie;
  try {
    cookie = typeof cookieToken === "object" && cookieToken !== null ? cookieToken : JSON.parse(cookieToken);
    if (typeof cookie !== "object" || cookie === null || Array.isArray(cookie)) {
      return {
        valid: false,
        message: `Cookie phải là JSON Raw object hợp lệ!`
      };
    }
  } catch (error) {
    return {
      valid: false,
      message: `Cookie không đúng định dạng JSON!`
    };
  }
  const imei = String(imeiToken || "").trim();
  if (!imei) {
    return {
      valid: false,
      message: `IMEI phải là chuỗi không rỗng!`
    };
  }
  let userAgent = uaTokens.join(" ") || defaultUserAgent;
  if (uaTokens[0] && !isValidUserAgent(uaTokens[0])) {
    userAgent = defaultUserAgent;
  }
  return {
    valid: true,
    credentials: { cookie, imei, userAgent }
  };
}

export function isValidUserAgent(userAgent) {
  if (typeof userAgent !== "string" || userAgent.trim() === "") return false;
  const commonPatterns = [/Mozilla/i, /Chrome/i, /Safari/i, /Firefox/i, /Edge/i, /Opera/i];
  return commonPatterns.some(pattern => pattern.test(userAgent)) && userAgent.length > 20;
}

export function createBotConfig(uidFrom, webPort) {
  return {
    "name": uidFrom,
    "configFilePath": `mybot/credentials/${uidFrom}.json`,
    "groupSettingsPath": `mybot/settings/groupSettings-${uidFrom}.json`,
    "adminFilePath": `mybot/configs/list_admin-${uidFrom}.json`,
    "commandFilePath": `mybot/json-data/command-${uidFrom}.json`,
    "MANAGER_FILE_PATH": `mybot/json-data/manager-${uidFrom}.json`,
    "DATA_GAME_FILE_PATH": `mybot/json-data/game_data-${uidFrom}.json`,
    "DATA_NT_PATH": `mybot/json-data/nong-trai-${uidFrom}.json`,
    "PROPHYLACTIC_CONFIG_PATH": `mybot/json-data/prophylactic-${uidFrom}.json`,
    "logDir": `logs/${uidFrom}`,
    "resourceDir": `assets/resources/${uidFrom}`,
    "tempDir": `assets/temp/${uidFrom}`,
    "dataGifPath": `assets/resources/gif/${uidFrom}`,
    "WEB_CONFIG_PATH": `mybot/json-data/web_config-${uidFrom}.json`,
    "webPort": webPort.toString(),
    "databaseFile": `mybot/json-data/database_config-${uidFrom}.json`,
    "dataTrainingPath": `mybot/json-data/data_training-${uidFrom}.json`,
    "rankInfoPath": `mybot/json-data/rank_info-${uidFrom}.json`
  };
}

export async function createAllRequiredFiles(uidFrom, args, botConfig, customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const dataDir = path.join(root, "mybot", "instances", String(uidFrom), "data");
  const runtimeContext = {
    ...createBotRuntimeContext({ ...botConfig, uid: uidFrom }),
    workspaceRoot: path.dirname(dataDir), dataDir,
    adminListPath: path.join(dataDir, "admin-list.json"),
    groupSettingsPath: path.join(dataDir, "group-settings.json"),
    commandConfigPath: path.join(dataDir, "command.json"),
    logsDir: path.join(path.dirname(dataDir), "logs"),
    tempDir: path.join(path.dirname(dataDir), "temp"),
    resourcesDir: path.join(path.dirname(dataDir), "resources"),
  };
  const myBotDirPath = path.join(root, "mybot");

  const legacyAdminFilePath = path.join(root, botConfig.adminFilePath);
  const runtimeAdminFilePath = runtimeContext.adminListPath;
  const isChild = uidFrom && String(uidFrom).trim().toLowerCase() !== "admin";

  let finalAdmins = [];
  if (isChild) {
    // Child bot: seed the admin list with the bot's own UID ONLY.
    // The owner/creator UID (from credentialsData.uid / uidFrom) is observed from
    // the Main session and is NOT a valid local UID in this child session — never
    // copy it into the child's admin list. Supreme admins are resolved through the
    // child's own session after login by canonical username. Existing verified
    // local admin list is preserved if present.
    if (runtimeAdminFilePath && fs.existsSync(runtimeAdminFilePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(runtimeAdminFilePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existing) && existing.length > 0) {
          finalAdmins = existing.map(String).map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== "admin");
        }
      } catch {}
    }
    if (finalAdmins.length === 0) {
      finalAdmins = [String(uidFrom).trim()].filter((s) => s && s.toLowerCase() !== "admin");
    }
  } else {
    const initialAdmins = getInitialAdminList(uidFrom, root);
    const mergedAdminSet = new Set(initialAdmins);

    if (fs.existsSync(legacyAdminFilePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(legacyAdminFilePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existing)) {
          for (const item of existing) {
            const uid = String(item).trim();
            if (uid && uid.toLowerCase() !== "admin") mergedAdminSet.add(uid);
          }
        }
      } catch {}
    }

    if (runtimeAdminFilePath && fs.existsSync(runtimeAdminFilePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(runtimeAdminFilePath, "utf8").replace(/^\uFEFF/, ""));
        if (Array.isArray(existing)) {
          for (const item of existing) {
            const uid = String(item).trim();
            if (uid && uid.toLowerCase() !== "admin") mergedAdminSet.add(uid);
          }
        }
      } catch {}
    }

    finalAdmins = Array.from(mergedAdminSet).filter(Boolean);
  }


  const requiredDirs = [
    path.join(myBotDirPath, "credentials"),
    path.join(myBotDirPath, "configs"),
    path.join(myBotDirPath, "settings"),
    path.join(myBotDirPath, "json-data"),
    path.join(myBotDirPath, "bots"),
    path.join(root, "logs", uidFrom),
    path.join(root, "assets", "resources", uidFrom),
    path.join(root, "assets", "temp", uidFrom),
    path.join(root, "assets", "resources", "gif", uidFrom),
    runtimeContext.workspaceRoot,
    runtimeContext.dataDir,
    runtimeContext.logsDir,
    runtimeContext.tempDir,
    runtimeContext.resourcesDir,
  ];
  requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });

  let credentialsData;
  if (args && typeof args === "object" && !Array.isArray(args) && (args.cookie || args.imei)) {
    credentialsData = args;
  } else {
    const validated = validateCredentials(args);
    if (validated.valid) {
      credentialsData = validated.credentials;
    } else {
      let imeiToken = args[0];
      let cookieToken = args[1];
      let uaTokens = args.slice(2);
      if (args.length >= 3 && !/^[{\[]/.test(String(args[1])) && /^[{\[]/.test(String(args[2]))) {
        imeiToken = args[1];
        cookieToken = args[2];
        uaTokens = args.slice(3);
      }
      let parsedCookie = {};
      try { parsedCookie = typeof cookieToken === "object" ? cookieToken : JSON.parse(cookieToken); } catch {}
      credentialsData = {
        cookie: parsedCookie,
        imei: String(imeiToken || ""),
        userAgent: uaTokens.join(" ") || "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
      };
    }
  }

  if (isChild && !fs.existsSync(runtimeAdminFilePath)) {
    finalAdmins = [String(credentialsData.accountUid || credentialsData.verifiedAccountUid || (/^\d+$/.test(String(uidFrom)) ? uidFrom : ""))].filter(Boolean);
  }
  const fileMap = {
    [path.join(root, botConfig.configFilePath)]: credentialsData,
    [path.join(root, botConfig.groupSettingsPath)]: {},
    [legacyAdminFilePath]: finalAdmins,
    [runtimeAdminFilePath]: finalAdmins,
    [runtimeContext.groupSettingsPath]: {},
    [path.join(root, botConfig.MANAGER_FILE_PATH)]: {
      "groupRequiredReset": "-1",
      "onGamePrivate": false,
      "onBotPrivate": false
    },
    [path.join(root, botConfig.DATA_GAME_FILE_PATH)]: {},
    [path.join(root, botConfig.PROPHYLACTIC_CONFIG_PATH)]: {
      "prophylacticUploadAttachment": {
        "enable": false,
        "lastBlocked": Date.now(),
        "numRequestZalo": 1,
        "lastRequestTime": Date.now()
      }
    },
    [path.join(root, botConfig.WEB_CONFIG_PATH)]: {
      selectedGroups: {},
      selectedFriends: {},
      privateEnabled: true,
      groupEnabled: true,
      prObjects: []
    },
    [path.join(root, botConfig.databaseFile)]: {
      "nameServer": "Thanh Hung",
      "host": "localhost",
      "user": "root",
      "password": "",
      "database": uidFrom === "admin" ? "nthdz" : `${uidFrom}`,
      "port": 3306,
      "tablePlayerZalo": "players_zalo",
      "tableAccount": "account",
      "dailyReward": 100000000000
    },
    [path.join(root, botConfig.dataTrainingPath)]: {},
    [path.join(root, botConfig.rankInfoPath)]: {}
  };

  for (const [filePath, data] of Object.entries(fileMap)) {
    try {
      if (filePath !== path.join(root, botConfig.configFilePath) && fs.existsSync(filePath)) continue;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (error) {
      throw new Error(`Không thể tạo file ${filePath}: ${error.message}`);
    }
  }

  const commandStateStub = JSON.stringify(createCommandSeedStub(), null, 2);
  const legacyCommandFilePath = path.join(root, botConfig.commandFilePath);
  try {
    fs.mkdirSync(path.dirname(legacyCommandFilePath), { recursive: true });
    if (!fs.existsSync(legacyCommandFilePath)) fs.writeFileSync(legacyCommandFilePath, commandStateStub);
    if (!fs.existsSync(runtimeContext.commandConfigPath)) fs.writeFileSync(runtimeContext.commandConfigPath, commandStateStub);
  } catch (error) {
    throw new Error(`Không thể tạo file command state cho bot: ${error.message}`);
  }

  const botConfigPath = path.join(myBotDirPath, "bots", `${uidFrom}.json`);
  try {
    if (!fs.existsSync(botConfigPath)) fs.writeFileSync(botConfigPath, JSON.stringify(botConfig, null, 4));
  } catch (error) {
    throw new Error(`Không thể tạo file config bot: ${error.message}`);
  }
}

export const createAllRequiredFilesWithCredentials = createAllRequiredFiles;

export async function saveBotToMyBots(uidFrom, dName, webPort, expiryTime, botName = "", botAvatar = "", extra = {}) {
  try {
    const root = getEffectiveRoot(extra?.projectRoot);
    const targetRegistryPath = extra?.registryPath || path.join(root, "mybot", "mybots.json");
    let myBots = {};
    if (fs.existsSync(targetRegistryPath)) {
      try {
        myBots = JSON.parse(fs.readFileSync(targetRegistryPath, "utf8").replace(/^\uFEFF/, ""));
      } catch {}
    }
    const existing = myBots[uidFrom] || {};
    const expiryFormatted = expiryTime
      ? (typeof expiryTime === "string" ? expiryTime : (expiryTime.toISOString ? expiryTime.toISOString() : String(expiryTime)))
      : (existing.expiryAt || null);

    const zaloUsername = extra?.zaloUsername || extra?.username || existing.zaloUsername || null;
    const canonicalUsername = zaloUsername ? String(zaloUsername).trim().replace(/^@+/, "").normalize("NFKC").toLowerCase() : (existing.canonicalUsername || null);
    const globalUid = extra?.globalUid || existing.globalUid || null;

    myBots[uidFrom] = {
      name: botName || existing.name || uidFrom,
      displayName: dName || existing.displayName || uidFrom,
      avatar: botAvatar || existing.avatar || null,
      ownerUid: extra?.ownerUid || existing.ownerUid || (/^\d{10,}$/.test(String(existing.createdBy || "")) ? existing.createdBy : null) || uidFrom,
      createdByUid: extra?.createdByUid || existing.createdByUid || extra?.ownerUid || existing.ownerUid || uidFrom,
      ownerName: extra?.ownerName || existing.ownerName || dName,
      createdBy: existing.createdBy || dName,
      createdAt: existing.createdAt || new Date().toISOString(),
      expiryAt: expiryFormatted,
      trialStatus: existing.trialStatus || (expiryFormatted ? "active" : "pending"),
      trialStartedAt: existing.trialStartedAt || null,
      trialDurationMs: existing.trialDurationMs || 3600000,
      webPort: webPort ? webPort.toString() : (existing.webPort || "4444"),
      status: "stopped",
      pid: null,
      consolePid: null,
      database: uidFrom === "admin" ? "nthdz" : (existing.database || uidFrom),
      uid: extra?.uid || existing.uid || uidFrom,
      isMain: uidFrom === "admin" || existing.isMain === true,
      zaloUsername,
      canonicalUsername,
      globalUid,
      ...extra
    };
    if (myBots[uidFrom].registryPath) delete myBots[uidFrom].registryPath;

    fs.mkdirSync(path.dirname(targetRegistryPath), { recursive: true });
    writeJsonAtomic(targetRegistryPath, myBots);
    console.log(`Đã lưu thông tin bot ${uidFrom} vào mybots.json`);
    return myBots[uidFrom];
  } catch (error) {
    console.error(`Lỗi khi lưu thông tin bot: ${error.message}`);
    throw error;
  }
}

export async function ensureDirectoriesExist(customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotDir, botsDir, myBotsPath } = getMyBotPaths(root);
  const directories = [
    myBotDir,
    botsDir,
    path.join(myBotDir, "credentials"),
    path.join(myBotDir, "configs"),
    path.join(myBotDir, "settings"),
    path.join(myBotDir, "json-data"),
    path.join(root, "mybot", "state")
  ];
  directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
  if (!fs.existsSync(myBotsPath)) {
    writeJsonAtomic(myBotsPath, {});
  }
}

export async function fixCredentialPaths(customRoot = null) {
  const root = getEffectiveRoot(customRoot);
  const { myBotDir, botsDir, myBotsPath } = getMyBotPaths(root);
  try {
    if (!fs.existsSync(myBotsPath) || !fs.existsSync(botsDir)) return;
    const myBots = JSON.parse(fs.readFileSync(myBotsPath, "utf8"));
    const credDir = path.join(myBotDir, "credentials");
    if (!fs.existsSync(credDir)) return;

    for (const [uid] of Object.entries(myBots)) {
      if (uid === "admin") continue;
      const expectedCred = path.join(credDir, `${uid}.json`);
      if (!fs.existsSync(expectedCred)) {
        console.warn(`[FIX] Thiếu credential cho bot ${uid}: ${expectedCred}. Không tự sao chép credential khác để tránh lệch session.`);
      }
    }
  } catch (error) {
    console.error(`Lỗi fix credential paths: ${error.message}`);
  }
}

export async function writeCredentialOnly(uid, credentialsData, customRoot = null) {
  if (!uid) throw new Error("uid is required");
  const root = getEffectiveRoot(customRoot);
  const { myBotDir } = getMyBotPaths(root);
  if (uid !== "admin" && credentialsLookLikeAdmin(credentialsData, root)) {
    throw new Error(`Refuse to write admin credential into child bot ${uid}`);
  }
  const credentialPath = uid === "admin"
    ? path.join(root, "assets", "config.json")
    : path.join(myBotDir, "credentials", `${uid}.json`);
  writeJsonAtomic(credentialPath, credentialsData);
}

export async function requestCredentialReload(uid, request = {}) {
  if (!uid) throw new Error("uid is required");
  const requestId = request.requestId || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return writeReloadRequest(uid, {
    ...request,
    requestId,
    uid,
    status: "requested",
  });
}

export async function waitForIdentityHandshake(sessionId, timeoutMs = 30000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const handshake = readIdentityHandshake(sessionId);
    if (["ready", "auth_failed", "timeout"].includes(handshake.status)) {
      return handshake;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    ...readIdentityHandshake(sessionId),
    sessionId,
    status: "timeout",
    updatedAt: new Date().toISOString(),
    error: "Timed out waiting for bootstrap identity handshake",
  };
}



