import { apiRequest } from "../app/api.js";

export async function loadBotWorkspaceData({ botId, request = apiRequest } = {}) {
  if (!botId) throw new Error("botId is required");

  const botPath = `/api/bots/${encodeURIComponent(botId)}`;
  const runtimePath = `/api/bots/${encodeURIComponent(botId)}/runtime`;
  const configPath = `/api/bots/${encodeURIComponent(botId)}/config`;
  const credentialPath = `/api/bots/${encodeURIComponent(botId)}/credential`;
  const prefixPath = `/api/bots/${encodeURIComponent(botId)}/prefix`;
  const profilePath = `/api/bots/${encodeURIComponent(botId)}/profile`;
  const qrPath = `/api/bots/${encodeURIComponent(botId)}/qr-login`;

  const [
    botResult,
    runtimeResult,
    configResult,
    credentialResult,
    prefixResult,
    profileResult,
    qrResult,
  ] = await Promise.all([
    request(botPath),
    request(runtimePath),
    request(configPath),
    request(credentialPath),
    request(prefixPath),
    request(profilePath).catch(() => ({ data: null })),
    request(qrPath).catch((error) => ({ __qrError: error })),
  ]);

  const files = (configResult.data || configResult).files || {};
  const credential = (credentialResult.data || credentialResult).value || {};
  const prefixData = prefixResult.data || prefixResult;
  const bot = botResult.data || botResult;
  const runtime = runtimeResult.data || runtimeResult;
  const profile = (profileResult.data || profileResult) || null;
  const qrSession = qrResult?.__qrError ? null : (qrResult.data || qrResult);

  let trialStatus = null;
  const ownerUid = profile?.ownerUid || bot?.ownerUid || botId;
  if (ownerUid) {
    try {
      const trialResult = await request(`/api/owners/${encodeURIComponent(ownerUid)}/trial-status`);
      trialStatus = trialResult.data || trialResult;
    } catch {}
  }

  return {
    bot,
    runtime,
    profile,
    trialStatus,
    files,
    credential,
    prefix: prefixData.prefix || "!",
    prefixAvailable: prefixData.available !== false,
    qrSession,
    qrError: qrResult?.__qrError ? qrResult.__qrError.message : "",
    error: "",
  };
}
