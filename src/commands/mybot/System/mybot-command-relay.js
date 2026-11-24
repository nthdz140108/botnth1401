import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getProjectRoot } from "../../../utils/env.js";

const DEFAULT_SECRET_FILE = ".internal_secret";

export function getInternalSecret({ projectRoot = getProjectRoot() } = {}) {
  const root = projectRoot || getProjectRoot();
  const secretPath = path.join(root, "mybot", DEFAULT_SECRET_FILE);
  try {
    if (fs.existsSync(secretPath)) {
      const secret = fs.readFileSync(secretPath, "utf8").trim();
      if (secret) return secret;
    }
  } catch {}

  const newSecret = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, newSecret, "utf8");
  } catch {}
  return newSecret;
}

export function buildCanonicalEnvelopePayload({
  requestId,
  actorGlobalUid = "",
  sourceBotUid = "",
  targetBotUid = "",
  targetGlobalUid = "",
  threadId = "",
  threadType = 1,
  commandText = "",
  mentions = [],
  timestamp = "",
  actorRole = "",
  capabilities = [],
}) {
  const canonicalMentions = Array.isArray(mentions)
    ? JSON.stringify(
        mentions.map((m) => ({
          uid: String(m?.uid || "").trim(),
          globalUid: m?.globalUid ? String(m.globalUid).trim() : undefined,
        }))
      )
    : "[]";

  const canonicalCaps = Array.isArray(capabilities)
    ? JSON.stringify(capabilities.map((c) => String(c || "").trim()).sort())
    : "[]";

  return [
    String(requestId || "").trim(),
    String(actorGlobalUid || "").trim(),
    String(sourceBotUid || "").trim(),
    String(targetBotUid || "").trim(),
    String(targetGlobalUid || "").trim(),
    String(threadId || "").trim(),
    String(threadType ?? 1),
    String(commandText || "").trim(),
    canonicalMentions,
    String(actorRole || "").trim(),
    canonicalCaps,
    String(timestamp || "").trim(),
  ].join("|");
}

export function generateInternalSignature({
  requestId,
  actorUid,
  actorGlobalUid,
  sourceBotUid,
  targetBotUid,
  targetGlobalUid,
  threadId,
  threadType,
  commandText,
  mentions,
  timestamp,
  actorRole = "",
  capabilities = [],
  secret,
}) {
  const payloadStr = buildCanonicalEnvelopePayload({
    requestId,
    actorGlobalUid: actorGlobalUid || "",
    sourceBotUid,
    targetBotUid,
    targetGlobalUid: targetGlobalUid || "",
    threadId,
    threadType,
    commandText,
    mentions,
    timestamp,
    actorRole: actorRole || "",
    capabilities: capabilities || [],
  });
  return crypto.createHmac("sha256", secret).update(payloadStr).digest("hex");
}

export function verifyInternalSignature({
  requestId,
  actorUid,
  actorGlobalUid,
  sourceBotUid,
  targetBotUid,
  targetGlobalUid,
  threadId,
  threadType,
  commandText,
  mentions,
  timestamp,
  actorRole = "",
  capabilities = [],
  signature,
  secret,
  mode = "off",
}) {
  if (!signature || typeof signature !== "string" || !secret) return false;

  // 1. Check canonical full envelope signature with actorRole & capabilities
  const canonicalPayload = buildCanonicalEnvelopePayload({
    requestId,
    actorGlobalUid: actorGlobalUid || "",
    sourceBotUid,
    targetBotUid,
    targetGlobalUid: targetGlobalUid || "",
    threadId,
    threadType,
    commandText,
    mentions,
    timestamp,
    actorRole: actorRole || "",
    capabilities: capabilities || [],
  });

  const expectedCanonical = crypto.createHmac("sha256", secret).update(canonicalPayload).digest("hex");
  const sigBuf = Buffer.from(signature, "utf8");
  const canBuf = Buffer.from(expectedCanonical, "utf8");

  if (sigBuf.length === canBuf.length && crypto.timingSafeEqual(sigBuf, canBuf)) {
    return true;
  }

  // 2. In enforce mode, do not accept legacy signature
  const normMode = String(mode || "").toLowerCase();
  if (normMode === "enforce") {
    return false;
  }

  // 3. Backward compatibility: check without role/caps (v1 canonical envelope)
  const canonicalV1Payload = [
    String(requestId || "").trim(),
    String(actorGlobalUid || "").trim(),
    String(sourceBotUid || "").trim(),
    String(targetBotUid || "").trim(),
    String(targetGlobalUid || "").trim(),
    String(threadId || "").trim(),
    String(threadType ?? 1),
    String(commandText || "").trim(),
    Array.isArray(mentions) ? JSON.stringify(mentions.map(m => ({ uid: String(m?.uid || "").trim(), globalUid: m?.globalUid ? String(m.globalUid).trim() : undefined }))) : "[]",
    String(timestamp || "").trim(),
  ].join("|");
  const expectedV1 = crypto.createHmac("sha256", secret).update(canonicalV1Payload).digest("hex");
  const v1Buf = Buffer.from(expectedV1, "utf8");
  if (sigBuf.length === v1Buf.length && crypto.timingSafeEqual(sigBuf, v1Buf)) {
    return true;
  }

  // 4. For off / shadow mode: fallback check for legacy signature format
  const actorKey = actorGlobalUid || actorUid || "";
  const legacyPayload = `${requestId}:${actorKey}:${sourceBotUid}:${targetBotUid}:${timestamp}`;
  const expectedLegacy = crypto.createHmac("sha256", secret).update(legacyPayload).digest("hex");
  const legBuf = Buffer.from(expectedLegacy, "utf8");

  if (sigBuf.length === legBuf.length && crypto.timingSafeEqual(sigBuf, legBuf)) {
    return true;
  }

  return false;
}

export function appendRelayAudit({
  projectRoot = getProjectRoot(),
  record,
}) {
  try {
    const root = projectRoot || getProjectRoot();
    const auditPath = path.join(root, "logs", "child-command-relay-audit.jsonl");
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.error("[mybot-command-relay] Failed to write audit log:", error.message);
  }
}

function resolveTargetWebPort(targetBot, projectRoot) {
  if (targetBot?.webPort && Number.isFinite(parseInt(targetBot.webPort, 10))) {
    return parseInt(targetBot.webPort, 10);
  }
  const botUid = String(targetBot?.uid || targetBot?.key || "").trim();
  if (!botUid) return null;

  try {
    const configPath = path.join(projectRoot, "mybot", "bots", `${botUid}.json`);
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const p = parseInt(parsed.webPort, 10);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {}

  try {
    const registryPath = path.join(projectRoot, "mybot", "mybots.json");
    if (fs.existsSync(registryPath)) {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      const p = parseInt(parsed?.[botUid]?.webPort, 10);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {}

  return null;
}

export async function relayCommandToChild({
  targetBot,
  actorUid,
  actorGlobalUid: explicitActorGlobalUid = null,
  actorUsername: explicitActorUsername = null,
  actorRole: explicitActorRole = null,
  capabilities: explicitCapabilities = null,
  targetGlobalUid: explicitTargetGlobalUid = null,
  sourceBotUid,
  threadId,
  threadType = 1,
  commandText,
  mentions = [],
  requestId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  timeoutMs = 15000,
  projectRoot = getProjectRoot(),
  fetchFn = globalThis.fetch,
  api = null,
  store = null,
  identityMode = null,
} = {}) {
  const root = projectRoot || getProjectRoot();
  const targetBotUid = String(targetBot?.uid || targetBot?.key || "").trim();

  let actorGlobalUid = explicitActorGlobalUid;
  let actorUsername = explicitActorUsername;
  let targetGlobalUid = explicitTargetGlobalUid || targetBot?.globalUid || null;
  let processedMentions = Array.isArray(mentions) ? [...mentions] : [];

  // Determine actor role from Main Bot if not passed explicitly
  let actorRole = explicitActorRole;
  if (!actorRole && actorUid) {
    try {
      const { resolveMyBotCallerRole } = await import("./mybot-identity.js");
      const callerRoleRes = resolveMyBotCallerRole({
        uidFrom: actorUid,
        adminBotUid: sourceBotUid,
        projectRoot: root,
      });
      if (callerRoleRes.isSystemAdmin) {
        actorRole = "adminLevelHigh";
      } else if (callerRoleRes.canManageBot(targetBot)) {
        actorRole = "adminBot";
      } else {
        actorRole = "user";
      }
    } catch {
      actorRole = "user";
    }
  }
  if (!actorRole) actorRole = "user";
  const capabilities = Array.isArray(explicitCapabilities) && explicitCapabilities.length > 0
    ? explicitCapabilities
    : ["EXECUTE_CHILD_COMMAND"];

  let effectiveMode = identityMode;
  if (!effectiveMode) {
    try {
      const { getIdentityMode } = await import("../../../identity/index.js");
      effectiveMode = getIdentityMode();
    } catch {
      effectiveMode = process.env.MULTI_BOT_IDENTITY_MODE || "off";
    }
  }

  // Identity resolution if mode is shadow or enforce
  if (effectiveMode === "shadow" || effectiveMode === "enforce") {
    let idStore = store;
    if (!idStore) {
      try {
        const { getIdentityPool, createIdentityStore, isIdentityDbAvailable } = await import("../../../identity/index.js");
        const pool = getIdentityPool();
        if (await isIdentityDbAvailable(pool)) {
          idStore = createIdentityStore({ pool });
        }
      } catch {}
    }

    if (!idStore && effectiveMode === "enforce") {
      appendRelayAudit({
        projectRoot: root,
        record: {
          ts: new Date().toISOString(),
          requestId,
          actorUid: String(actorUid || ""),
          actorRole,
          capabilities,
          sourceBotUid: String(sourceBotUid || ""),
          targetBotUid,
          result: "failed",
          error: "IDENTITY_DB_UNAVAILABLE",
        },
      });
      return {
        success: false,
        code: "IDENTITY_DB_UNAVAILABLE",
        message: "Không thể kết nối cơ sở dữ liệu định danh MySQL trung tâm.",
      };
    }

    if (idStore && !actorGlobalUid && actorUid) {
      try {
        const { resolveOrLinkIdentity } = await import("../../../identity/index.js");
        const resolved = await resolveOrLinkIdentity({
          store: idStore,
          api,
          botId: sourceBotUid || "main",
          localUid: actorUid,
          source: "relay_outbound",
        });
        actorGlobalUid = resolved.globalUid;
        actorUsername = resolved.canonicalUsername;
      } catch (resErr) {
        if (effectiveMode === "enforce") {
          appendRelayAudit({
            projectRoot: root,
            record: {
              ts: new Date().toISOString(),
              requestId,
              actorUid: String(actorUid || ""),
              actorRole,
              capabilities,
              sourceBotUid: String(sourceBotUid || ""),
              targetBotUid,
              result: "failed",
              error: resErr.code || "IDENTITY_RESOLUTION_FAILED",
            },
          });
          return {
            success: false,
            code: resErr.code || "IDENTITY_RESOLUTION_FAILED",
            message: `Lỗi đồng bộ định danh người gửi: ${resErr.message}`,
          };
        }
      }
    }

    // Resolve mentions to globalUid
    if (idStore && processedMentions.length > 0) {
      try {
        const { resolveOrLinkIdentity } = await import("../../../identity/index.js");
        for (let i = 0; i < processedMentions.length; i++) {
          const mention = processedMentions[i];
          if (mention?.uid && !mention.globalUid) {
            try {
              const resMention = await resolveOrLinkIdentity({
                store: idStore,
                api,
                botId: sourceBotUid || "main",
                localUid: mention.uid,
                source: "mention_resolution",
              });
              processedMentions[i] = { ...mention, globalUid: resMention.globalUid };
            } catch (mentionErr) {
              if (effectiveMode === "enforce") {
                appendRelayAudit({
                  projectRoot: root,
                  record: {
                    ts: new Date().toISOString(),
                    requestId,
                    actorUid: String(actorUid || ""),
                    mentionUid: String(mention.uid),
                    result: "failed",
                    error: "IDENTITY_NOT_LINKED",
                  },
                });
                return {
                  success: false,
                  code: "IDENTITY_NOT_LINKED",
                  message: `Không thể định danh người được mention (${mention.uid}) trong chế độ enforce: ${mentionErr.message}`,
                };
              }
            }
          }
        }
      } catch (mentionBatchErr) {
        if (effectiveMode === "enforce") {
          return {
            success: false,
            code: "IDENTITY_NOT_LINKED",
            message: `Lỗi xử lý mention: ${mentionBatchErr.message}`,
          };
        }
      }
    }

    // Enforce mode final verification
    if (effectiveMode === "enforce") {
      if (!actorGlobalUid) {
        return {
          success: false,
          code: "IDENTITY_NOT_LINKED",
          message: "Người gửi chưa có định danh toàn cục (globalUid).",
        };
      }
      for (const m of processedMentions) {
        if (!m.globalUid) {
          return {
            success: false,
            code: "IDENTITY_NOT_LINKED",
            message: `Mention ${m.uid} chưa có định danh toàn cục (globalUid).`,
          };
        }
      }
    }
  }

  const auditBase = {
    ts: new Date().toISOString(),
    requestId,
    actorUid: String(actorUid || ""),
    actorRole,
    capabilities,
    actorGlobalUid: actorGlobalUid || undefined,
    sourceBotUid: String(sourceBotUid || ""),
    targetBotUid,
    targetGlobalUid: targetGlobalUid || undefined,
    threadId: String(threadId || ""),
    threadType: Number(threadType ?? 1),
    commandText: String(commandText || ""),
  };

  const webPort = resolveTargetWebPort(targetBot, root);
  if (!webPort) {
    appendRelayAudit({
      projectRoot: root,
      record: { ...auditBase, result: "failed", error: "MISSING_WEB_PORT" },
    });
    return {
      success: false,
      code: "MISSING_WEB_PORT",
      message: `Không tìm thấy cổng web của bot con ${targetBotUid || targetBot?.displayName || "này"}.`,
    };
  }

  const secret = getInternalSecret({ projectRoot: root });
  const timestamp = Date.now();
  const signature = generateInternalSignature({
    requestId,
    actorUid,
    actorGlobalUid,
    sourceBotUid,
    targetBotUid,
    targetGlobalUid,
    threadId,
    threadType,
    commandText,
    mentions: processedMentions,
    timestamp,
    actorRole,
    capabilities,
    secret,
  });

  const payload = {
    requestId,
    actorUid: String(actorUid || ""),
    actorRole,
    capabilities,
    actorGlobalUid: actorGlobalUid || undefined,
    actorUsername: actorUsername || undefined,
    sourceBotUid: String(sourceBotUid || ""),
    targetBotUid,
    targetGlobalUid: targetGlobalUid || undefined,
    threadId: String(threadId || ""),
    threadType: Number(threadType ?? 1),
    commandText: String(commandText || ""),
    mentions: processedMentions,
    timestamp,
  };

  const url = `http://127.0.0.1:${webPort}/internal/command/execute`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connection": "close",
        "X-Internal-Signature": signature,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Request-Id": requestId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let parsedErr = {};
      try {
        parsedErr = JSON.parse(errorBody);
      } catch {}
      const errorCode = parsedErr?.code || `HTTP_${response.status}`;
      const errorMessage = parsedErr?.error || parsedErr?.message || errorBody || response.statusText;

      appendRelayAudit({
        projectRoot: root,
        record: {
          ...auditBase,
          result: "failed",
          status: response.status,
          error: errorBody,
        },
      });
      return {
        success: false,
        code: errorCode,
        message: `Bot con phản hồi mã lỗi ${response.status}: ${errorMessage}`,
        data: parsedErr,
      };
    }

    const data = await response.json().catch(() => ({}));
    appendRelayAudit({
      projectRoot: root,
      record: { ...auditBase, result: "ok", response: data },
    });

    return {
      success: true,
      requestId,
      data,
    };
  } catch (error) {
    const isTimeout = error.name === "AbortError";
    appendRelayAudit({
      projectRoot: root,
      record: {
        ...auditBase,
        result: "failed",
        error: isTimeout ? "TIMEOUT" : error.message,
      },
    });

    return {
      success: false,
      code: isTimeout ? "TIMEOUT" : "CONNECTION_ERROR",
      message: isTimeout
        ? `Quá thời gian kết nối tới bot con (${timeoutMs}ms).`
        : `Không thể kết nối tới bot con tại cổng ${webPort}: ${error.message}`,
    };
  }
}
