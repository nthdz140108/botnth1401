import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setupAskpass, validateVpsConfig, buildSshAuthArgs } from "./vps-deploy-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const localConfigPath = path.join(scriptDir, "vps-deploy.local.json");
const config = validateVpsConfig(JSON.parse(fs.readFileSync(localConfigPath, "utf8")));

const askpassHelper = setupAskpass(config.password);
const target = `${config.user}@${config.host}`;
const authArgs = buildSshAuthArgs(config);

function scpFile(localRel, remoteAbs) {
  const localAbs = path.join(repoRoot, localRel);
  console.log(`Copying ${localRel} -> ${remoteAbs}...`);
  const res = spawnSync("scp", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    ...authArgs,
    "-P", String(config.port),
    localAbs,
    `${target}:${remoteAbs}`
  ], { env: askpassHelper ? askpassHelper.env : process.env, encoding: "utf8" });
  if (res.status !== 0) {
    console.error(`SCP failed for ${localRel}:`, res.stderr);
    process.exit(1);
  }
}

function sshExec(cmd) {
  console.log(`Remote: ${cmd}...`);
  const b64 = Buffer.from(cmd, "utf8").toString("base64");
  const res = spawnSync("ssh", [
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    ...authArgs,
    "-p", String(config.port),
    target,
    `echo ${b64} | base64 -d | bash`
  ], { env: askpassHelper ? askpassHelper.env : process.env, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(`SSH command failed: ${cmd}`);
    process.exit(res.status ?? 1);
  }
}

try {
  const remoteRustDir = "/opt/mybot-src/releases/mybot-vps-bundle-20261105T174125Z/rust";

  // 1. Copy Rust sources to latest release rust directory
  scpFile("rust/crates/zalo-sdk/src/qr_login.rs", `${remoteRustDir}/crates/zalo-sdk/src/qr_login.rs`);
  scpFile("rust/crates/mybot-dashboard/src/qr_coordinator.rs", `${remoteRustDir}/crates/mybot-dashboard/src/qr_coordinator.rs`);
  scpFile("rust/crates/mybot-dashboard/src/routes.rs", `${remoteRustDir}/crates/mybot-dashboard/src/routes.rs`);

  // 2. Copy Node & Frontend files to /opt/mybot/
  scpFile("src/dashboard/bot-action-service.js", "/opt/mybot/src/dashboard/bot-action-service.js");
  scpFile("dashboard/dist/index.html", "/opt/mybot/dashboard/dist/index.html");
  scpFile("dashboard/dist/assets/index-ByJ22sA6.js", "/opt/mybot/dashboard/dist/assets/index-ByJ22sA6.js");

  // 3. Compile mybotd on VPS and restart services
  sshExec(`
    set -e
    echo "=== Compiling mybotd in release mode on VPS ==="
    cd ${remoteRustDir}
    /root/.cargo/bin/cargo build --release --bin mybotd
    cp ${remoteRustDir}/target/release/mybotd /usr/local/bin/mybotd
    chmod +x /usr/local/bin/mybotd

    echo "=== Restarting mybot.service and mybot-bridge ==="
    systemctl restart mybot.service
    pm2 restart mybot-bridge
    sleep 2
    systemctl is-active mybot.service
    pm2 status
  `);

  console.log("\n[SUCCESS] All files synced, Rust mybotd compiled and services restarted!");
} finally {
  if (askpassHelper) askpassHelper.cleanup();
}
