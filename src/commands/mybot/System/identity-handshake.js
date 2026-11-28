import path from "path";
import { getProjectRoot } from "../../../utils/env.js";
import { nowIso, readJsonFile, writeJsonAtomic } from "./json-state.js";

const projectRoot = getProjectRoot();
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
