import fs from "node:fs/promises";
import path from "node:path";
import { seedCleanInstall } from "./clean-install.js";

const root = process.env.MYBOT_DATA_DIR || "/data/mybot";
const uid = Number(process.env.APP_UID || 1000);
const gid = Number(process.env.APP_GID || 1000);
const dirs = ["bots", "state", "credentials", "logs", "sessions", "configs", "settings", "json-data", "workspaces", "resources", "temp"];

for (const dir of dirs) {
  await fs.mkdir(path.join(root, dir), { recursive: true });
}
await seedCleanInstall({ root });
await chownTree(root, uid, gid);
try {
  await fs.chown(root, uid, gid);
} catch {
  // Best effort inside minimal containers.
}

async function chownTree(currentPath, ownerUid, ownerGid) {
  try {
    const stat = await fs.stat(currentPath);
    await fs.chown(currentPath, ownerUid, ownerGid);
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      await chownTree(path.join(currentPath, entry.name), ownerUid, ownerGid);
    }
  } catch {
    // Best effort inside minimal containers.
  }
}
