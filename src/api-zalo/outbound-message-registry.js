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
export function rememberOutboundMessage(botId, threadId, receipt = {}) {
  prune();
  for (const [kind, id] of [['client', receipt.clientId ?? receipt.cliMsgId], ['message', receipt.msgId]]) {
    if (id != null && String(id) !== '0') entries.set(JSON.stringify([String(botId), String(threadId), kind, String(id)]), Date.now() + TTL);
  }
}
export function isOutboundMessage(botId, message) {
  prune();
  return [['client', message.data?.cliMsgId ?? message.data?.clientId], ['message', message.data?.msgId]].some(([kind, id]) => {
    const expires = entries.get(JSON.stringify([String(botId), String(message.threadId), kind, String(id)]));
    return expires > Date.now();
  });
}
