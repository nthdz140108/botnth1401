#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildSshAuthArgs,
  createBundleName,
  setupAskpass,
  validateVpsConfig,
} from "./vps-deploy-config.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const localConfigPath = path.join(scriptDir, "vps-deploy.local.json");
process.chdir(repoRoot);

function readLocalConfig() {
  try {
    const config = validateVpsConfig(JSON.parse(fs.readFileSync(localConfigPath, "utf8")));
    if (config.identityFile) {
      config.identityFile = path.resolve(config.identityFile);
      if (!fs.existsSync(config.identityFile)) {
        throw new Error(`Không tìm thấy SSH private key: ${config.identityFile}`);
      }
    }
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cấu hình ${localConfigPath} không hợp lệ: ${error.message}`);
  }
}

async function promptPassword(rl, promptText) {
  const answer = await rl.question(promptText);
  return answer.trim();
}

async function configureVps(rl) {
  console.log("Chưa có cấu hình VPS. Nhập thông tin một lần; lần chạy sau BAT sẽ tự động dùng cấu hình này.");
  const host = (await rl.question("Hostname/IP VPS [180.93.117.140]: ")).trim() || "180.93.117.140";
  const user = (await rl.question("SSH user [root]: ")).trim() || "root";
  const port = (await rl.question("SSH port [22]: ")).trim() || "22";
  const keyInput = (await rl.question("Đường dẫn SSH private key (Enter nếu dùng mật khẩu SSH): ")).trim();
  const identityFile = keyInput
    ? keyInput.startsWith("~")
      ? path.resolve(os.homedir(), keyInput.slice(1).replace(/^[\\/]+/, ""))
      : path.resolve(keyInput)
    : null;
  if (identityFile && !fs.existsSync(identityFile)) {
    throw new Error(`Không tìm thấy SSH private key: ${identityFile}`);
  }

  let password = null;
  if (!identityFile) {
    const enteredPass = (await promptPassword(rl, "Mật khẩu SSH VPS (sẽ được lưu cục bộ để lần sau 1-click): ")).trim();
    password = enteredPass || null;
  }

  const config = validateVpsConfig({ host, user, port, identityFile, password });
  fs.writeFileSync(localConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Đã lưu cấu hình cục bộ tại ${localConfigPath}; file này không được đưa vào Git.`);
  return config;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} kết thúc với mã ${result.status ?? "không xác định"}`);
  }
}

function nextBundleName() {
  const now = new Date();
  for (let serial = 0; ; serial += 1) {
    const name = createBundleName(now, serial);
    if (!fs.existsSync(path.join(repoRoot, name))) return name;
  }
}

function createBundle(bundleName) {
  const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
  const exclusions = [
    "target*",
    "*/target*",
    "*\\target*",
    "rust/target*",
    "rust\\target*",
    "node_modules",
    "*/node_modules",
    "*\\node_modules",
    "dashboard/node_modules",
    "dashboard\\node_modules",
    ".git",
    ".codebase-memory",
    ".superpowers",
    ".runtime",
    ".cache",
    "logs",
    ".env",
    ".env.*",
    "deploy/vps-deploy.local.json",
    "*.db",
    "*.db-wal",
    "*.db-shm",
    "mybot-vps-bundle*.tar.gz",
  ];
  const args = ["-czf", bundleName];
  for (const entry of exclusions) args.push(`--exclude=${entry}`);
  args.push(".");
  run(tarCmd, args, { cwd: repoRoot });
}

async function main() {
  const packageOnly = process.argv.includes("--package-only");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let askpassHelper = null;

  try {
    let config = packageOnly ? null : readLocalConfig() ?? (await configureVps(rl));

    if (config && !config.identityFile && !config.password) {
      console.log(`\nVPS ${config.user}@${config.host} chưa có mật khẩu SSH được lưu.`);
      const enteredPass = (await promptPassword(rl, `Nhập mật khẩu SSH cho ${config.user}@${config.host}: `)).trim();
      if (enteredPass) {
        config.password = enteredPass;
        const saveChoice = (await rl.question("Lưu mật khẩu vào deploy/vps-deploy.local.json để những lần sau chỉ cần 1-click là tự deploy? (Y/n) [Y]: ")).trim().toLowerCase();
        if (saveChoice === "" || saveChoice === "y" || saveChoice === "yes") {
          fs.writeFileSync(localConfigPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
          console.log(`[OK] Đã lưu mật khẩu vào ${localConfigPath}. Các lần chạy sau sẽ 100% tự động!`);
        }
      }
    }

    const bundleName = nextBundleName();
    const bundlePath = path.join(repoRoot, bundleName);

    console.log("\n==> Đóng gói source hiện tại (không đụng gói bàn giao cũ)...");
    createBundle(bundleName);
    if (!fs.existsSync(bundlePath)) throw new Error("Không tạo được gói bàn giao.");
    const sizeMb = (fs.statSync(bundlePath).size / (1024 * 1024)).toFixed(2);
    console.log(`[OK] ${bundlePath} (${sizeMb} MB)`);

    if (packageOnly) {
      console.log("Chỉ tạo gói. Đưa file này lên VPS rồi chạy deploy/ubuntu/install-ubuntu.sh.");
      return;
    }

    const releaseName = path.basename(bundleName, ".tar.gz");
    const sourceDir = `/opt/mybot-src/releases/${releaseName}`;
    const remoteBundle = `/tmp/${bundleName}`;
    const target = `${config.user}@${config.host}`;
    const scpCmd = process.platform === "win32" ? "scp.exe" : "scp";
    const sshCmd = process.platform === "win32" ? "ssh.exe" : "ssh";
    const authArgs = buildSshAuthArgs(config);

    if (config.password) {
      askpassHelper = setupAskpass(config.password);
    }
    const spawnEnv = askpassHelper ? askpassHelper.env : process.env;

    console.log(`\n==> Đang tải gói lên ${target}...`);
    try {
      run(scpCmd, [
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=60",
        ...authArgs,
        "-P", String(config.port),
        bundlePath,
        `${target}:${remoteBundle}`
      ], { env: spawnEnv });
    } catch (err) {
      if (String(err?.message || "").includes("255")) {
        console.error(`\n[LỖI XÁC THỰC] Không thể kết nối hoặc sai mật khẩu SSH đến ${target}.`);
        console.error("Vui lòng kiểm tra mật khẩu trong deploy/vps-deploy.local.json.");
      }
      throw err;
    }

    console.log("\n==> Giải nén, sao lưu SQLite, biên dịch và cài MyBot trên Ubuntu...");
    const remoteScript = [
      `sudo mkdir -p '${sourceDir}'`,
      `sudo tar -xzf '${remoteBundle}' -C '${sourceDir}'`,
      `sudo sed -i 's/\\r$//' '${sourceDir}/deploy/ubuntu/install-ubuntu.sh' '${sourceDir}/deploy/ubuntu/mybot.service' '${sourceDir}/deploy/ubuntu/99-mybot-sysctl.conf'`,
      `sudo bash '${sourceDir}/deploy/ubuntu/install-ubuntu.sh' --source-dir '${sourceDir}'`,
      `sudo rm -rf '${sourceDir}/rust/target' 2>/dev/null || true`,
      `sudo find /opt/mybot-src/releases -mindepth 1 -maxdepth 1 -type d ! -name '${releaseName}' -exec rm -rf {} + 2>/dev/null || true`,
      `sudo find /tmp -maxdepth 1 -name 'mybot-vps-bundle*.tar.gz' -exec rm -f {} + 2>/dev/null || true`,
      `sudo find /var/lib/mybot/backups -type f -name '*.db' -mtime +3 -delete 2>/dev/null || true`,
      `sudo journalctl --vacuum-size=50M 2>/dev/null || true`,
    ].join(" && ");

    try {
      run(sshCmd, [
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=60",
        ...authArgs,
        "-t",
        "-p", String(config.port),
        target,
        remoteScript
      ], { env: spawnEnv });
    } catch (err) {
      if (String(err?.message || "").includes("255")) {
        console.error(`\n[LỖI XÁC THỰC] Không thể thực thi lệnh SSH trên ${target}.`);
        console.error("Vui lòng kiểm tra quyền hạn hoặc mật khẩu trong deploy/vps-deploy.local.json.");
      }
      throw err;
    }

    console.log("\n================================================================");
    console.log("[OK] VPS đã cài bản mới và API health trả healthy. Cần thử lệnh trong chat Zalo để nghiệm thu bot.");
    console.log("================================================================");

    if (fs.existsSync(bundlePath)) {
      try {
        fs.unlinkSync(bundlePath);
        console.log(`[DỌN DẸP] Đã xóa bundle tạm cục bộ: ${bundleName}`);
      } catch {}
    }
  } finally {
    if (askpassHelper) {
      askpassHelper.cleanup();
    }
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\n[LỖI] ${error?.message || error}`);
  process.exitCode = 1;
});
