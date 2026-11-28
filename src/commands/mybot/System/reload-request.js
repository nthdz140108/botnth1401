import path from "path";
import { getProjectRoot } from "../../../utils/env.js";
import { nowIso, readJsonFile, writeJsonAtomic } from "./json-state.js";

const projectRoot = getProjectRoot();
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
