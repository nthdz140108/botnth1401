import path from "path";
import { fileURLToPath } from "url";
import { nowIso, readJsonFile, writeJsonAtomic } from "./json-state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../../..");
const reloadDir = path.join(projectRoot, "mybot", "state", "reload");

export function getReloadRequestPath(uid) {
  return path.join(reloadDir, `${uid}.json`);
}

export function readReloadRequest(uid) {
  return readJsonFile(getReloadRequestPath(uid), {
    uid,
    status: "requested",
  });
}

export function writeReloadRequest(uid, request = {}) {
  const current = readReloadRequest(uid);
  const next = {
    uid,
    status: "requested",
    ...current,
    ...request,
    requestedAt: request.requestedAt || current.requestedAt || nowIso(),
  };
  writeJsonAtomic(getReloadRequestPath(uid), next);
  return next;
}
