import fs from "node:fs/promises";
import path from "node:path";
import { createAdminRecoveryChannel } from "../runtime/admin-recovery-channel.js";

const RECOVERY_MANIFEST_PATH = path.join(".runtime", "admin-recovery", "active.json");
const TERMINAL_STATES = new Set(["success", "failed", "cancelled", "expired"]);

export function createAdminRecoveryService({ projectRoot, channel, now = () => Date.now() } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const recoveryChannel = channel || createAdminRecoveryChannel({ projectRoot, now });
  const manifestPath = path.join(path.resolve(projectRoot), RECOVERY_MANIFEST_PATH);

  // The channel treats expired manifests as inactive (readActive() -> null).
  // Classify that case by checking the manifest's own expiresAt, never by
  // touching qrFile or any session artifact.
  async function classifyInactive() {
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw);
      const expires = Date.parse(manifest?.expiresAt);
      if (!Number.isNaN(expires) && now() >= expires) {
        return { state: "expired" };
      }
    } catch {
      // No manifest, unreadable, or invalid JSON: nothing was ever published.
    }
    return { state: "idle" };
  }

  return {
    async getStatus() {
      const manifest = await recoveryChannel.readActive();
      if (!manifest) return classifyInactive();
      const state = typeof manifest.state === "string" ? manifest.state : "starting";
      if (TERMINAL_STATES.has(state)) return { state };
      // QR bytes are only ever read through the channel, which validates that
      // manifest.qrFile stays inside the recovery root.
      const image = await recoveryChannel.readQr(manifest.sessionId);
      if (!image) return { state: "failed" };
      return {
        state,
        sessionId: manifest.sessionId,
        createdAt: manifest.createdAt,
        expiresAt: manifest.expiresAt,
        qrImage: `data:image/png;base64,${image.toString("base64")}`,
      };
    },
  };
}

export default createAdminRecoveryService;
