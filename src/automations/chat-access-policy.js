export function canProcessChat({
  chatScope,
  groupEnabled = true,
  privateEnabled = true,
  isGlobalAdmin = false,
  isBotAdmin = false,
  isGroupAdmin = false,
} = {}) {
  if (isGlobalAdmin) return true;
  if (chatScope === "private") return privateEnabled !== false;
  if (chatScope === "group") return groupEnabled !== false || isBotAdmin || isGroupAdmin;
  return false;
}

export function isGroupBotActive(groupSettings, threadId) {
  return groupSettings?.[threadId]?.activeBot === true;
}
