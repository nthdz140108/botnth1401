import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const projectRoot = path.resolve(__dirname);
const botName = process.argv[2] || "admin";
export const cfgPath = path.join(projectRoot, "mybot", "bots", `${botName}.json`);

function validateFiles() {
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Config not found: ${cfgPath}`);
  }
  const bootstrapPath = path.join(projectRoot, "src", "bootstrap.js");
  if (!fs.existsSync(bootstrapPath)) {
    throw new Error(`Source not found: ${bootstrapPath}`);
  }
  return bootstrapPath;
}

export function startDirect(bootstrapPath, uid = botName) {
  const child = spawn(process.execPath, [bootstrapPath, uid], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: projectRoot,
    env: {
      ...process.env,
      MYBOT_INSTANCE_KIND: uid === "admin" ? "main" : "child",
      BOT_NAME: uid,
      CONFIG_PATH: uid === "admin" ? path.join(projectRoot, "assets", "config.json") : path.join(projectRoot, "mybot", "bots", `${uid}.json`),
      PROJECT_ROOT: projectRoot,
      BOT_MANAGED: "true",
    },
  });
  child.unref();
  return child.pid;
}

import { printRuntimeFingerprint } from "./src/bootstrap.js";

async function main() {
  printRuntimeFingerprint({ entrypoint: "index.js", botName });
  const bootstrapPath = validateFiles();
  startDirect(bootstrapPath, botName);
}

const currentFile = fileURLToPath(import.meta.url);
if (currentFile === process.argv[1] || path.resolve(currentFile) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
