import crypto from "node:crypto";
import path from "node:path";
import QRCode from "qrcode";
import { getSharedControlStore } from "./control-store.js";

export const ROLE_PERMISSIONS = Object.freeze({
  super_admin: ["*"],
  operator: [
    "fleet:read",
    "fleet:action",
    "qr:manage",
    "groups:manage",
    "remote:execute",
    "campaigns:manage",
    "studio:manage",
    "logs:read",
    "operations:read",
  ],
  reseller: [
    "fleet:read",
    "fleet:create",
    "fleet:action",
    "qr:manage",
    "crm:voucher_redeem",
    "groups:manage",
    "logs:read",
  ],
  bot_owner: [
    "portal:self",
    "qr:manage",
    "groups:manage",
    "crm:voucher_redeem",
    "logs:read",
  ],
});

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function createIamError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function deriveEncryptionKey() {
  const secret = String(
    process.env.DASHBOARD_AUTH_SECRET ||
      process.env.DASHBOARD_ADMIN_PASSWORD ||
      "mybot-v5-iam-key"
  );
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function encryptSecret(plaintext) {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(payload) {
  if (!payload || typeof payload !== "string") return null;
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  try {
    const key = deriveEncryptionKey();
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(String(password), salt, 64);
  return {
    salt,
    passwordHash: derived.toString("hex"),
  };
}

function verifyPassword(password, salt, expectedHashHex) {
  if (!salt || !expectedHashHex || typeof password !== "string") return false;
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHashHex, "hex");
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function safeStringEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftDigest = crypto.createHash("sha256").update(left, "utf8").digest();
  const rightDigest = crypto.createHash("sha256").update(right, "utf8").digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest) && left.length === right.length;
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function encodeBase32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function decodeBase32(base32Secret) {
  const cleaned = String(base32Secret || "")
    .toUpperCase()
    .replace(/[\s=-]+/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw createIamError(400, "INVALID_TOTP_SECRET", "Khóa bí mật TOTP không đúng chuẩn Base32");
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(byteLength = 20) {
  return encodeBase32(crypto.randomBytes(byteLength));
}

export function computeTotpCode(base32Secret, timestampMs = Date.now()) {
  const key = decodeBase32(base32Secret);
  const counter = Math.floor(Number(timestampMs) / 30_000);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotpCode(base32Secret, code, window = 1, timestampMs = Date.now()) {
  const normalizedCode = String(code ?? "").replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(normalizedCode)) return false;
  const stepWindow = Math.max(0, Math.min(4, Number(window) || 0));
  for (let delta = -stepWindow; delta <= stepWindow; delta += 1) {
    const candidate = computeTotpCode(base32Secret, Number(timestampMs) + delta * 30_000);
    if (safeStringEqual(candidate, normalizedCode)) {
      return true;
    }
  }
  return false;
}

function generateRandomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ACCESS_CODE_ALPHABET[bytes[i] % ACCESS_CODE_ALPHABET.length];
  }
  return out;
}

function generateRecoveryCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    codes.push(`${generateRandomCode(4)}-${generateRandomCode(4)}`);
  }
  return codes;
}

function normalizeRecoveryInput(code) {
  return String(code || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function parseCookies(cookieHeader = "") {
  const out = {};
  for (const part of String(cookieHeader || "").split(";")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const val = part.slice(eqIndex + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function isTrustedLoopbackRequest(req) {
  const remote = String(req?.socket?.remoteAddress || req?.connection?.remoteAddress || "").trim();
  if (!remote) {
    // In-process synthetic/unit-test request object without TCP socket
    return true;
  }
  const isLoopback =
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1";
  if (!isLoopback) return false;

  if (process.env.DASHBOARD_TRUST_PROXY === "1") {
    const forwarded = String(req?.headers?.["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    if (
      forwarded &&
      forwarded !== "127.0.0.1" &&
      forwarded !== "::1" &&
      forwarded !== "::ffff:127.0.0.1"
    ) {
      return false;
    }
  }
  return true;
}

function normalizeAllowedBotIds(input, role) {
  if (role === "super_admin") return ["*"];
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    )
  );
}

export class IamService {
  constructor({ root = process.cwd(), store = null } = {}) {
    this.root = path.resolve(root);
    this.store = store || getSharedControlStore(this.root);
    this.sessionTtlMs = Math.max(
      60_000,
      Number(
        process.env.DASHBOARD_V5_SESSION_TTL_MS ||
          process.env.DASHBOARD_SESSION_TTL_MS ||
          12 * 60 * 60 * 1000
      ) || 12 * 60 * 60 * 1000
    );
  }

  generateTotpSecret(byteLength = 20) {
    return generateTotpSecret(byteLength);
  }

  computeTotpCode(base32Secret, timestampMs = Date.now()) {
    return computeTotpCode(base32Secret, timestampMs);
  }

  verifyTotpCode(base32Secret, code, window = 1, timestampMs = Date.now()) {
    return verifyTotpCode(base32Secret, code, window, timestampMs);
  }

  sanitizeUser(user) {
    if (!user || typeof user !== "object") return null;
    const {
      passwordHash: _passwordHash,
      salt: _salt,
      totpSecretEnc: _totpSecretEnc,
      totpPendingSecretEnc: _totpPendingSecretEnc,
      recoveryCodesHash,
      totpPendingRecoveryHashes: _totpPendingRecoveryHashes,
      accessCodeHash: _accessCodeHash,
      ...safe
    } = user;
    const role = ROLE_PERMISSIONS[safe.role] ? safe.role : "bot_owner";
    return {
      ...safe,
      role,
      permissions: [...(ROLE_PERMISSIONS[role] || [])],
      allowedBotIds: normalizeAllowedBotIds(safe.allowedBotIds, role),
      quotaMaxBots: Number.isFinite(Number(safe.quotaMaxBots)) ? Number(safe.quotaMaxBots) : 5,
      ownerUid: safe.ownerUid || "",
      totpEnabled: Boolean(safe.totpEnabled),
      recoveryCodesRemaining: Array.isArray(recoveryCodesHash) ? recoveryCodesHash.length : 0,
      disabled: Boolean(safe.disabled),
    };
  }

  #findRawUser(usernameOrId) {
    const key = String(usernameOrId || "").trim();
    if (!key) return null;
    return this.store.getUserById(key) || this.store.getUserByUsername(key);
  }

  listUsers() {
    return this.store.listUsers().map((u) => this.sanitizeUser(u));
  }

  createUser({
    username,
    password,
    role = "operator",
    displayName = "",
    allowedBotIds = [],
    quotaMaxBots = 5,
    ownerUid = "",
  } = {}) {
    const cleanUsername = String(username || "").trim();
    if (!cleanUsername || cleanUsername.length < 2 || cleanUsername.length > 64 || !/^[a-zA-Z0-9._@-]+$/.test(cleanUsername)) {
      throw createIamError(
        400,
        "INVALID_USERNAME",
        "Tên đăng nhập phải từ 2-64 ký tự và chỉ gồm chữ cái, số, dấu chấm, gạch dưới hoặc gạch ngang"
      );
    }
    if (!ROLE_PERMISSIONS[role]) {
      throw createIamError(400, "INVALID_ROLE", `Vai trò '${role}' không hợp lệ`);
    }
    if (this.store.getUserByUsername(cleanUsername)) {
      throw createIamError(409, "USER_EXISTS", `Tài khoản '${cleanUsername}' đã tồn tại`);
    }
    const rawPassword = String(password ?? "");
    if (rawPassword.length < 6) {
      throw createIamError(400, "WEAK_PASSWORD", "Mật khẩu phải có ít nhất 6 ký tự");
    }

    const { salt, passwordHash } = hashPassword(rawPassword);
    const saved = this.store.upsertUser({
      username: cleanUsername,
      displayName: String(displayName || cleanUsername).trim(),
      role,
      salt,
      passwordHash,
      allowedBotIds: normalizeAllowedBotIds(allowedBotIds, role),
      quotaMaxBots: Math.max(0, Number(quotaMaxBots ?? 5) || 0),
      ownerUid: String(ownerUid || "").trim(),
      totpEnabled: false,
      totpSecretEnc: null,
      recoveryCodesHash: [],
      disabled: false,
    });

    return this.sanitizeUser(saved);
  }

  updateUser(id, patch = {}) {
    const existing = this.#findRawUser(id);
    if (!existing) {
      throw createIamError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản người dùng");
    }

    const next = { ...existing };
    if (patch.role !== undefined) {
      if (!ROLE_PERMISSIONS[patch.role]) {
        throw createIamError(400, "INVALID_ROLE", `Vai trò '${patch.role}' không hợp lệ`);
      }
      next.role = patch.role;
    }
    if (patch.displayName !== undefined) {
      next.displayName = String(patch.displayName || "").trim() || existing.username;
    }
    if (patch.allowedBotIds !== undefined) {
      next.allowedBotIds = normalizeAllowedBotIds(patch.allowedBotIds, next.role);
    } else if (next.role === "super_admin") {
      next.allowedBotIds = ["*"];
    }
    if (patch.quotaMaxBots !== undefined) {
      next.quotaMaxBots = Math.max(0, Number(patch.quotaMaxBots) || 0);
    }
    if (patch.ownerUid !== undefined) {
      next.ownerUid = String(patch.ownerUid || "").trim();
    }
    if (patch.disabled !== undefined) {
      next.disabled = Boolean(patch.disabled);
      if (next.disabled) {
        this.store.deleteOtherSessions(existing.id, "");
      }
    }
    if (patch.password !== undefined && String(patch.password).length > 0) {
      if (String(patch.password).length < 6) {
        throw createIamError(400, "WEAK_PASSWORD", "Mật khẩu mới phải có ít nhất 6 ký tự");
      }
      const { salt, passwordHash } = hashPassword(String(patch.password));
      next.salt = salt;
      next.passwordHash = passwordHash;
    }

    const saved = this.store.upsertUser(next);
    return this.sanitizeUser(saved);
  }

  deleteUser(id) {
    const cleanId = String(id || "").trim();
    if (cleanId === "primary_admin") {
      throw createIamError(400, "CANNOT_DELETE_PRIMARY_ADMIN", "Không thể xóa tài khoản quản trị gốc");
    }
    const existing = this.#findRawUser(cleanId);
    if (!existing) {
      throw createIamError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản cần xóa");
    }
    const deleted = this.store.deleteUser(existing.id);
    return { deleted, id: existing.id };
  }

  #consumeRecoveryCode(user, rawCode) {
    const hashes = Array.isArray(user.recoveryCodesHash) ? user.recoveryCodesHash : [];
    if (hashes.length === 0) return false;
    const candidateHash = sha256Hex(`${user.id}:${normalizeRecoveryInput(rawCode)}`);
    const idx = hashes.findIndex((h) => safeStringEqual(h, candidateHash));
    if (idx === -1) return false;
    const nextHashes = hashes.filter((_, i) => i !== idx);
    this.store.upsertUser({ ...user, recoveryCodesHash: nextHashes });
    return true;
  }

  async setup2fa(usernameOrId) {
    let user = this.#findRawUser(usernameOrId);
    if (!user && String(usernameOrId) === "primary_admin") {
      const adminUsername = String(process.env.DASHBOARD_ADMIN_USERNAME || "admin").trim() || "admin";
      user = this.store.upsertUser({
        id: "primary_admin",
        username: adminUsername,
        displayName: "Primary Admin",
        role: "super_admin",
        allowedBotIds: ["*"],
        quotaMaxBots: 9999,
        totpEnabled: false,
        disabled: false,
      });
    }
    if (!user) {
      throw createIamError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản để thiết lập 2FA");
    }

    const secret = generateTotpSecret(20);
    const issuer = "MYBOT Control Plane";
    const label = encodeURIComponent(`MYBOT:${user.username}`);
    const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

    let qrDataUrl = "";
    try {
      qrDataUrl = await QRCode.toDataURL(otpauthUrl, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 240,
      });
    } catch {
      qrDataUrl = "";
    }

    const recoveryCodes = generateRecoveryCodes(8);
    const pendingRecoveryHashes = recoveryCodes.map((code) =>
      sha256Hex(`${user.id}:${normalizeRecoveryInput(code)}`)
    );

    this.store.upsertUser({
      ...user,
      totpPendingSecretEnc: encryptSecret(secret),
      totpPendingRecoveryHashes: pendingRecoveryHashes,
    });

    return {
      secret,
      otpauthUrl,
      qrDataUrl,
      recoveryCodes,
    };
  }

  enable2fa(usernameOrId, code) {
    const user = this.#findRawUser(usernameOrId);
    if (!user) {
      throw createIamError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản người dùng");
    }
    const pendingSecret = decryptSecret(user.totpPendingSecretEnc || user.totpSecretEnc);
    if (!pendingSecret) {
      throw createIamError(400, "TOTP_NOT_SETUP", "Chưa khởi tạo khóa 2FA cho tài khoản này");
    }
    if (!verifyTotpCode(pendingSecret, code, 1)) {
      throw createIamError(400, "INVALID_TOTP_CODE", "Mã xác thực 2FA không chính xác hoặc đã hết hạn");
    }

    const updated = this.store.upsertUser({
      ...user,
      totpEnabled: true,
      totpSecretEnc: user.totpPendingSecretEnc || user.totpSecretEnc,
      recoveryCodesHash: Array.isArray(user.totpPendingRecoveryHashes)
        ? user.totpPendingRecoveryHashes
        : user.recoveryCodesHash || [],
      totpPendingSecretEnc: null,
      totpPendingRecoveryHashes: null,
    });

    return {
      enabled: true,
      user: this.sanitizeUser(updated),
    };
  }

  disable2fa(usernameOrId, code) {
    const user = this.#findRawUser(usernameOrId);
    if (!user) {
      throw createIamError(404, "USER_NOT_FOUND", "Không tìm thấy tài khoản người dùng");
    }
    if (!user.totpEnabled) {
      return { enabled: false, user: this.sanitizeUser(user) };
    }

    const secret = decryptSecret(user.totpSecretEnc);
    const totpValid = secret ? verifyTotpCode(secret, code, 1) : false;
    const recoveryValid = !totpValid ? this.#consumeRecoveryCode(user, code) : false;

    if (!totpValid && !recoveryValid) {
      throw createIamError(400, "INVALID_TOTP_CODE", "Mã xác thực 2FA hoặc mã khôi phục không hợp lệ");
    }

    const refreshed = this.#findRawUser(user.id) || user;
    const updated = this.store.upsertUser({
      ...refreshed,
      totpEnabled: false,
      totpSecretEnc: null,
      totpPendingSecretEnc: null,
      totpPendingRecoveryHashes: null,
      recoveryCodesHash: [],
    });

    return {
      enabled: false,
      user: this.sanitizeUser(updated),
    };
  }

  createOwnerAccessToken({
    ownerUid,
    botIds = [],
    displayName = "",
    ttlHours = 168,
  } = {}) {
    const cleanOwnerUid = String(ownerUid || "").trim() || (Array.isArray(botIds) && botIds[0] ? `owner_${botIds[0]}` : "");
    if (!cleanOwnerUid) {
      throw createIamError(400, "INVALID_OWNER_UID", "Cần cung cấp ownerUid hoặc danh sách botIds để tạo mã truy cập");
    }

    const safeSlug = cleanOwnerUid.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
    const ownerUsername = `owner_${safeSlug}`;
    const existing =
      this.store.getUserByUsername(ownerUsername) ||
      this.store.listUsers().find((u) => u.role === "bot_owner" && u.ownerUid === cleanOwnerUid);

    const accessCode = `OWN-${generateRandomCode(4)}-${generateRandomCode(4)}`;
    const accessCodeHash = sha256Hex(accessCode.toUpperCase());
    const safeTtlHours = Math.max(1, Math.min(24 * 365, Number(ttlHours) || 168));
    const expiresAt = new Date(Date.now() + safeTtlHours * 3_600_000).toISOString();

    const mergedBots = Array.from(
      new Set([...(existing?.allowedBotIds || []), ...(Array.isArray(botIds) ? botIds : [])].map((b) => String(b || "").trim()).filter(Boolean))
    );

    const savedUser = this.store.upsertUser({
      ...(existing || {}),
      username: existing?.username || ownerUsername,
      displayName: String(displayName || existing?.displayName || `Chủ Bot ${cleanOwnerUid}`).trim(),
      role: "bot_owner",
      ownerUid: cleanOwnerUid,
      allowedBotIds: mergedBots,
      accessCodeHash,
      accessExpiresAt: expiresAt,
      disabled: false,
    });

    this.store.setDoc("iam_owner_tokens", accessCodeHash, {
      userId: savedUser.id,
      ownerUid: cleanOwnerUid,
      botIds: mergedBots,
      expiresAt,
      createdAt: new Date().toISOString(),
    });

    return {
      accessCode,
      user: this.sanitizeUser(savedUser),
      expiresAt,
    };
  }

  authenticate({
    username,
    password,
    totpCode,
    ownerAccessCode,
    ipAddress = "",
    userAgent = "",
  } = {}) {
    const now = new Date().toISOString();

    // Mode 1: Self-service Bot Owner Access Code login
    if (ownerAccessCode && String(ownerAccessCode).trim()) {
      const normalizedCode = String(ownerAccessCode).trim().toUpperCase();
      const codeHash = sha256Hex(normalizedCode);
      const tokenDoc = this.store.getDoc("iam_owner_tokens", codeHash, null);

      let user = tokenDoc?.userId ? this.store.getUserById(tokenDoc.userId) : null;
      if (!user) {
        user = this.store
          .listUsers()
          .find((u) => u.accessCodeHash && safeStringEqual(u.accessCodeHash, codeHash));
      }
      if (!user) {
        throw createIamError(401, "INVALID_ACCESS_CODE", "Mã truy cập Portal không hợp lệ");
      }
      if (user.disabled) {
        throw createIamError(403, "ACCOUNT_DISABLED", "Tài khoản này đã bị vô hiệu hóa");
      }
      const expIso = tokenDoc?.expiresAt || user.accessExpiresAt;
      if (expIso && Date.parse(expIso) <= Date.now()) {
        throw createIamError(401, "ACCESS_CODE_EXPIRED", "Mã truy cập Portal đã hết hạn");
      }

      const updatedUser = this.store.upsertUser({ ...user, lastLoginAt: now });
      const session = this.store.createSession({
        userId: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role,
        ipAddress: String(ipAddress || ""),
        userAgent: String(userAgent || ""),
        expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      });
      return { session, user: this.sanitizeUser(updatedUser) };
    }

    // Mode 2: Standard IAM Username + Password (+ optional 2FA)
    const cleanUsername = String(username || "").trim();
    const rawPassword = String(password ?? "");
    if (!cleanUsername || !rawPassword) {
      throw createIamError(400, "MISSING_CREDENTIALS", "Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu");
    }

    let user = this.store.getUserByUsername(cleanUsername);

    // Fallback check against Primary Admin env credentials if not stored as a regular password user
    if (!user || !user.passwordHash) {
      const envAdminUser = String(process.env.DASHBOARD_ADMIN_USERNAME || "").trim();
      const envAdminPass = String(process.env.DASHBOARD_ADMIN_PASSWORD || "").trim();
      if (
        envAdminUser &&
        envAdminPass &&
        safeStringEqual(cleanUsername, envAdminUser) &&
        safeStringEqual(rawPassword, envAdminPass)
      ) {
        user =
          user ||
          this.store.upsertUser({
            id: "primary_admin",
            username: envAdminUser,
            displayName: "Primary Admin",
            role: "super_admin",
            allowedBotIds: ["*"],
            quotaMaxBots: 9999,
            totpEnabled: false,
            disabled: false,
          });
      } else {
        throw createIamError(401, "INVALID_CREDENTIALS", "Tên đăng nhập hoặc mật khẩu không chính xác");
      }
    } else {
      if (user.disabled) {
        throw createIamError(403, "ACCOUNT_DISABLED", "Tài khoản này đã bị khóa");
      }
      if (!verifyPassword(rawPassword, user.salt, user.passwordHash)) {
        throw createIamError(401, "INVALID_CREDENTIALS", "Tên đăng nhập hoặc mật khẩu không chính xác");
      }
    }

    if (user.totpEnabled) {
      const suppliedTotp = String(totpCode ?? "").trim();
      if (!suppliedTotp) {
        throw createIamError(401, "TOTP_REQUIRED", "Tài khoản yêu cầu mã xác thực hai lớp (2FA)");
      }
      const secret = decryptSecret(user.totpSecretEnc);
      const validTotp = secret ? verifyTotpCode(secret, suppliedTotp, 1) : false;
      const validRecovery = !validTotp ? this.#consumeRecoveryCode(user, suppliedTotp) : false;
      if (!validTotp && !validRecovery) {
        throw createIamError(401, "INVALID_TOTP_CODE", "Mã xác thực 2FA không chính xác");
      }
      user = this.store.getUserById(user.id) || user;
    }

    const updatedUser = this.store.upsertUser({ ...user, lastLoginAt: now });
    const session = this.store.createSession({
      userId: updatedUser.id,
      username: updatedUser.username,
      role: updatedUser.role,
      ipAddress: String(ipAddress || ""),
      userAgent: String(userAgent || ""),
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
    });

    return {
      session,
      user: this.sanitizeUser(updatedUser),
    };
  }

  resolveRequestIdentity(req) {
    if (!req || typeof req !== "object") return null;
    if (req.v5Identity) return req.v5Identity;

    const headers = req.headers || {};

    // 1. Trusted loopback bridge headers (e.g., Rust V4 / local gateway proxy)
    const bridgeUsername = String(headers["x-v5-actor-username"] || "").trim();
    const bridgeRole = String(headers["x-v5-actor-role"] || "").trim();
    if ((bridgeUsername || bridgeRole) && isTrustedLoopbackRequest(req)) {
      const matchedUser = bridgeUsername ? this.store.getUserByUsername(bridgeUsername) : null;
      const role = ROLE_PERMISSIONS[bridgeRole]
        ? bridgeRole
        : matchedUser && ROLE_PERMISSIONS[matchedUser.role]
          ? matchedUser.role
          : "operator";
      const identity = {
        id: matchedUser?.id || `bridge_${bridgeUsername || role}`,
        username: bridgeUsername || matchedUser?.username || role,
        displayName: matchedUser?.displayName || bridgeUsername || role,
        role,
        permissions: [...(ROLE_PERMISSIONS[role] || [])],
        allowedBotIds: normalizeAllowedBotIds(matchedUser?.allowedBotIds, role),
        ownerUid: matchedUser?.ownerUid || "",
        quotaMaxBots: matchedUser?.quotaMaxBots ?? 5,
        authSource: "loopback_bridge",
      };
      req.v5Identity = identity;
      return identity;
    }

    // 2. V5 Session Cookie (`mybot_v5_session`) with CSRF validation
    const cookies = parseCookies(headers.cookie || "");
    const v5SessionId = String(cookies.mybot_v5_session || "").trim();
    if (v5SessionId) {
      const session = this.store.getSession(v5SessionId);
      if (session) {
        const user = this.store.getUserById(session.userId);
        if (user && !user.disabled) {
          const method = String(req.method || "GET").toUpperCase();
          if (MUTATING_METHODS.has(method)) {
            const csrfHeader = String(
              headers["x-v5-csrf-token"] || headers["x-csrf-token"] || ""
            ).trim();
            if (csrfHeader && safeStringEqual(csrfHeader, session.csrfToken)) {
              this.store.touchSession(session.sessionId);
              const role = ROLE_PERMISSIONS[user.role] ? user.role : "bot_owner";
              const identity = {
                id: user.id,
                username: user.username,
                displayName: user.displayName || user.username,
                role,
                permissions: [...(ROLE_PERMISSIONS[role] || [])],
                allowedBotIds: normalizeAllowedBotIds(user.allowedBotIds, role),
                ownerUid: user.ownerUid || "",
                quotaMaxBots: user.quotaMaxBots ?? 5,
                sessionId: session.sessionId,
                csrfToken: session.csrfToken,
                authSource: "v5_session",
              };
              req.v5Identity = identity;
              return identity;
            }
            // If primary admin session is not active on this request, enforce V5 CSRF error
            if (!req.dashboardSession) {
              throw createIamError(403, "CSRF_REQUIRED", "Thiếu hoặc sai mã bảo mật CSRF");
            }
          } else {
            this.store.touchSession(session.sessionId);
            const role = ROLE_PERMISSIONS[user.role] ? user.role : "bot_owner";
            const identity = {
              id: user.id,
              username: user.username,
              displayName: user.displayName || user.username,
              role,
              permissions: [...(ROLE_PERMISSIONS[role] || [])],
              allowedBotIds: normalizeAllowedBotIds(user.allowedBotIds, role),
              ownerUid: user.ownerUid || "",
              quotaMaxBots: user.quotaMaxBots ?? 5,
              sessionId: session.sessionId,
              csrfToken: session.csrfToken,
              authSource: "v5_session",
            };
            req.v5Identity = identity;
            return identity;
          }
        }
      }
    }

    // 3. Primary Admin session from `dashboard/server.js`
    if (req.dashboardSession) {
      const identity = {
        id: "primary_admin",
        username: req.dashboardSession.username || "admin",
        displayName: req.dashboardSession.username || "admin",
        role: "super_admin",
        permissions: ["*"],
        allowedBotIds: ["*"],
        ownerUid: "",
        quotaMaxBots: 9999,
        authSource: "dashboard_session",
      };
      req.v5Identity = identity;
      return identity;
    }

    return null;
  }

  canAccessBot(identity, bot) {
    if (!identity || typeof identity !== "object") return false;
    if (identity.role === "super_admin" || identity.role === "operator") return true;
    if (Array.isArray(identity.allowedBotIds) && identity.allowedBotIds.includes("*")) {
      return true;
    }

    const botId =
      typeof bot === "string"
        ? bot.trim()
        : String(bot?.id || bot?.botId || bot?.name || "").trim();
    if (botId && Array.isArray(identity.allowedBotIds) && identity.allowedBotIds.includes(botId)) {
      return true;
    }

    if (bot && typeof bot === "object") {
      const botOwnerUid = String(bot.ownerUid || bot.config?.ownerUid || "").trim();
      if (identity.ownerUid && botOwnerUid && String(identity.ownerUid) === botOwnerUid) {
        return true;
      }
      const resellerId = String(bot.resellerId || bot.config?.resellerId || "").trim();
      if (identity.id && resellerId && String(identity.id) === resellerId) {
        return true;
      }
    }

    return false;
  }

  hasPermission(identity, perm) {
    if (!identity || typeof identity !== "object") return false;
    if (!perm) return true;
    if (identity.role === "super_admin") return true;

    const perms = Array.isArray(identity.permissions)
      ? identity.permissions
      : ROLE_PERMISSIONS[identity.role] || [];
    if (perms.includes("*") || perms.includes(perm)) return true;

    return perms.some(
      (entry) =>
        typeof entry === "string" &&
        entry.endsWith(":*") &&
        String(perm).startsWith(entry.slice(0, -1))
    );
  }

  listSessions(identity) {
    if (identity === null) return [];
    const rawSessions =
      !identity || identity.role === "super_admin"
        ? this.store.listSessions()
        : this.store.listSessions(identity.id);

    return rawSessions.map(({ csrfToken: _csrf, ...safe }) => ({
      ...safe,
      isCurrent: Boolean(identity?.sessionId && safe.sessionId === identity.sessionId),
    }));
  }

  revokeSession(sessionId, identity) {
    const sid = String(sessionId || "").trim();
    if (!sid) {
      throw createIamError(400, "INVALID_SESSION_ID", "Mã phiên đăng nhập không hợp lệ");
    }
    const target = this.store.getSession(sid);
    if (!target) {
      return { revoked: false, sessionId: sid };
    }
    if (identity && identity.role !== "super_admin" && target.userId !== identity.id) {
      throw createIamError(
        403,
        "FORBIDDEN_SESSION_REVOKE",
        "Bạn không có quyền thu hồi phiên đăng nhập của người dùng khác"
      );
    }
    const deleted = this.store.deleteSession(sid);
    return { revoked: deleted, sessionId: sid };
  }
}
