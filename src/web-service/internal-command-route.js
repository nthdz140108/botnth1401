import { getInternalSecret, verifyInternalSignature } from "../commands/mybot/System/mybot-command-relay.js";
import { readCommandConfig, readGroupSettings, readAdmins, readMainBotAdmins, isMainBotAdmin } from "../utils/io-json.js";
import { resolveChildAuthorization } from "../utils/child-authorization.js";

const processedRequestIds = new Map();

function isLoopbackIp(ip) {
  if (!ip) return false;
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"].includes(String(ip).trim());
}

function cleanOldRequests() {
  const now = Date.now();
  for (const [id, ts] of processedRequestIds.entries()) {
    if (now - ts > 10 * 60 * 1000) {
      processedRequestIds.delete(id);
    }
  }
}

function isDisallowedManagementCommand(rawText, prefix = "!") {
  if (!rawText) return false;
  let clean = String(rawText).trim();
  // Strip leading/trailing parentheses, square brackets, angle brackets
  clean = clean.replace(/^[(\[<]+/, "").replace(/[)\]>]+$/, "").trim();
  if (clean.startsWith(prefix)) {
    clean = clean.slice(prefix.length).trim();
  }
  const firstToken = clean.split(/\s+/)[0]?.toLowerCase();
  const disallowed = new Set(["mybot", "mebot", "clean"]);
  return disallowed.has(firstToken);
}

export function registerInternalCommandRoutes(
  app,
  {
    api,
    getApi = null,
    projectRoot,
    identityStore = null,
    identityMode: injectedIdentityMode = null,
    commandHandlers = null,
  } = {}
) {
  app.post("/internal/command/execute", async (req, res) => {
    cleanOldRequests();

    const clientIp = req.ip || req.socket?.remoteAddress;
    if (!isLoopbackIp(clientIp)) {
      return res.status(403).json({ error: "Forbidden: Localhost requests only" });
    }

    const {
      requestId,
      actorUid,
      actorGlobalUid,
      actorUsername,
      actorRole,
      capabilities,
      sourceBotUid,
      targetBotUid,
      targetGlobalUid,
      threadId,
      threadType,
      commandText,
      mentions,
      timestamp,
      deliverToZalo: rawDeliverToZalo,
    } = req.body || {};
    const deliverToZalo = rawDeliverToZalo !== false;
    const isWebConsoleAdmin =
      actorRole === "system_admin" &&
      Array.isArray(capabilities) &&
      capabilities.includes("remote_execute");

    if (!requestId || (!actorUid && !actorGlobalUid) || !commandText || !threadId) {
      return res.status(400).json({ error: "Invalid payload: missing required fields" });
    }

    let identityMode = injectedIdentityMode;
    if (!identityMode) {
      try {
        const { getIdentityMode } = await import("../identity/index.js");
        identityMode = getIdentityMode();
      } catch {
        identityMode = process.env.MULTI_BOT_IDENTITY_MODE || "off";
      }
    }

    const secret = getInternalSecret({ projectRoot });
    const signature = req.headers["x-internal-signature"];
    const reqTimestamp = parseInt(req.headers["x-internal-timestamp"] || timestamp, 10);

    if (!reqTimestamp || Math.abs(Date.now() - reqTimestamp) > 60000) {
      return res.status(401).json({ error: "Unauthorized: Request timestamp is expired or invalid" });
    }

    const validSig = verifyInternalSignature({
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
      timestamp: reqTimestamp,
      actorRole: actorRole || "",
      capabilities: Array.isArray(capabilities) ? capabilities : [],
      signature,
      secret,
      mode: identityMode,
    });

    if (!validSig) {
      return res.status(403).json({ error: "Forbidden: Invalid internal signature" });
    }

    if (processedRequestIds.has(requestId)) {
      return res.json({ success: true, duplicate: true, status: "completed", requestId });
    }
    processedRequestIds.set(requestId, Date.now());

    try {
      const prefix = readCommandConfig()?.prefix || "!";
      const rawCmd = String(commandText).trim();

      // Check if command is disallowed management command (allowed for authenticated Web Admin Console on Main Bot)
      if (!isWebConsoleAdmin && isDisallowedManagementCommand(rawCmd, prefix)) {
        return res.status(400).json({
          success: false,
          error: "DISALLOWED_COMMAND: Bot con không được phép thực thi nhóm lệnh quản lý bot từ xa",
          code: "DISALLOWED_COMMAND",
        });
      }

      const normalizedContent = rawCmd.startsWith(prefix) ? rawCmd : `${prefix}${rawCmd}`;

      const resolvedApi = (typeof getApi === "function" ? getApi() : null) || api || (await import("../service-debug/service.js")).getApi?.() || (await import("../api-zalo/context.js")).appContext?.api;

      let runtimeBotName = "";
      let isMainProcess = false;
      try {
        const envMod = await import("../utils/env.js");
        runtimeBotName = String(envMod.getBotName?.() || "").trim();
        isMainProcess = envMod.getInstanceKind?.() === "main" || runtimeBotName.toLowerCase() === "admin";
      } catch {}

      // childBotId must be the real Zalo UID of this bot process,
      // matching the botId used during identity hydration
      let childBotId = "";
      const apiBotId = resolvedApi?.getBotId?.();
      if (apiBotId && String(apiBotId).trim() && String(apiBotId).trim() !== "-1" && String(apiBotId).trim().toLowerCase() !== "admin") {
        childBotId = String(apiBotId).trim();
      }
      if (!childBotId) {
        try {
          const { appContext: ctx } = await import("../api-zalo/context.js");
          const ctxUid = ctx?.uid || ctx?.userId;
          if (ctxUid && String(ctxUid).trim() && String(ctxUid).trim().toLowerCase() !== "admin") {
            childBotId = String(ctxUid).trim();
          }
        } catch {}
      }
      if (!childBotId && runtimeBotName && runtimeBotName.toLowerCase() !== "admin") {
        childBotId = runtimeBotName;
      }
      if (!childBotId) {
        childBotId = String(targetBotUid || "").trim();
      }

      if (targetBotUid && childBotId) {
        const targetClean = String(targetBotUid).trim().toLowerCase();
        const childClean = String(childBotId).trim().toLowerCase();
        const envNameClean = String(process.env.BOT_NAME || runtimeBotName || "").trim().toLowerCase();
        const envUidClean = String(process.env.BOT_UID || "").trim().toLowerCase();
        const envKeyClean = String(process.env.BOT_KEY || "").trim().toLowerCase();
        const matchesMainAlias = isMainProcess && targetClean === "admin";
        const matchesTarget =
          matchesMainAlias ||
          targetClean === childClean ||
          (envNameClean && targetClean === envNameClean) ||
          (envUidClean && targetClean === envUidClean) ||
          (envKeyClean && targetClean === envKeyClean);
        if (!matchesTarget) {
          return res.status(403).json({
            success: false,
            error: `TARGET_MISMATCH: Bot (${childBotId}) không khớp targetBotUid (${targetBotUid})`,
            code: "TARGET_MISMATCH",
          });
        }
      }

      // Identity resolution on child bot
      let childLocalUid = null;
      let idStore = identityStore;

      if (!idStore && (identityMode === "shadow" || identityMode === "enforce")) {
        try {
          const { getIdentityPool, createIdentityStore, isIdentityDbAvailable } = await import("../identity/index.js");
          const pool = getIdentityPool();
          if (await isIdentityDbAvailable(pool)) {
            idStore = createIdentityStore({ pool });
          }
        } catch {}
      }

      if (identityMode === "enforce" && !idStore) {
        return res.status(400).json({
          success: false,
          error: "IDENTITY_DB_UNAVAILABLE: Cơ sở dữ liệu định danh MySQL trung tâm không khả dụng trên bot con",
          code: "IDENTITY_DB_UNAVAILABLE",
        });
      }

      if (identityMode === "enforce" && !actorGlobalUid) {
        return res.status(400).json({
          success: false,
          error: "IDENTITY_NOT_LINKED: Người gửi chưa có định danh toàn cục (globalUid)",
          code: "IDENTITY_NOT_LINKED",
        });
      }

      if (idStore && actorGlobalUid) {
        try {
          const { resolveUidForBot } = await import("../identity/index.js");
          childLocalUid = await resolveUidForBot({ store: idStore, botId: childBotId, globalUid: actorGlobalUid });
        } catch (err) {
          // If mapping doesn't exist, try to auto-create it via resolveOrLinkIdentity
          if (idStore && actorUid) {
            try {
              const { resolveOrLinkIdentity } = await import("../identity/index.js");
              const linked = await resolveOrLinkIdentity({
                store: idStore,
                api: resolvedApi,
                botId: childBotId,
                localUid: actorUid,
                source: "relay_inbound_auto_link",
              });
              if (linked?.globalUid === actorGlobalUid) {
                childLocalUid = actorUid;
              }
            } catch (linkErr) {
              console.warn(`[internal-command] Auto-link identity failed for actor ${actorUid} on bot ${childBotId}: ${linkErr.message}`);
            }
          }

          if (!childLocalUid && identityMode === "enforce") {
            return res.status(400).json({
              success: false,
              error: `IDENTITY_NOT_LINKED: Người dùng chưa được liên kết với bot con ${childBotId} (${err.message})`,
              code: "IDENTITY_NOT_LINKED",
            });
          }
        }
      }

      if (identityMode === "enforce" && !childLocalUid) {
        return res.status(400).json({
          success: false,
          error: `IDENTITY_NOT_LINKED: Không tìm thấy mapping cục bộ của người dùng trên bot con ${childBotId}`,
          code: "IDENTITY_NOT_LINKED",
        });
      }

      const effectiveActorUid = childLocalUid || actorUid;

      // Resolve mentions to local UIDs on child bot
      let resolvedMentions = Array.isArray(mentions) ? [...mentions] : [];
      if (resolvedMentions.length > 0) {
        if (identityMode === "enforce") {
          const { resolveUidForBot } = await import("../identity/index.js");
          for (let i = 0; i < resolvedMentions.length; i++) {
            const m = resolvedMentions[i];
            if (!m?.globalUid) {
              return res.status(400).json({
                success: false,
                error: `IDENTITY_NOT_LINKED: Mention ${m?.uid} thiếu định danh toàn cục (globalUid)`,
                code: "IDENTITY_NOT_LINKED",
              });
            }
            try {
              const mLocal = await resolveUidForBot({ store: idStore, botId: childBotId, globalUid: m.globalUid });
              resolvedMentions[i] = { ...m, uid: mLocal };
            } catch (mentionResErr) {
              return res.status(400).json({
                success: false,
                error: `IDENTITY_NOT_LINKED: Không thể ánh xạ mention ${m.globalUid} sang local UID trên bot con ${childBotId}: ${mentionResErr.message}`,
                code: "IDENTITY_NOT_LINKED",
              });
            }
          }
        } else if (idStore) {
          try {
            const { resolveUidForBot } = await import("../identity/index.js");
            resolvedMentions = await Promise.all(
              resolvedMentions.map(async (m) => {
                if (m?.globalUid) {
                  try {
                    const mLocal = await resolveUidForBot({ store: idStore, botId: childBotId, globalUid: m.globalUid });
                    return { ...m, uid: mLocal };
                  } catch {
                    return m;
                  }
                }
                return m;
              })
            );
          } catch {}
        }
      }

      const isVirtualConsoleThread = String(threadId) === "web_remote_console";
      const inferredType = isVirtualConsoleThread
        ? 0
        : Number(threadType ?? (String(threadId).length >= 15 ? 1 : 0));
      const effectiveSenderUid =
        isWebConsoleAdmin && (!effectiveActorUid || String(effectiveActorUid).toLowerCase() === "admin")
          ? String(childBotId || effectiveActorUid || "admin")
          : String(effectiveActorUid);

      const syntheticMessage = {
        threadId: String(threadId),
        type: inferredType,
        data: {
          msgId: `internal_${requestId}_${Date.now()}`,
          cliMsgId: `internal_${requestId}`,
          uidFrom: effectiveSenderUid,
          dName: isWebConsoleAdmin ? "Web Admin" : "",
          content: normalizedContent,
          mentions: resolvedMentions,
          isRelayed: true,
          relayedFrom: sourceBotUid,
          actorGlobalUid: actorGlobalUid || undefined,
          actorUsername: actorUsername || undefined,
          requestId,
        },
      };

      const capturedOutputs = [];
      let delivered = false;

      let groupInfo = null;
      let groupAdmins = [];
      let inGroup = syntheticMessage.type === 1;
      if (syntheticMessage.type === 1 && deliverToZalo && !isVirtualConsoleThread) {
        try {
          if (typeof resolvedApi?.getGroupInfo === "function") {
            const rawInfo = await resolvedApi.getGroupInfo(String(threadId));
            if (!rawInfo || rawInfo.error || rawInfo.status === 404) {
              inGroup = false;
            }
          }
          const { getGroupInfoData, getGroupAdmins } = await import("../service-debug/info-service/group-info.js");
          if (typeof getGroupInfoData === "function" && resolvedApi) {
            groupInfo = await getGroupInfoData(resolvedApi, String(threadId));
            if (groupInfo && typeof getGroupAdmins === "function") {
              groupAdmins = await getGroupAdmins(groupInfo);
            }
          }
        } catch (err) {
          inGroup = false;
          console.warn(`[internal-command] Bot ${childBotId || targetBotUid} không thể lấy thông tin nhóm ${threadId}: ${err.message}`);
        }
      }

      const interceptedMethods = {
        sendReaction: async (...args) => {
          if (!deliverToZalo || isVirtualConsoleThread) return { ok: true, dryRun: true };
          if (typeof resolvedApi.addReaction === "function") return resolvedApi.addReaction(...args);
          if (typeof resolvedApi.sendReaction === "function") return resolvedApi.sendReaction(...args);
          return null;
        },
        addReaction: async (...args) => {
          if (!deliverToZalo || isVirtualConsoleThread) return { ok: true, dryRun: true };
          if (typeof resolvedApi.addReaction === "function") return resolvedApi.addReaction(...args);
          return null;
        },
        sendMessage: async (payload, targetThreadId, targetType) => {
          const textMsg = typeof payload === "string"
            ? payload
            : (payload?.msg || payload?.caption || (Array.isArray(payload?.attachments) && payload.attachments.length ? `[Đính kèm ${payload.attachments.length} tệp media]` : ""));
          if (textMsg) {
            capturedOutputs.push(textMsg);
          }
          if (!deliverToZalo || isVirtualConsoleThread) {
            return { msgId: `dryrun_${Date.now()}`, dryRun: true };
          }
          const cleanPayload = (typeof payload === "object" && payload !== null) ? { ...payload } : payload;
          if (cleanPayload && typeof cleanPayload === "object") {
            if (cleanPayload.quote?.data?.isRelayed || String(cleanPayload.quote?.data?.msgId || "").startsWith("internal_")) {
              delete cleanPayload.quote;
            }
          }
          try {
            const res = await resolvedApi.sendMessage(cleanPayload, targetThreadId, targetType);
            if (String(targetThreadId) === String(threadId) && Number(targetType) === Number(syntheticMessage.type)) {
              delivered = true;
            }
            return res;
          } catch (sendErr) {
            if (Number(targetType) === 1) {
              inGroup = false;
            }
            console.warn(`[internal-command] Failed sending message to thread ${targetThreadId} (type ${targetType}): ${sendErr.message}`);
            if (targetType === 1 && effectiveSenderUid && effectiveSenderUid !== "admin") {
              try {
                console.log(`[internal-command] Attempting fallback private message to actor ${effectiveSenderUid}`);
                const dmRes = await resolvedApi.sendMessage(cleanPayload, effectiveSenderUid, 0);
                return dmRes;
              } catch (dmErr) {
                console.warn(`[internal-command] Fallback private message to actor ${effectiveSenderUid} also failed: ${dmErr.message}`);
              }
            }
            throw sendErr;
          }
        },
      };

      const dryRunMediaMethods = new Set([
        "sendVideo",
        "sendVoice",
        "sendImage",
        "sendGif",
        "sendSticker",
        "sendFile",
        "zSendLocalImage",
        "zSendLocalImages",
      ]);

      const executionApi = resolvedApi
        ? new Proxy(resolvedApi, {
            get(target, prop, receiver) {
              if (Object.prototype.hasOwnProperty.call(interceptedMethods, prop)) {
                return interceptedMethods[prop];
              }
              if ((!deliverToZalo || isVirtualConsoleThread) && typeof prop === "string" && dryRunMediaMethods.has(prop)) {
                return async (...args) => {
                  const first = args[0];
                  const desc =
                    (typeof first === "object" && first !== null && (first.msg || first.caption || first.videoUrl || first.imageUrl)) ||
                    (typeof first === "string" ? first : prop);
                  capturedOutputs.push(`[Media ${prop}] ${desc}`);
                  return { msgId: `dryrun_media_${Date.now()}`, dryRun: true };
                };
              }
              const val = Reflect.get(target, prop, receiver);
              return typeof val === "function" ? val.bind(target) : val;
            },
          })
        : resolvedApi;

      // Determine genuine bot authorization & role policy
      const childAuth = resolveChildAuthorization({
        childUid: childBotId,
        actorUid: effectiveSenderUid,
        envelopeRole: actorRole || null,
        capabilities: Array.isArray(capabilities) ? capabilities : [],
        groupAdmins,
        projectRoot,
      });

      const callerIsAdminLevelHigh = Boolean(isWebConsoleAdmin || childAuth.isAdminLevelHigh);
      const callerIsBotAdmin = Boolean(isWebConsoleAdmin || childAuth.isBotAdmin);
      const callerIsAdminBox = Boolean(isWebConsoleAdmin || childAuth.isGroupAdmin);

      const relayAuthorization = {
        senderId: effectiveSenderUid,
        threadId: String(threadId),
        instanceKind: isMainProcess ? "main" : "child",
        instanceUid: childBotId,
        mainBotUid: String(sourceBotUid || ""),
        role: isWebConsoleAdmin ? "adminLevelHigh" : childAuth.role,
        capabilities: childAuth.capabilities,
        source: isWebConsoleAdmin ? "webConsoleAdmin" : "internalRelay",
        isRelayed: true,
        isRelayedFromMain: Boolean(sourceBotUid),
        isAdminLevelHigh: callerIsAdminLevelHigh,
        isBotAdmin: callerIsBotAdmin,
        isGroupAdmin: callerIsAdminBox,
        isMainBotAdmin: Boolean(isWebConsoleAdmin || childAuth.isMainBotAdmin),
        isOwner: Boolean(isWebConsoleAdmin || childAuth.isOwner),
        isSelf: Boolean(isWebConsoleAdmin || childAuth.isSelf),
        actorGlobalUid: actorGlobalUid || undefined,
      };

      let executionError = null;
      try {
        if (syntheticMessage.type === 0) {
          const handleCommandPrivate =
            commandHandlers?.handleCommandPrivate ||
            (await import("../commands/command.js")).handleCommandPrivate;
          await handleCommandPrivate(executionApi, syntheticMessage, relayAuthorization);
        } else {
          const handleCommand =
            commandHandlers?.handleCommand ||
            (await import("../commands/command.js")).handleCommand;
          const groupSettings = readGroupSettings();
          await handleCommand(
            executionApi,
            syntheticMessage,
            groupInfo,
            groupAdmins,
            groupSettings,
            callerIsAdminLevelHigh,
            callerIsBotAdmin,
            callerIsAdminBox,
            true, // handleChat
            relayAuthorization
          );
        }
      } catch (err) {
        executionError = err.message || String(err);
        console.error(`[internal-command] Error in command execution:`, err);
      }

      return res.json({
        success: true,
        requestId,
        status: "completed",
        inGroup,
        delivered,
        outputs: capturedOutputs,
        error: executionError,
        botId: childBotId,
      });
    } catch (error) {
      console.error(`[internal-command] Error dispatching command:`, error);
      return res.status(500).json({ error: error.message });
    }
  });
}
