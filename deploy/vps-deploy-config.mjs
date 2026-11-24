import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function validateVpsConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("VPS config must be a JSON object");
  }

  const host = String(value.host ?? "").trim();
  const user = String(value.user ?? "").trim();
  const port = Number(value.port ?? 22);
  const identityFile = String(value.identityFile ?? "").trim() || null;
  const password = typeof value.password === "string" && value.password.length > 0 ? value.password : null;

  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) {
    throw new TypeError("VPS host must be a hostname or IPv4 address");
  }
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(user)) {
    throw new TypeError("SSH user contains unsupported characters");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("SSH port must be an integer between 1 and 65535");
  }
  if (identityFile && /[\r\n\0]/.test(identityFile)) {
    throw new TypeError("SSH key path contains unsupported control characters");
  }
  if (password && /[\r\n\0]/.test(password)) {
    throw new TypeError("SSH password contains unsupported control characters");
  }

  return { host, user, port, identityFile, password };
}

export function buildSshAuthArgs(config) {
  return config.identityFile ? ["-i", config.identityFile] : [];
}

export function setupAskpass(password) {
  if (!password) return null;
  const isWin = process.platform === "win32";
  const ext = isWin ? ".cmd" : ".sh";
  const askpassFile = path.join(os.tmpdir(), `mybot-askpass-${Date.now()}-${process.pid}${ext}`);

  if (isWin) {
    fs.writeFileSync(
      askpassFile,
      `@"${process.execPath}" -e "process.stdout.write(process.env.MYBOT_VPS_SSH_PASS || '')"\r\n`,
      { mode: 0o700 }
    );
  } else {
    fs.writeFileSync(
      askpassFile,
      `#!/bin/sh\nexec "${process.execPath}" -e "process.stdout.write(process.env.MYBOT_VPS_SSH_PASS || '')"\n`,
      { mode: 0o700 }
    );
  }

  const env = {
    ...process.env,
    SSH_ASKPASS: askpassFile,
    SSH_ASKPASS_REQUIRE: "force",
    MYBOT_VPS_SSH_PASS: password,
  };

  const cleanup = () => {
    try {
      if (fs.existsSync(askpassFile)) fs.unlinkSync(askpassFile);
    } catch {}
  };

  return { askpassFile, env, cleanup };
}

export function createBundleName(now = new Date(), serial = 0) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = serial > 0 ? `-${serial}` : "";
  return `mybot-vps-bundle-${timestamp}${suffix}.tar.gz`;
}
