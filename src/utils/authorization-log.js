import path from "path";
import { getProjectRoot } from "./env.js";
import { createLogger } from "./logger.js";

export const AUTHORIZATION_LOG_FILENAME = "authorization-decisions.jsonl";

const sharedLoggers = new Map();

function getLoggerFor(root) {
  if (!sharedLoggers.has(root)) {
    sharedLoggers.set(
      root,
      createLogger({ dir: path.join(root, "logs"), baseName: "authorization-decisions" })
    );
  }
  return sharedLoggers.get(root);
}

function trimDetail(value, max = 200) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, max);
}

export function buildAuthorizationLogRecord({
  instanceKind = "",
  instanceUid = "",
  senderId = "",
  threadId = "",
  scope = "",
  role = "",
  source = "",
  command = "",
  verdict = "",
  detail = "",
} = {}) {
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    instanceKind,
    instanceUid: String(instanceUid || ""),
    senderId: String(senderId || ""),
    threadId: String(threadId || ""),
    scope,
    role,
    source,
    command,
    verdict,
  };
  const trimmedDetail = trimDetail(detail);
  if (trimmedDetail) record.detail = trimmedDetail;
  return record;
}

export function logAuthorizationDecision(options = {}, { projectRoot } = {}) {
  try {
    const root = projectRoot || getProjectRoot();
    // Async NDJSON logging keeps authorization auditing off the hot path.
    getLoggerFor(root).log({ scope: "authorization", ...options });
  } catch {
    // never break the message pipeline because of logging
  }
}

export async function flushAuthorizationLogs() {
  await Promise.all([...sharedLoggers.values()].map((logger) => logger.flush()));
}
