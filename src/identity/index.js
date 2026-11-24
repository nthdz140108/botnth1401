export function normalizeIdentityMode(mode) {
  const val = String(mode || "").trim().toLowerCase();
  if (val === "enforce" || val === "shadow" || val === "off") {
    return val;
  }
  return "off";
}

export function getIdentityMode() {
  return "off";
}

export function isIdentityEnabled() {
  return false;
}

export function isIdentityEnforced() {
  return false;
}

export function getIdentityConfig(overrides = {}) {
  return {
    mode: "off",
    phoneHashKey: overrides.phoneHashKey || process.env.IDENTITY_PHONE_HASH_KEY || null,
  };
}

export async function isIdentityDbAvailable() {
  return false;
}

export function getIdentityPool() {
  return null;
}

export async function closeIdentityPool() {}

export {
  parseEnvFile,
  loadIdentityEnv,
  validateDatabaseName,
  maskSensitiveConfig,
} from "./identity-env.js";

export {
  IDENTITY_ERRORS,
  IdentityError,
  normalizeUsername,
  normalizePhone,
  hashPhoneNumber,
  redactSensitive,
  extractProfileFromUserInfo,
  extractIdentifiersFromProfile,
  extractUsernameFromUserInfo,
  extractUsername,
  resolveOrLinkIdentity,
  resolveUidForBot,
  resolveGlobalUser,
  hydrateBotIdentity,
} from "./identity-resolver.js";
