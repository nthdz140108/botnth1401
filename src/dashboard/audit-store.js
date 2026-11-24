import fs from "node:fs/promises";
import path from "node:path";

const MAX_AUDIT_BYTES = 512 * 1024;
const KEEP_AUDIT_LINES = 1000;

export class AuditStore {
  constructor({ root = process.cwd(), file = path.join(root, "logs", "dashboard-audit.jsonl") } = {}) {
    this.root = path.resolve(root);
    this.file = path.resolve(file);
  }

  async append(entry) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const value = {
      timestamp: new Date().toISOString(),
      actor: "dashboard-local",
      ...entry,
    };
    await fs.appendFile(this.file, `${JSON.stringify(value)}\n`, "utf8");
    const stat = await fs.stat(this.file).catch(() => null);
    if (stat && stat.size > MAX_AUDIT_BYTES) {
      const text = await fs.readFile(this.file, "utf8").catch(() => "");
      const kept = text.split(/\r?\n/).filter(Boolean).slice(-KEEP_AUDIT_LINES);
      await fs.writeFile(this.file, kept.length ? `${kept.join("\n")}\n` : "", "utf8").catch(() => {});
    }
    return value;
  }

  async list({ limit = 100 } = {}) {
    try {
      const text = await fs.readFile(this.file, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .reverse()
        .slice(0, limit);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
}
