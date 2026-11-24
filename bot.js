/*@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
                   _ooOoo_
                  o8888888o
                  88" . "88
                  (| -_- |)
                  O\  =  /O
               ____/`---'\____
             .'  \\|     |//  `.
            /  \\|||  :  |||//  \
           /  _||||| -:- |||||-  \
           |   | \\\  -  /// |   |
           | \_|  ''\---/''  |   |
           \  .-\__  `-`  ___/-. /
         ___`. .'  /--.--\  `. . __
      ."" '<  `.___\_<|>_/___.'  >'"".
     | | :  `- \`.;`\ _ /`;.`/ - ` : | |
     \  \ `-.   \_ __\ /__ _/   .-` /  /
======`-.____`-.___\_____/___.-`____.-'======
                   `=---='
^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  PHẬT ĐỘ, CODE Không LỖI, TỐI ƯU Không BUG
            DEVELOPER: SBT
@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@*/

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import { loadProviderEnvironment, printRuntimeFingerprint } from './src/bootstrap.js';
import { fixCredentialPaths, startBotWithLauncher } from './src/commands/mybot/System/pm2-manager.js';
import { getAutoRestoreCandidates } from './src/commands/mybot/System/mybot-auto-restore.js';
import { stripAnsi, terminalLog } from './src/utils/terminal-log.js';
import { createRestartCoordinator } from './src/utils/restart-coordinator.js';
const isWindows = process.platform === 'win32';
import { ensureLogFiles, logManagerBot } from './src/utils/io-json.js';

loadProviderEnvironment();
printRuntimeFingerprint({ entrypoint: "bot.js" });
const { startDirect } = await import('./index.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname);
const ACTION_FLAG = path.join(PROJECT_ROOT, '.bot-action');
const PID_FILE = path.join(PROJECT_ROOT, '.bot.pid');
const MYBOTS_PATH = path.join(PROJECT_ROOT, 'mybot', 'mybots.json');
const BOT_STATE_DIR = path.join(PROJECT_ROOT, 'mybot', 'state');
const DEAD_COOKIE_NOTIFICATIONS = path.join(BOT_STATE_DIR, 'dead-cookie-notifications.json');
const COOKIE_DEAD_FLAG = 'cookieDead';
const COOKIE_DEAD_EXIT_CODE = 12;
function writePid(pid) {
  try {
    fs.writeFileSync(PID_FILE, String(pid), 'utf-8');
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

function clearActionFlag() {
  try {
    if (fs.existsSync(ACTION_FLAG)) {
      fs.unlinkSync(ACTION_FLAG);
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

function getRequestedAction() {
  try {
    if (fs.existsSync(ACTION_FLAG)) {
      return fs.readFileSync(ACTION_FLAG, 'utf-8').trim();
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
  return null;
}

function requestAction(action) {
  try {
    fs.writeFileSync(ACTION_FLAG, action, 'utf-8');
  } catch (e) {
    console.error(`Cannot write action flag: ${e.message}`);
  }
}

function clearPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

function readPid() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      return isNaN(pid) ? null : pid;
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
  return null;
}

function ensureStateDir() {
  try {
    if (!fs.existsSync(BOT_STATE_DIR)) {
      fs.mkdirSync(BOT_STATE_DIR, { recursive: true });
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

function writeBotState(uid, state) {
  ensureStateDir();
  try {
    const statePath = path.join(BOT_STATE_DIR, `${uid}.json`);
    let existingState = {};
    if (fs.existsSync(statePath)) {
      existingState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
    const mergedState = { ...existingState, ...state };
    fs.writeFileSync(statePath, JSON.stringify(mergedState, null, 2), 'utf-8');
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

function readBotState(uid) {
  try {
    const statePath = path.join(BOT_STATE_DIR, `${uid}.json`);
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
  return null;
}

function removeBotState(uid) {
  try {
    const statePath = path.join(BOT_STATE_DIR, `${uid}.json`);
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

function isCookieDead(uid) {
  const state = readBotState(uid);
  return state && state[COOKIE_DEAD_FLAG] === true;
}

function isMainBotCookieDead() {
  try {
    const statePath = path.join(BOT_STATE_DIR, 'admin.json');
    if (!fs.existsSync(statePath)) return false;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    return state[COOKIE_DEAD_FLAG] === true;
  } catch (e) {
    return false;
  }
}

function markCookieDead(uid) {
  writeBotState(uid, { [COOKIE_DEAD_FLAG]: true, timestamp: new Date().toISOString() });
}

function clearCookieDead(uid) {
  const state = readBotState(uid);
  if (state) {
    delete state[COOKIE_DEAD_FLAG];
    writeBotState(uid, state);
  }
}

function writeDeadCookieNotification(uid, displayName, reason) {
  try {
    if (!fs.existsSync(BOT_STATE_DIR)) {
      fs.mkdirSync(BOT_STATE_DIR, { recursive: true });
    }
    let notifications = [];
    if (fs.existsSync(DEAD_COOKIE_NOTIFICATIONS)) {
      try {
        notifications = JSON.parse(fs.readFileSync(DEAD_COOKIE_NOTIFICATIONS, 'utf-8'));
      } catch (e) {}
    }
    notifications.push({
      uid,
      displayName: displayName || uid,
      reason: reason || 'Cookie đã chết hoặc bot không khởi động được',
      timestamp: new Date().toISOString()
    });
    fs.writeFileSync(DEAD_COOKIE_NOTIFICATIONS, JSON.stringify(notifications, null, 2), 'utf-8');
  } catch (e) {
    console.error(`Lỗi ghi thông báo cookie dead: ${e.message}`);
  }
}

function getDeadCookieNotifications() {
  try {
    if (!fs.existsSync(DEAD_COOKIE_NOTIFICATIONS)) return [];
    return JSON.parse(fs.readFileSync(DEAD_COOKIE_NOTIFICATIONS, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function clearDeadCookieNotifications() {
  try {
    if (fs.existsSync(DEAD_COOKIE_NOTIFICATIONS)) {
      fs.unlinkSync(DEAD_COOKIE_NOTIFICATIONS);
    }
  } catch (e) {
    console.error("Bot state error:", e.message);
  }
}

const childBots = new Map();

function cleanupBotFiles(uid) {
  const botConfigPath = path.join(PROJECT_ROOT, 'mybot', 'bots', `${uid}.json`);
  const credPath = path.join(PROJECT_ROOT, 'mybot', 'credentials', `${uid}.json`);
  const groupSettingsPath = path.join(PROJECT_ROOT, 'mybot', 'settings', `groupSettings-${uid}.json`);
  const adminFilePath = path.join(PROJECT_ROOT, 'mybot', 'configs', `list_admin-${uid}.json`);
  const commandFilePath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `command-${uid}.json`);
  const managerFilePath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `manager-${uid}.json`);
  const dataGamePath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `game_data-${uid}.json`);
  const prophylacticPath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `prophylactic-${uid}.json`);
  const webConfigPath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `web_config-${uid}.json`);
  const databaseFile = path.join(PROJECT_ROOT, 'mybot', 'json-data', `database_config-${uid}.json`);
  const dataTrainingPath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `data_training-${uid}.json`);
  const rankInfoPath = path.join(PROJECT_ROOT, 'mybot', 'json-data', `rank_info-${uid}.json`);
  const logDir = path.join(PROJECT_ROOT, 'logs', uid);
  const resourceDir = path.join(PROJECT_ROOT, 'assets', 'resources', uid);
  const tempDir = path.join(PROJECT_ROOT, 'assets', 'temp', uid);
  const gifDir = path.join(PROJECT_ROOT, 'assets', 'resources', 'gif', uid);

  [botConfigPath, credPath, groupSettingsPath, adminFilePath, commandFilePath,
   managerFilePath, dataGamePath, prophylacticPath, webConfigPath, databaseFile,
   dataTrainingPath, rankInfoPath
  ].forEach(p => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.error("Bot state error:", e.message); } });

  [logDir, resourceDir, tempDir, gifDir].forEach(d => {
    try { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); } catch (e) { console.error("Bot state error:", e.message); }
  });
}

async function removeBotFromMyBots(uid) {
  try {
    if (!fs.existsSync(MYBOTS_PATH)) return;
    const myBots = JSON.parse(fs.readFileSync(MYBOTS_PATH, 'utf-8'));
    if (myBots[uid]) {
      delete myBots[uid];
      fs.writeFileSync(MYBOTS_PATH, JSON.stringify(myBots, null, 2));
      console.log(`Đã xóa bot ${uid} khỏi mybots.json`);
    }
  } catch (e) {
    console.error(`Lỗi xóa bot khỏi mybots.json: ${e.message}`);
  }
}

async function cleanupDeadChildBot(uid, botInfo, reason) {
  if (!uid || uid === 'admin') return;
  const displayName = botInfo?.displayName || uid;
  try {
    if (fs.existsSync(MYBOTS_PATH)) {
      const myBots = JSON.parse(fs.readFileSync(MYBOTS_PATH, 'utf-8'));
      if (myBots[uid]) {
        delete myBots[uid];
        fs.writeFileSync(MYBOTS_PATH, JSON.stringify(myBots, null, 2));
      }
    }
  } catch (e) {
    console.error(`[COOKIE-DEAD] Không thể xóa registry ${uid}: ${e.message}`);
  }
  try {
    const descriptorPath = path.join(PROJECT_ROOT, 'mybot', 'bots', `${uid}.json`);
    if (fs.existsSync(descriptorPath)) fs.unlinkSync(descriptorPath);
  } catch (e) {
    console.error(`[COOKIE-DEAD] Không thể xóa descriptor ${uid}: ${e.message}`);
  }
  writeDeadCookieNotification(uid, displayName, reason);
  console.log(`[COOKIE-DEAD] Đã cleanup registry/descriptor cho bot ${displayName} (${uid}): ${reason}`);
  logManagerBot(`[COOKIE-DEAD] Cleanup child bot ${uid}: ${reason}`);
}

async function stopChildBot(uid) {
  const info = childBots.get(uid);
  let pid = info?.pid;
  if (!pid) {
    const stateFile = path.join(BOT_STATE_DIR, `${uid}.json`);
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        pid = state.pid ? parseInt(state.pid) : null;
      } catch (e) {
        console.error("Bot state error:", e.message);
      }
    }
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      await new Promise(r => setTimeout(r, 2000));
      try { process.kill(pid, 0); } catch (e) {
        console.error("Bot state error:", e.message);
      }
    } catch (e) {
      console.error("Bot state error:", e.message);
    }
  }
  childBots.delete(uid);
}

async function stopDeadCookieBot(uid, reason) {
  console.log(`[COOKIE-DEAD] Dừng bot ${uid}: ${reason}`);
  logManagerBot(`[COOKIE-DEAD] Dừng bot ${uid}: ${reason}`);
  let displayName = uid;
  try {
    const myBots = JSON.parse(fs.readFileSync(MYBOTS_PATH, 'utf-8'));
    displayName = myBots[uid]?.displayName || uid;
  } catch (e) {}
  await stopChildBot(uid);
  writeBotState(uid, {
    [COOKIE_DEAD_FLAG]: true,
    cookieDeadAt: new Date().toISOString(),
    cookieDeadReason: reason,
  });
  writeDeadCookieNotification(uid, displayName, reason);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function isBotConfigExists(uid) {
  const cfgPath = path.join(PROJECT_ROOT, 'mybot', 'bots', `${uid}.json`);
  return fs.existsSync(cfgPath);
}

async function checkChildBotHealth() {
  if (!fs.existsSync(MYBOTS_PATH)) return;
  const myBots = JSON.parse(fs.readFileSync(MYBOTS_PATH, 'utf-8'));
  for (const [uid, info] of childBots.entries()) {
    const botInfo = myBots[uid];
    if (!botInfo) {
      childBots.delete(uid);
      continue;
    }
    if (!isBotConfigExists(uid)) {
      console.warn(`Bot ${uid} không có file cấu hình, xóa khỏi danh sách theo dõi`);
      childBots.delete(uid);
      continue;
    }
    const webPort = parseInt(botInfo.webPort);
    if (!webPort) continue;

    const portOk = await isPortInUse(webPort);
    if (portOk) {
      info.deadAt = undefined;
      continue;
    }

    const deadAt = info.deadAt || Date.now();
    if (!info.deadAt) {
      info.deadAt = deadAt;
      console.log(`Bot ${uid} port ${webPort} không mở, chờ 10s xác nhận...`);
      await new Promise(r => setTimeout(r, 10000));
    }

    const portOkAgain = await isPortInUse(webPort);
    if (portOkAgain) {
      info.deadAt = undefined;
      continue;
    }

    const uptime = Date.now() - info.startedAt;
    const cookieDead = isCookieDead(uid) || uptime < 60000;

    if (cookieDead) {
      await stopDeadCookieBot(uid, 'Cookie đã chết hoặc bot không khởi động được');
    } else {
      console.log(`Bot ${uid} dừng sau ${Math.floor(uptime / 1000)}s, thử khởi động lại...`);
      logManagerBot(`Bot ${uid} dừng, thử khởi động lại...`);
      clearCookieDead(uid);
      childBots.delete(uid);
      try {
        const bootstrapPath = path.join(PROJECT_ROOT, 'src', 'bootstrap.js');
        startDirect(bootstrapPath, uid);
        childBots.set(uid, { pid: null, bootstrapPath, startedAt: Date.now(), deadAt: undefined });
      } catch (e) {
        console.error(`Không thể khởi động lại bot ${uid}:`, e.message);
        await stopDeadCookieBot(uid, `Không thể khởi động lại: ${e.message}`);
      }
    }
  }
}

let botProcess;
let childStartupTimer = null;
let pendingRestartTimer = null;
let restartCoordinator;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const BASE_RESTART_DELAY = 3000;
const STOP_TIMEOUT = 10000;
const BOT_OUTPUT_LOG = path.join(PROJECT_ROOT, 'logs', 'bot-stdout.log');

function getRestartDelay() {
  if (consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return 1000;
  return Math.min(BASE_RESTART_DELAY * Math.pow(2, consecutiveFailures - MAX_CONSECUTIVE_FAILURES), 60000);
}

function startBot() {
  clearActionFlag();
  clearPid();
  if (childStartupTimer) {
    clearTimeout(childStartupTimer);
    childStartupTimer = null;
  }
  const startupGeneration = restartCoordinator?.getState().generation ?? 0;
  const stdoutLog = fs.createWriteStream(BOT_OUTPUT_LOG, { flags: 'a' });
  const bootstrapPath = path.join(PROJECT_ROOT, 'src', 'bootstrap.js');
  const childEnv = {
    ...process.env,
    MYBOT_INSTANCE_KIND: 'main',
    BOT_NAME: 'admin',
    CONFIG_PATH: path.join(PROJECT_ROOT, 'assets', 'config.json'),
    BOT_MANAGED: 'true',
    PROJECT_ROOT,
    ProjectRoot: PROJECT_ROOT,
  };
  if (process.stdout.isTTY && process.env.NO_COLOR === undefined) {
    childEnv.MYBOT_FORCE_COLOR = process.env.MYBOT_FORCE_COLOR || process.env.FORCE_COLOR || '1';
  }
  terminalLog({ scope: 'launcher', level: 'info', title: 'Starting bot listener', lines: [`node ${bootstrapPath}`, `log: ${BOT_OUTPUT_LOG}`] });
  botProcess = spawn(process.execPath, [bootstrapPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
    shell: false,
    windowsHide: true,
  });
  const processHandle = botProcess;
  processHandle.stdout.on("data", (chunk) => stdoutLog.write(stripAnsi(chunk.toString())));
  processHandle.stderr.on("data", (chunk) => stdoutLog.write(stripAnsi(chunk.toString())));
  botProcess.stdout.pipe(process.stdout);
  botProcess.stderr.pipe(process.stderr);
  processHandle.on("exit", () => {
    try { stdoutLog.end(); } catch (e) {
      console.error("Bot state error:", e.message);
    }
  });
  writePid(processHandle.pid);
  attachBotEvents(processHandle);
  logManagerBot("Bot started");
  terminalLog({ scope: "launcher", level: "success", title: "Bot process started", lines: [`pid: ${processHandle.pid}`] });
  childStartupTimer = setTimeout(async () => {
    childStartupTimer = null;
    if (botProcess !== processHandle || restartCoordinator?.getState().generation !== startupGeneration) return;
    await fixCredentialPaths();
    if (botProcess === processHandle && restartCoordinator?.getState().generation === startupGeneration) {
      await startChildBots();
    }
  }, 5000);
  return processHandle;
}

async function startChildBots() {
  const myBotsPath = path.join(PROJECT_ROOT, 'mybot', 'mybots.json');
  if (!fs.existsSync(myBotsPath)) {
    console.log('mybots.json not found, skipping child bots');
    return;
  }
  let myBots;
  try {
    myBots = JSON.parse(fs.readFileSync(myBotsPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error('Failed to read mybots.json:', e.message);
    return;
  }

  const candidates = getAutoRestoreCandidates(myBots, { projectRoot: PROJECT_ROOT });
  let startedCount = 0;
  for (const botInfo of candidates) {
    const uid = botInfo.uid;
    const state = readBotState(uid);
    if (state && state[COOKIE_DEAD_FLAG] === true) {
      await cleanupDeadChildBot(uid, botInfo, state.cookieDeadReason || 'Cookie đã chết trước khi khởi động');
      continue;
    }
    const webPort = parseInt(botInfo.webPort, 10);
    if (webPort && (await isPortInUse(webPort))) {
      console.log(`Bot ${botInfo.displayName || uid} (${uid}) is already running on port ${webPort}, skipping`);
      continue;
    }
    if (childBots.has(uid)) {
      console.log(`Bot ${uid} đã được theo dõi, bỏ qua`);
      continue;
    }
    const botConfigPath = path.join(PROJECT_ROOT, 'mybot', 'bots', `${uid}.json`);
    if (!fs.existsSync(botConfigPath)) {
      console.warn(`Bot ${uid} không có file cấu hình tại ${botConfigPath}, xóa khỏi mybots.json và bỏ qua`);
      delete myBots[uid];
      fs.writeFileSync(myBotsPath, JSON.stringify(myBots, null, 2));
      continue;
    }
    console.log(`Starting child bot in terminal: ${botInfo.displayName || uid} (${uid})`);
    try {
      const result = await startBotWithLauncher(uid, {
        displayName: botInfo.displayName || botInfo.name || uid,
        botName: botInfo.name || uid,
      });

      if (result === true || result?.success === true) {
        startedCount++;
        const nodePid = result?.pid ? parseInt(result.pid, 10) : undefined;
        childBots.set(uid, { pid: nodePid, bootstrapPath: path.join(PROJECT_ROOT, 'src', 'bootstrap.js'), startedAt: Date.now(), deadAt: undefined });
        writeBotState(uid, { [COOKIE_DEAD_FLAG]: false, startedAt: Date.now() });
        clearCookieDead(uid);
        console.log(`Bot ${uid} auto-restored successfully in terminal`);
      } else {
        console.warn(`Failed to auto-restore child bot ${uid}: ${result?.reason || "launcher returned false"}`);
      }
    } catch (e) {
      console.error(`Failed to start child bot ${uid}:`, e.message);
    }
  }
  console.log(`Started ${startedCount} child bot(s)`);
}

async function verifyChildBotStartup(uid, botInfo, spawnPid) {
  const webPort = parseInt(botInfo.webPort);
  if (!webPort) return;

  const maxWait = 30000;
  const startTime = Date.now();
  const checkInterval = 3000;

  while (Date.now() - startTime < maxWait) {
    await new Promise(r => setTimeout(r, checkInterval));

    const portOk = await isPortInUse(webPort);
    if (portOk) {
      console.log(`Bot ${uid} khởi động thành công trên port ${webPort}`);
      return;
    }

    const state = readBotState(uid);
    const actualPid = state?.pid ? parseInt(state.pid) : null;
    let processAlive = false;
    if (actualPid) {
      try {
        process.kill(actualPid, 0);
        processAlive = true;
      } catch (e) {
        if (e.code === 'EPERM') processAlive = true;
      }
    }

    if (!processAlive && actualPid) {
      const cookieDead = state && state[COOKIE_DEAD_FLAG] === true;
      if (cookieDead) {
        console.log(`[COOKIE-DEAD] Bot ${uid} cookie die trong quá trình khởi động`);
        await stopDeadCookieBot(uid, 'Cookie đã chết hoặc bot không khởi động được');
      } else {
        console.log(`Bot ${uid} process dừng trong quá trình khởi động, giữ nguyên dữ liệu...`);
        await stopDeadCookieBot(uid, 'Bot không khởi động được');
      }
      return;
    }
  }

  console.log(`Bot ${uid} chưa sẵn sàng sau ${maxWait / 1000}s, sẽ kiểm tra lại sau`);
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.connect(port, '127.0.0.1', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(2000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function waitForProcessExit(processHandle, timeout = STOP_TIMEOUT) {
  if (!processHandle?.pid || processHandle.exitCode !== null || !isProcessAlive(processHandle.pid)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error = null) => {
      clearTimeout(timer);
      processHandle.removeListener('exit', onExit);
      processHandle.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = (error) => finish(error);
    timer = setTimeout(() => finish(new Error(`Timed out waiting for bot PID ${processHandle.pid} to exit`)), timeout);
    processHandle.once('exit', onExit);
    processHandle.once('error', onError);
  });
}

function stopBot(processHandle = botProcess) {
  if (!processHandle?.pid || !isProcessAlive(processHandle.pid)) return Promise.resolve();

  const pid = String(processHandle.pid);
  const terminate = () => {
    try {
      process.kill(processHandle.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') return Promise.reject(error);
    }
    return waitForProcessExit(processHandle).catch((error) => {
      try { process.kill(processHandle.pid, 'SIGKILL'); } catch {}
      throw error;
    });
  };

  return terminate()
    .then(() => {
      logManagerBot('Bot stopped');
      terminalLog({ scope: 'launcher', level: 'info', title: 'Bot stopped', lines: [`pid: ${pid}`] });
    })
    .catch((error) => {
      logManagerBot(`Failed to stop bot: ${error.message}`);
      terminalLog({ scope: 'launcher', level: 'error', title: 'Failed to stop bot', lines: [error.message] });
      throw error;
    });
}

function clearPendingRestartTimer() {
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }
}

function scheduleRestart(reason, processHandle, delay) {
  if (pendingRestartTimer || restartCoordinator?.getState().inFlight) return;
  pendingRestartTimer = setTimeout(() => {
    pendingRestartTimer = null;
    restartBot(reason, processHandle, 0);
  }, Math.max(0, delay));
}

function restartBot(reason = 'manual', processHandle = botProcess, delay = null) {
  clearPendingRestartTimer();
  if (childStartupTimer) {
    clearTimeout(childStartupTimer);
    childStartupTimer = null;
  }
  const context = {
    processHandle,
    delayMs: delay ?? (reason === 'crash' ? getRestartDelay() : 1000),
  };
  const operation = restartCoordinator.restart(reason, context);
  operation.then(() => {
    if (reason !== 'crash') consecutiveFailures = 0;
    logManagerBot('Bot restarted');
    terminalLog({ scope: 'launcher', level: 'info', title: 'Bot restarted', lines: [] });
  }).catch((error) => {
    terminalLog({ scope: 'launcher', level: 'error', title: 'Bot restart failed', lines: [error.message] });
  });
  return operation;
}

restartCoordinator = createRestartCoordinator({
  stop: (context) => stopBot(context?.processHandle),
  start: () => startBot(),
  delayMs: ({ context }) => context?.delayMs ?? 1000,
});

ensureLogFiles();

// When BOT_MANAGED=true, the bot is controlled by PM2 and MUST NOT:
// - Spawn itself (run.bat / reconcile-and-monitor.js handles the fleet via PM2)
// - Auto-restore child bots (PM2 resurrect handles that)
// - Start child bots (same reason)
if (process.env.BOT_MANAGED === 'true') {
  // Bot is managed by PM2 — register signal handlers and exit cleanly.
  // PM2 will handle restart via its autorestart policy.
  logManagerBot('[LAUNCHER] Running under BOT_MANAGED=true — lifecycle managed by PM2, no self-start');
  process.on('SIGINT', () => { process.exit(0); });
  process.on('SIGTERM', () => { process.exit(0); });
  // No return — module top-level return is invalid in ESM.
  // Execution simply stops here; PM2 owns the lifecycle.
} else {
  startBot();
}

function attachBotEvents(processHandle) {
  processHandle.on('error', (err) => {
    if (processHandle !== botProcess) return;
    logManagerBot(`Bot gặp lỗi: ${err.message}`);
    terminalLog({ scope: 'launcher', level: 'error', title: 'Bot process error', lines: [err.message], countAsRetry: true });
    const action = getRequestedAction();
    if (!action || action === 'restart') {
      scheduleRestart('error', processHandle, getRestartDelay());
    }
  });

  processHandle.on('exit', (code) => {
    if (processHandle !== botProcess || restartCoordinator?.getState().inFlight) return;
    const action = getRequestedAction();
    if (action === 'stop') {
      consecutiveFailures = 0;
      logManagerBot(`Bot đã tắt theo yêu cầu (mã: ${code})`);
      terminalLog({ scope: 'launcher', level: 'info', title: 'Bot stopped by request', lines: [`exit code: ${code}`] });
      clearActionFlag();
      setTimeout(() => process.exit(0), 500);
      return;
    }
    if (action === 'restart') {
      consecutiveFailures = 0;
      logManagerBot(`Bot đang khởi động lại (mã: ${code})`);
      terminalLog({ scope: 'launcher', level: 'info', title: 'Bot restarting by request', lines: [`exit code: ${code}`] });
      clearActionFlag();
      restartBot('requested', processHandle, 1000);
      return;
    }
    const CTRL_C_EXIT = 0xC000013A;
    const ACCESS_VIOLATION_EXIT = 3221225786;
    const isCtrlCExit = code === CTRL_C_EXIT;
    const isAccessViolation = code === ACCESS_VIOLATION_EXIT;
    if (isCtrlCExit) {
      logManagerBot('Main bot đã thoát do CTRL+C, dừng vòng restart');
      terminalLog({ scope: 'launcher', level: 'warn', title: 'Bot exited by CTRL+C', lines: ['restart loop stopped'] });
      consecutiveFailures = 0;
      return;
    }
    if (code === COOKIE_DEAD_EXIT_CODE) {
      logManagerBot('Main bot cookie dead, dừng vòng restart và trả quyền cho run.bat');
      terminalLog({ scope: 'launcher', level: 'warn', title: 'Main bot cookie expired', lines: ['returning control to run.bat'] });
      consecutiveFailures = 0;
      clearActionFlag();
      setTimeout(() => process.exit(COOKIE_DEAD_EXIT_CODE), 500);
      return;
    }
    if (code === 1 && isMainBotCookieDead() && consecutiveFailures < MAX_CONSECUTIVE_FAILURES) {
      logManagerBot('Main bot cookie dead, dừng vòng restart');
      terminalLog({ scope: 'launcher', level: 'warn', title: 'Main bot cookie expired', lines: ['restart loop stopped'] });
      consecutiveFailures = 0;
      return;
    }
    if (isAccessViolation) {
      logManagerBot(`[WARN] Bot gặp lỗi truy cập bộ nhớ (0xC0000006), thử khởi động lại...`);
      terminalLog({ scope: 'launcher', level: 'warn', title: 'Access violation detected', lines: ['0xC0000006; restarting'] });
    }
    consecutiveFailures++;
    logManagerBot(`Bot đã thoát với mã: ${code} (lần thất bại liên tiếp: ${consecutiveFailures})`);
    terminalLog({ scope: 'launcher', level: 'error', title: 'Bot exited', lines: [`exit code: ${code}`, `consecutive failures: ${consecutiveFailures}`], countAsRetry: true });
    const delay = getRestartDelay();
    if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      logManagerBot(`Bot crash ${consecutiveFailures} lần liên tiếp. Dừng restart.`);
      terminalLog({ scope: 'launcher', level: 'error', title: 'Restart loop stopped', lines: [`crashes: ${consecutiveFailures}`] });
      setTimeout(() => process.exit(1), 1000);
      return;
    }
    scheduleRestart('crash', processHandle, delay);
  });
}

setInterval(() => {
  const action = getRequestedAction();
  if (!action) {
    checkChildBotHealth();
  }
}, 1800000);//30p

setInterval(() => {
  const action = getRequestedAction();
  if (!action) {
    checkRecentBotStartups();
  }
}, 60000);//1p

async function checkRecentBotStartups() {
  const now = Date.now();
  const recentThreshold = 10 * 60 * 1000; // 10 phút
  for (const [uid, info] of childBots.entries()) {
    if (now - info.startedAt < recentThreshold) {
      if (!isBotConfigExists(uid)) {
        childBots.delete(uid);
        continue;
      }
      let myBots = {};
      try {
        myBots = JSON.parse(fs.readFileSync(MYBOTS_PATH, 'utf-8'));
      } catch (e) {
        console.error("Bot state error:", e.message);
      }
      const botInfo = myBots[uid];
      if (!botInfo) continue;
      const webPort = parseInt(botInfo.webPort);
      if (!webPort) continue;
      const portOk = await isPortInUse(webPort);
      if (portOk) {
        info.deadAt = undefined;
        continue;
      }
      const state = readBotState(uid);
      const actualPid = state?.pid ? parseInt(state.pid) : null;
      let processAlive = false;
      if (actualPid) {
        try {
          process.kill(actualPid, 0);
          processAlive = true;
        } catch (e) {
          if (e.code === 'EPERM') processAlive = true;
        }
      }
      if (!processAlive && actualPid) {
        const cookieDead = state && state[COOKIE_DEAD_FLAG] === true;
        if (cookieDead) {
          await stopDeadCookieBot(uid, 'Cookie đã chết hoặc bot không khởi động được');
        }
      }
    }
  }
}

process.on('SIGINT', () => {
  const action = getRequestedAction();
  if (action === 'stop') {
    terminalLog({ scope: 'launcher', level: 'info', title: 'SIGINT stop request', lines: ['exiting launcher'] });
    clearActionFlag();
    process.exit(0);
    return;
  }
  if (action === 'restart') {
    terminalLog({ scope: 'launcher', level: 'info', title: 'SIGINT restart request', lines: [] });
    clearActionFlag();
    restartBot('signal', botProcess, 1000);
    return;
  }
  terminalLog({ scope: 'launcher', level: 'warn', title: 'SIGINT received', lines: ['no explicit action; exiting'] });
  process.exit(0);
});

process.on('SIGTERM', () => {
  const action = getRequestedAction();
  if (action === 'stop') {
    terminalLog({ scope: 'launcher', level: 'info', title: 'SIGTERM stop request', lines: ['exiting launcher'] });
    clearActionFlag();
    process.exit(0);
    return;
  }
  if (action === 'restart') {
    terminalLog({ scope: 'launcher', level: 'info', title: 'SIGTERM restart request', lines: [] });
    clearActionFlag();
    restartBot('signal', botProcess, 1000);
    return;
  }
  terminalLog({ scope: 'launcher', level: 'warn', title: 'SIGTERM received', lines: ['no explicit action; exiting'] });
  process.exit(0);
});

export { requestAction };

