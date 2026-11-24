import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { getProjectRoot } from "./env.js";

const DEFAULT_SERVER_NAME = process.env.BOT_SERVER_NAME || "MyBot Zalo";

function getServerConfigPath(projectRoot = getProjectRoot()) {
  return path.join(projectRoot, "mybot", "configs", "server-config.json");
}

function loadInitialServerName() {
  try {
    const filePath = getServerConfigPath();
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
      if (parsed && typeof parsed.nameServer === "string" && parsed.nameServer.trim()) {
        return parsed.nameServer.trim();
      }
    }
  } catch {
    // Fallback to default server name
  }
  return DEFAULT_SERVER_NAME;
}

export let nameServer = loadInitialServerName();

export function getNameServer() {
  return nameServer;
}

export async function updateNameServer(newName, { projectRoot = getProjectRoot() } = {}) {
  const normalized = String(newName ?? "").trim();
  if (!normalized) return nameServer;
  nameServer = normalized;

  const filePath = getServerConfigPath(projectRoot);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsPromises.writeFile(
    tempPath,
    `${JSON.stringify({ nameServer, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
  await fsPromises.rename(tempPath, filePath);
  return nameServer;
}

export function isDatabaseReady() {
  return false;
}

export function getDatabaseStatus() {
  return {
    ready: false,
    database: "",
    nameServer,
  };
}
