// Claim client IDs before the network request; echoes can precede receipts.
const entries = new Map();
const TTL = 10 * 60 * 1000;
let lastClientId = 0;
export function nextOutboundClientId() {
  lastClientId = Math.max(Date.now(), lastClientId + 1);
  return lastClientId;
}
function prune() {
  const now = Date.now();
  for (const [key, expires] of entries) {
    if (expires <= now || entries.size > 20000) entries.delete(key);
    else break;
  }
}
function echoIds(data) {
  return [
    ['client', data?.clientId], ['client', data?.cliMsgId],
    ['message', data?.msgId], ['message', data?.messageId], ['message', data?.globalMsgId],
  ].filter(([, id]) => (typeof id === 'string' || Number.isFinite(id)) && !['', '0', '-1'].includes(String(id).trim()));
}
export function rememberOutboundMessage(botId, threadId, receipt) {
  prune();
  for (const [kind, id] of echoIds(receipt)) {
    const key = JSON.stringify([String(botId), String(threadId), kind, String(id)]);
    entries.delete(key); // Refresh in expiration order for prune().
    entries.set(key, Date.now() + TTL);
  }
}
export function rememberOutboundReceipt(botId, threadId, receipt) {
  if (!receipt || typeof receipt !== 'object') return;
  rememberOutboundMessage(botId, threadId, receipt);
  for (const child of Object.values(receipt)) {
    if (child && typeof child === 'object') rememberOutboundReceipt(botId, threadId, child);
  }
}
export function isOutboundMessage(botId, message) {
  prune();
  return echoIds(message.data).some(([kind, id]) => {
    const expires = entries.get(JSON.stringify([String(botId), String(message.threadId), kind, String(id)]));
    return expires > Date.now();
  });
}
