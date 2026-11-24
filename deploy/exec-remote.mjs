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
const cmd = process.argv.slice(2).join(" ");

try {
  const res = spawnSync("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    ...authArgs,
    "-p", String(config.port),
    target,
    cmd
  ], {
    env: askpassHelper ? askpassHelper.env : process.env,
    encoding: "utf8"
  });
  process.stdout.write(res.stdout || "");
  process.stderr.write(res.stderr || "");
} finally {
  if (askpassHelper) askpassHelper.cleanup();
}
