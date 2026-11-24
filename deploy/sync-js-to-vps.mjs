import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupAskpass, validateVpsConfig, buildSshAuthArgs } from "./vps-deploy-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const localConfigPath = path.join(scriptDir, "vps-deploy.local.json");
const config = validateVpsConfig(JSON.parse(fs.readFileSync(localConfigPath, "utf8")));

const askpassHelper = setupAskpass(config.password);
const target = `${config.user}@${config.host}`;
const authArgs = buildSshAuthArgs(config);

const filesToSync = [
  "src/runtime/pm2-adapter.js",
  "src/dashboard/node-bridge-service.js",
  "src/dashboard/bot-action-service.js",
  "src/dashboard/bot-registry.js",
  "src/api-zalo/apis/listen.js",
];

try {
  for (const relPath of filesToSync) {
    const localPath = path.join(repoRoot, relPath);
    const remotePath = `/opt/mybot/${relPath.replace(/\\/g, "/")}`;
    console.log(`Copying ${relPath} -> ${remotePath}...`);
    const scpRes = spawnSync("scp", [
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      ...authArgs,
      "-P", String(config.port),
      localPath,
      `${target}:${remotePath}`
    ], {
      env: askpassHelper ? askpassHelper.env : process.env,
      encoding: "utf8"
    });
    if (scpRes.status !== 0) {
      console.error(`SCP failed for ${relPath}:`, scpRes.stderr);
      process.exit(1);
    }
  }

  console.log("Restarting mybot-bridge on VPS...");
  const sshRes = spawnSync("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    ...authArgs,
    "-p", String(config.port),
    target,
    "pm2 restart mybot-bridge"
  ], {
    env: askpassHelper ? askpassHelper.env : process.env,
    stdio: "inherit"
  });

  console.log("[OK] JS files synced and mybot-bridge restarted!");
} finally {
  if (askpassHelper) askpassHelper.cleanup();
}
