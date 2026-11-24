import fs from "fs";
import path from "path";
import {
  loadPendingTasks,
  savePendingTasks,
  addPendingTask,
  removePendingTask,
  incrementTaskRetry,
  getPendingTask
} from "./task-persistence.js";
import { logManagerBot } from "../utils/io-json.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";

export { loadPendingTasks };

export const RESTART_EXIT_CODE = 10;

function resolveSwitchFlagPath() {
  try {
    const ctx = getRuntimeContext();
    if (ctx?.stateDir) {
      fs.mkdirSync(ctx.stateDir, { recursive: true });
      return path.join(ctx.stateDir, ".bot-switch");
    }
  } catch {}
  return path.join(process.cwd(), ".bot-switch");
}

const SWITCH_REASON_UPLOAD_LIMIT = "upload_limit";
const SWITCH_REASON_API_LIMIT = "api_limit";
const MAX_RETRY = 5;
const COOLDOWN_MS = 60 * 1000;

let lastSwitchTime = 0;
let isSwitching = false;

export function isSessionSwitching() {
  return isSwitching;
}

export function registerTask(type, data) {
  return addPendingTask({
    type,
    data,
    status: "pending"
  });
}

export function completeTask(taskId) {
  removePendingTask(taskId);
}

export async function checkLimitAndSwitchSession(reason, context = {}) {
  if (isSwitching) return false;
  const now = Date.now();
  if (now - lastSwitchTime < COOLDOWN_MS) return false;

  const task = getPendingTask(context.taskId || "");
  if (!task && Object.keys(context).length === 0) {
    return false;
  }

  isSwitching = true;
  lastSwitchTime = now;

  try {
    logManagerBot(`[AutoSessionSwitch] Phat hien limit: ${reason}. Dang chuyen session...`);
    if (context.taskId && task) {
      incrementTaskRetry(context.taskId);
    }
    await triggerSessionSwitch(reason, context);
    return true;
  } catch (error) {
    console.error("[AutoSessionSwitch] Loi khi chuyen session:", error);
    logManagerBot(`[AutoSessionSwitch] Loi chuyen session: ${error.message}`);
    isSwitching = false;
    return false;
  }
}

export async function triggerSessionSwitch(reason, context = {}) {
  return new Promise((resolve, reject) => {
    const switchFlagPath = resolveSwitchFlagPath();
    const switchData = {
      reason,
      context,
      timestamp: new Date().toISOString()
    };

    try {
      fs.writeFileSync(switchFlagPath, JSON.stringify(switchData, null, 2));
    } catch (error) {
      reject(new Error(`Khong the ghi switch flag: ${error.message}`));
      return;
    }

    logManagerBot(`[AutoSessionSwitch] Da ghi flag chuyen session. Dang thoat voi ma restart (${RESTART_EXIT_CODE})...`);
    const timer = setTimeout(() => {
      process.exit(RESTART_EXIT_CODE);
    }, 500);
    timer.unref?.();
    resolve(true);
  });
}

export function resumePendingTasks(api) {
  const tasks = loadPendingTasks();
  if (tasks.length === 0) return [];

  const resumed = [];
  for (const task of tasks) {
    if (task.status === "pending" && task.retryCount < MAX_RETRY) {
      resumed.push(task);
    } else if (task.retryCount >= MAX_RETRY) {
      removePendingTask(task.id);
      logManagerBot(`[AutoSessionSwitch] Bo qua task ${task.id} vi qua ${MAX_RETRY} lan thu.`);
    }
  }
  return resumed;
}

export function getSwitchFlag() {
  const switchFlagPath = resolveSwitchFlagPath();
  try {
    if (fs.existsSync(switchFlagPath)) {
      const data = JSON.parse(fs.readFileSync(switchFlagPath, "utf-8"));
      fs.unlinkSync(switchFlagPath);
      return data;
    }
  } catch (error) {
    console.error("[AutoSessionSwitch] Loi doc switch flag:", error);
  }
  return null;
}
