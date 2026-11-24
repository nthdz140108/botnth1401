import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { setupAskpass } from "../deploy/vps-deploy-config.mjs";

const cmd = process.argv.slice(2).join(" ");
if (!cmd) {
  console.error("Usage: node scripts/vps-exec.mjs <remote command>");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync("./deploy/vps-deploy.local.json", "utf8"));
const askpass = setupAskpass(config.password);

try {
  const b64 = Buffer.from(cmd, "utf8").toString("base64");
  const res = spawnSync("ssh.exe", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    "-p", String(config.port),
    `${config.user}@${config.host}`,
    `echo ${b64} | base64 -d | bash`
  ], { env: askpass.env, encoding: "utf8" });

  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status ?? 0);
} finally {
  askpass.cleanup();
}
