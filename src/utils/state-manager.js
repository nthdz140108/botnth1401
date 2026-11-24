import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createBotRuntimeContext, ensureRuntimeDirectories, seedRuntimeFiles } from "./bot-runtime-context.js";

const DEFAULT_STATE = Object.freeze({
  version: 1,
  botId: "",
  createdAt: "",
  updatedAt: "",
  data: {},
});

function safeReadJson(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function safeWriteJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

export function ensureState(botId, schema = {}) {
  const resolvedBotId = String(botId || "admin").trim() || "admin";
  const runtimeContext = createBotRuntimeContext(resolvedBotId);
  ensureRuntimeDirectories(runtimeContext);
  seedRuntimeFiles(runtimeContext);

  const statePath = path.join(runtimeContext.stateDir, "state.json");
  const fallbackState = {
    ...DEFAULT_STATE,
    botId: resolvedBotId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    data: structuredCloneSafe(schema),
  };

  const currentState = safeReadJson(statePath);
  if (!currentState || typeof currentState !== "object") {
    safeWriteJsonAtomic(statePath, fallbackState);
    return fallbackState;
  }

  const mergedState = {
    ...fallbackState,
    ...currentState,
    botId: resolvedBotId,
    updatedAt: new Date().toISOString(),
    data: {
      ...structuredCloneSafe(schema),
      ...(currentState.data && typeof currentState.data === "object" ? currentState.data : {}),
    },
  };

  if (!currentState.createdAt) {
    mergedState.createdAt = fallbackState.createdAt;
  }

  safeWriteJsonAtomic(statePath, mergedState);
  return mergedState;
}

export function readState(botId) {
  const runtimeContext = createBotRuntimeContext(String(botId || "admin").trim() || "admin");
  const statePath = path.join(runtimeContext.stateDir, "state.json");
  const state = safeReadJson(statePath);
  return state && typeof state === "object" ? state : null;
}

export function writeState(botId, nextState) {
  const runtimeContext = createBotRuntimeContext(String(botId || "admin").trim() || "admin");
  const statePath = path.join(runtimeContext.stateDir, "state.json");
  safeWriteJsonAtomic(statePath, nextState);
  return nextState;
}

function structuredCloneSafe(value) {
  if (value === null || typeof value !== "object") return value ?? {};
  return JSON.parse(JSON.stringify(value));
}
