const REMOVE_ALIASES = new Set(["rm", "del"]);
const LIST_ALIASES = new Set(["ls"]);
const RESERVED_TOKENS = new Set([
  "admin", "list", "ls", "add", "remove", "rm", "del", "listadmin", "qtv", "box",
]);
const TIER_ROLES = Object.freeze({
  bot: "adminBot",
  box: "adminBox",
  high: "adminLevelHigh",
});

function resolveTargetTier(tokens, { defaultTier = "bot" } = {}) {
  const first = String(tokens[0] ?? "").toLowerCase();
  if (first === "box") return { tier: "box", restTokens: tokens.slice(1) };
  if (first === "qtv") return { tier: "high", restTokens: tokens.slice(1) };
  return { tier: defaultTier, restTokens: tokens };
}

export function parseAdminCommand(rawContent, prefix = "!", message = {}, scope = "group", canonicalCommand = "") {
  const isPrivate = scope === "private" || message?.type === 0;
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  const prefixStr = typeof prefix === "string" ? prefix : "!";
  const normalized = content.toLowerCase().startsWith(prefixStr.toLowerCase())
    ? content.slice(prefixStr.length).trim()
    : content;
  const parts = normalized.split(/\s+/).filter(Boolean);
  const rootVerb = parts[0]?.toLowerCase() || "";
  const canonical = String(canonicalCommand || "").trim().toLowerCase();

  let action = "guide";
  let tokensAfterAction = [];

  // NOTE: bare `!add` / `!remove` (root verb or canonicalCommand) are intentionally NOT
  // recognized as admin mutations — admin mutations must go through `!admin add/remove [box|qtv]`.
  const isStandaloneAddRemove =
    rootVerb === "add" || rootVerb === "remove" || canonical === "add" || canonical === "remove";

  if (!isStandaloneAddRemove) {
    if (rootVerb === "listadmin" || canonical === "listadmin") {
      action = "list";
    } else if (rootVerb === "admin" || canonical === "admin") {
      const sub = parts[1]?.toLowerCase();
      if (!sub) {
        action = "guide";
      } else if (sub === "list" || LIST_ALIASES.has(sub)) {
        action = "list";
      } else if (sub === "add" || sub === "remove" || REMOVE_ALIASES.has(sub)) {
        action = sub === "add" ? "add" : "remove";
        tokensAfterAction = parts.slice(2);
      } else {
        action = "unknown";
      }
    }
  }

  let targetTier = "bot";
  let targetTokens = [];
  if (action === "add" || action === "remove") {
    const resolved = resolveTargetTier(tokensAfterAction);
    targetTier = resolved.tier;
    targetTokens = resolved.restTokens;
  }

  const targets = [];
  const mentions = Array.isArray(message?.data?.mentions) ? message.data.mentions : [];
  const rawMessageContent = message?.data?.content || content;
  const isRelayed = Boolean(message?.data?.isRelayed);
  const relayedFrom = message?.data?.relayedFrom ? String(message.data.relayedFrom).trim() : "";

  for (const mention of mentions) {
    if (!mention?.uid) continue;
    const uid = String(mention.uid).trim();
    const name = typeof mention.pos === "number" && typeof mention.len === "number" && mention.pos >= 0 && (mention.pos + mention.len) <= rawMessageContent.length
      ? rawMessageContent.substring(mention.pos, mention.pos + mention.len).replace("@", "").trim() || uid
      : uid;
    targets.push({ uid, name });
  }

  const seen = new Set(targets.map((target) => target.uid));
  for (const token of targetTokens) {
    const rawUid = token.replace(/^@/, "").trim();
    if (!rawUid || RESERVED_TOKENS.has(rawUid.toLowerCase())) continue;
    if (/^\d+$/.test(rawUid)) {
      if (!seen.has(rawUid)) {
        targets.push({ uid: rawUid, name: rawUid });
        seen.add(rawUid);
      }
    } else if (isRelayed || token.startsWith("@")) {
      const isExplicitBotTag = ["@bot", "@admin", "bot", "admin", "@me", "me"].includes(token.toLowerCase());
      if (isExplicitBotTag && relayedFrom && !seen.has(relayedFrom)) {
        targets.push({ uid: relayedFrom, name: "Bot Admin" });
        seen.add(relayedFrom);
      }
    }
  }

  // If command is add/remove and there are no targets yet, but it's relayed and explicitly targets bot/admin
  if (targets.length === 0 && isRelayed && (rawContent.toLowerCase().includes("@bot") || rawContent.toLowerCase().includes("@admin"))) {
    const defaultAdminUid = relayedFrom;
    if (defaultAdminUid && !seen.has(defaultAdminUid)) {
      targets.push({ uid: defaultAdminUid, name: "Bot Admin" });
      seen.add(defaultAdminUid);
    }
  }

  return {
    action,
    targetTier,
    targetRole: TIER_ROLES[targetTier],
    targetType: targetTier === "box" ? "group" : "global",
    targets,
    rawVerb: rootVerb,
    subcommand: parts[1]?.toLowerCase(),
    isPrivate,
  };
}
