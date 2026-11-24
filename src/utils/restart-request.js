import fs from "fs";
import path from "path";
import { getProjectRoot } from "./env.js";

export const RESTART_EXIT_CODE = 10;
const REQUEST_STATUS = "requested";
const CONSUMED_STATUS = "consumed";
const FAILED_STATUS = "failed";

export function getRestartRequestPath(uid, root = getProjectRoot()) {
  return path.join(path.resolve(root), "mybot", "state", "restart", `${uid}.json`);
}

export function writeRestartRequest(uid, request = {}, root = getProjectRoot()) {
  if (!uid) throw new Error("uid is required");
  const filePath = getRestartRequestPath(uid, root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const requestedAt = request.requestedAt || new Date().toISOString();
  const next = {
    requestId: request.requestId || `rs-${uid}-${Date.now()}`,
    botKey: request.botKey || String(uid),
    uid: String(uid),
    status: REQUEST_STATUS,
    requestedAt,
    ...request,
    uid: String(uid),
    status: REQUEST_STATUS,
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  return next;
}

export function readRestartRequest(uid, root = getProjectRoot()) {
  try {
    return JSON.parse(fs.readFileSync(getRestartRequestPath(uid, root), "utf8"));
  } catch {
    return null;
  }
}

export function consumeRestartRequest(uid, root = getProjectRoot(), { maxAgeMs = 30000 } = {}) {
  const request = readRestartRequest(uid, root);
  if (!request || request.status !== REQUEST_STATUS) return null;

  const requestedTime = new Date(request.requestedAt || 0).getTime();
  const ageMs = Date.now() - requestedTime;
  const filePath = getRestartRequestPath(uid, root);

  if (isNaN(requestedTime) || ageMs > maxAgeMs) {
    const staleRecord = {
      ...request,
      status: FAILED_STATUS,
      reason: "stale",
      failedAt: new Date().toISOString(),
      ageMs,
    };
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(staleRecord, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
    return null;
  }

  const consumed = {
    ...request,
    status: CONSUMED_STATUS,
    consumedAt: new Date().toISOString(),
  };
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(consumed, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  return consumed;
}

export function markRestartRequestNotified(uid, root = getProjectRoot()) {
  const request = readRestartRequest(uid, root);
  if (!request || request.status !== CONSUMED_STATUS || request.notifiedAt) return null;
  const next = { ...request, notifiedAt: new Date().toISOString() };
  const filePath = getRestartRequestPath(uid, root);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
  return next;
}

export { CONSUMED_STATUS, REQUEST_STATUS, FAILED_STATUS };
