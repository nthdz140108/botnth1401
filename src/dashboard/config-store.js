import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE = /cookie|token|password|secret|imei|useragent|credential/i;

export class ConfigStore {
  constructor({ backupDir = path.join(process.cwd(), "logs", "dashboard-backups") } = {}) {
    this.backupDir = backupDir;
    this.backupSequence = 0;
  }

  async readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }

  async updateJson(file, updater) {
    const current = await fs.readFile(file, "utf8").then((value) => JSON.parse(value)).catch((error) => {
      if (error.code === "ENOENT") return {};
      throw error;
    });
    const next = await updater(current);
    return this.writeJson(file, next);
  }

  async writeJson(file, value) {
    if (value === null || typeof value !== "object") throw new Error("Config must be a JSON object or array");
    await fs.mkdir(this.backupDir, { recursive: true });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const backup = path.join(this.backupDir, `${path.basename(file)}.${Date.now()}-${++this.backupSequence}.bak`);
    const previous = await fs.readFile(file, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (previous !== null) {
      await fs.writeFile(backup, previous, "utf8");
      await this.pruneBackups(path.basename(file)).catch(() => {});
    }
    const temp = await fs.mkdtemp(path.join(path.dirname(file), ".dashboard-"));
    const tempFile = path.join(temp, path.basename(file));
    await fs.writeFile(tempFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempFile, file);
    await fs.rm(temp, { recursive: true, force: true });
    return { value: redact(value), backup: previous === null ? null : { file: backup }, changedPaths: [file], restartRequired: true };
  }

  async pruneBackups(baseName, maxKeep = 5) {
    const entries = await fs.readdir(this.backupDir).catch(() => []);
    const matching = entries
      .filter((name) => name.startsWith(`${baseName}.`) && name.endsWith(".bak"))
      .sort()
      .reverse();
    for (const stale of matching.slice(maxKeep)) {
      await fs.rm(path.join(this.backupDir, stale), { force: true }).catch(() => {});
    }
  }

  async rollback(file, backup) {
    if (!file || typeof file !== "string") {
      const error = new Error("Invalid target file");
      error.status = 400;
      error.code = "INVALID_BACKUP_PATH";
      throw error;
    }
    const backupTarget = typeof backup === "string" ? backup : backup?.file;
    if (!backupTarget || typeof backupTarget !== "string") {
      const error = new Error("Invalid backup path");
      error.status = 400;
      error.code = "INVALID_BACKUP_PATH";
      throw error;
    }
    const backupPath = path.resolve(backupTarget);
    const allowedDir = path.resolve(this.backupDir) + path.sep;
    if (!backupPath.startsWith(allowedDir) || !path.basename(backupPath).startsWith(`${path.basename(file)}.`)) {
      const error = new Error("Invalid backup path");
      error.status = 400;
      error.code = "INVALID_BACKUP_PATH";
      throw error;
    }
    const value = JSON.parse(await fs.readFile(backupPath, "utf8"));
    return this.writeJson(file, value);
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map((item) => item && typeof item === "object" ? redact(item) : item);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SENSITIVE.test(key)));
}
