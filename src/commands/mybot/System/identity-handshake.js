import path from "path";
import { fileURLToPath } from "url";
import { nowIso, readJsonFile, writeJsonAtomic } from "./json-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../../..");
const handshakeDir = path.join(projectRoot, "mybot", "state", "qr-bootstrap");

export function getHandshakePath(sessionId) {
  return path.join(handshakeDir, `${sessionId}.json`);
}

export function readIdentityHandshake(sessionId) {
  return readJsonFile(getHandshakePath(sessionId), {
    sessionId,
    status: "starting",
  });
}

export function writeIdentityHandshake(sessionId, patch = {}) {
  const current = readIdentityHandshake(sessionId);
  const next = {
    sessionId,
    status: "starting",
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };
  writeJsonAtomic(getHandshakePath(sessionId), next);
  return next;
}
