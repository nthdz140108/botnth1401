import fs from "fs";
import path from "path";
import { getProjectRoot } from "../utils/env.js";
import { getRuntimeContext } from "../utils/bot-runtime-context.js";

function resolveTasksFilePath() {
  try {
    const ctx = getRuntimeContext();
    if (ctx?.dataDir) {
      return path.join(ctx.dataDir, "pending-tasks.json");
    }
  } catch {}
  return path.join(getProjectRoot(), "assets", "temp", "pending-tasks.json");
}

function ensureTasksFile() {
  const tasksFile = resolveTasksFilePath();
  const dir = path.dirname(tasksFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(tasksFile)) {
    fs.writeFileSync(tasksFile, JSON.stringify({ tasks: [] }, null, 2));
  }
  return tasksFile;
}

export function loadPendingTasks() {
  try {
    const tasksFile = ensureTasksFile();
    const data = JSON.parse(fs.readFileSync(tasksFile, "utf-8"));
    return data.tasks || [];
  } catch (error) {
    console.error("Loi doc pending-tasks.json:", error.message);
    return [];
  }
}

export function savePendingTasks(tasks) {
  try {
    const tasksFile = ensureTasksFile();
    fs.writeFileSync(tasksFile, JSON.stringify({ tasks }, null, 2));
  } catch (error) {
    console.error("Loi ghi pending-tasks.json:", error.message);
  }
}

export function addPendingTask(task) {
  const tasks = loadPendingTasks();
  const existing = tasks.findIndex(t => t.id === task.id);
  if (existing >= 0) {
    tasks[existing] = { ...tasks[existing], ...task, updatedAt: new Date().toISOString() };
  } else {
    tasks.push({
      ...task,
      id: task.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: task.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      retryCount: task.retryCount || 0
    });
  }
  savePendingTasks(tasks);
  return task.id || tasks[tasks.length - 1].id;
}

export function removePendingTask(taskId) {
  const tasks = loadPendingTasks().filter(t => t.id !== taskId);
  savePendingTasks(tasks);
}

export function getPendingTask(taskId) {
  return loadPendingTasks().find(t => t.id === taskId) || null;
}

export function incrementTaskRetry(taskId) {
  const tasks = loadPendingTasks();
  const task = tasks.find(t => t.id === taskId);
  if (task) {
    task.retryCount = (task.retryCount || 0) + 1;
    task.updatedAt = new Date().toISOString();
    savePendingTasks(tasks);
  }
  return task;
}
