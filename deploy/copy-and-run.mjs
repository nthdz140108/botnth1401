import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupAskpass, validateVpsConfig, buildSshAuthArgs } from "./vps-deploy-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const localConfigPath = path.join(scriptDir, "vps-deploy.local.json");
const config = validateVpsConfig(JSON.parse(fs.readFileSync(localConfigPath, "utf8")));

const askpassHelper = setupAskpass(config.password);
const target = `${config.user}@${config.host}`;
const authArgs = buildSshAuthArgs(config);
const localFile = path.resolve(process.argv[2]);
const remoteDest = `/tmp/${path.basename(localFile)}`;

try {
  // 1. scp
  const scpRes = spawnSync("scp", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    ...authArgs,
    "-P", String(config.port),
    localFile,
    `${target}:${remoteDest}`
  ], {
    env: askpassHelper ? askpassHelper.env : process.env,
    encoding: "utf8"
  });
  if (scpRes.status !== 0) {
    console.error("SCP failed:", scpRes.stderr);
    process.exit(1);
  }

  // 2. run via ssh
  const sshRes = spawnSync("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    ...authArgs,
    "-p", String(config.port),
    target,
    `node ${remoteDest}`
  ], {
    env: askpassHelper ? askpassHelper.env : process.env,
    stdio: "inherit"
  });
} finally {
  if (askpassHelper) askpassHelper.cleanup();
}
