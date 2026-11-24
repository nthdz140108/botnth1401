import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE = /cookie|token|password|secret|imei|useragent/i;

export class BackupStore {
  constructor({ root = process.cwd(), dir = path.join(root, "logs", "dashboard-backups") } = {}) { this.root = path.resolve(root); this.dir = path.resolve(dir); }
  async backup(paths = []) {
    await fs.mkdir(this.dir, { recursive: true });
    const files = [];
    for (const relative of paths) {
      const absolute = this.safe(relative);
      if (SENSITIVE.test(relative)) continue;
      const value = await fs.readFile(absolute, "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
      if (value === null) continue;
      files.push({ path: path.relative(this.root, absolute), value });
    }
    const file = path.join(this.dir, `dashboard-${Date.now()}.json`);
    await fs.writeFile(file, JSON.stringify({ createdAt: new Date().toISOString(), files }, null, 2));
    return { file, count: files.length };
  }
  async restore(file) {
    const absolute = path.resolve(file);
    if (!absolute.startsWith(this.dir + path.sep)) throw new Error("Invalid backup path");
    const backup = JSON.parse(await fs.readFile(absolute, "utf8"));
    for (const item of backup.files || []) await fs.writeFile(this.safe(item.path), item.value, "utf8");
    return { restored: (backup.files || []).length };
  }
  safe(relative) { const absolute = path.resolve(this.root, relative); if (!absolute.startsWith(this.root + path.sep)) throw new Error("Invalid project path"); return absolute; }
}
