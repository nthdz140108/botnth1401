import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");

export class RustWsDecoderClient {
  constructor(options = {}) {
    const defaultBin = process.platform === "win32"
      ? path.join(projectRoot, "rust", "target", "release", "ws-decode-worker.exe")
      : path.join(projectRoot, "rust", "target", "release", "ws-decode-worker");
    const debugBin = process.platform === "win32"
      ? path.join(projectRoot, "rust", "target", "debug", "ws-decode-worker.exe")
      : path.join(projectRoot, "rust", "target", "debug", "ws-decode-worker");
    const systemBin = "/usr/local/bin/ws-decode-worker";

    let resolvedBin = null;
    if (options.binPath) resolvedBin = options.binPath;
    else if (fs.existsSync(defaultBin)) resolvedBin = defaultBin;
    else if (fs.existsSync(debugBin)) resolvedBin = debugBin;
    else if (fs.existsSync(systemBin)) resolvedBin = systemBin;

    this.binPath = resolvedBin;
    this.child = null;
    this.rl = null;
    this.pending = new Map();
    this.nextId = 1;
    this.isReady = false;
  }

  isAvailable() {
    return Boolean(this.binPath && fs.existsSync(this.binPath));
  }

  start() {
    if (this.child) return;
    if (!this.isAvailable()) {
      throw new Error(`Rust ws-decode-worker binary not found at: ${this.binPath}`);
    }

    this.child = spawn(this.binPath, [], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });

    this.child.on("error", (err) => {
      for (const [id, req] of this.pending) {
        req.reject(new Error(`Rust decoder process error: ${err.message}`));
      }
      this.pending.clear();
      this.child = null;
      this.isReady = false;
    });

    this.child.on("exit", (code) => {
      for (const [id, req] of this.pending) {
        req.reject(new Error(`Rust decoder exited prematurely with code ${code}`));
      }
      this.pending.clear();
      this.child = null;
      this.isReady = false;
    });

    this.rl = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "PONG") return;
      try {
        const resp = JSON.parse(trimmed);
        const req = this.pending.get(resp.id);
        if (req) {
          this.pending.delete(resp.id);
          if (resp.ok) {
            req.resolve(resp.result);
          } else {
            req.reject(new Error(resp.error || "Rust decode error"));
          }
        }
      } catch (parseErr) {
        // Drop unparseable lines
      }
    });

    this.isReady = true;
  }

  async decode(data, key) {
    if (!this.child) {
      this.start();
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, key, data }) + "\n";
      this.child.stdin.write(payload, "utf8", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  stop() {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this.isReady = false;
    this.pending.clear();
  }
}

let defaultClient = null;

export function getRustWsDecoderClient() {
  if (!defaultClient) {
    defaultClient = new RustWsDecoderClient();
  }
  return defaultClient;
}
