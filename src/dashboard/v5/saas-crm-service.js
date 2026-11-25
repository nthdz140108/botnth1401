import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { classifyBotExpiry } from "../../commands/mybot/System/expiry-classifier.js";
import { readJsonFile, writeJsonAtomic } from "../../commands/mybot/System/json-state.js";
import { getSharedControlStore } from "./control-store.js";

const VOUCHER_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const DEFAULT_LIFECYCLE_POLICY = Object.freeze({
  autoRemind72h: true,
  autoRemind24h: true,
  autoRemind2h: true,
  autoStandbyOnExpiry: true,
  reminderTemplate:
    "Xin chào {ownerName}, bot {botName} ({botId}) sẽ hết hạn sau {hoursLeft} giờ ({expiryAt}). Vui lòng gia hạn bằng voucher hoặc liên hệ quản trị viên ({paymentBankName} {paymentAccountNo} {paymentAccountName}).",
  paymentBankName: "",
  paymentAccountNo: "",
  paymentAccountName: "",
});

const DURATION_PRESET_MS = Object.freeze({
  "+1h": 3_600_000,
  "+1d": 86_400_000,
  "+7d": 7 * 86_400_000,
  "+30d": 30 * 86_400_000,
  "+90d": 90 * 86_400_000,
  "+180d": 180 * 86_400_000,
  "+365d": 365 * 86_400_000,
});

function createCrmError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function nowIso() {
  return new Date().toISOString();
}

function randomCodeSuffix(length = 6) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += VOUCHER_CHARSET[bytes[i] % VOUCHER_CHARSET.length];
  }
  return out;
}

function resolveDurationPreset(presetInput) {
  const raw = String(presetInput ?? "+30d").trim();
  const lower = raw.toLowerCase();
  if (lower === "permanent" || lower === "-1") {
    return { normalizedPreset: "permanent", isPermanent: true, durationMs: null, codeTag: "PERM" };
  }
  if (DURATION_PRESET_MS[lower] !== undefined) {
    return {
      normalizedPreset: lower,
      isPermanent: false,
      durationMs: DURATION_PRESET_MS[lower],
      codeTag: lower.replace(/^\+/, "").toUpperCase(),
    };
  }
  const match = /^\+?(\d+)\s*([hdwmy])$/i.exec(raw);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    const unitMs =
      unit === "h"
        ? 3_600_000
        : unit === "d"
          ? 86_400_000
          : unit === "w"
            ? 7 * 86_400_000
            : unit === "m"
              ? 30 * 86_400_000
              : 365 * 86_400_000;
    if (amount > 0) {
      const normalizedPreset = `+${amount}${unit}`;
      return {
        normalizedPreset,
        isPermanent: false,
        durationMs: amount * unitMs,
        codeTag: `${amount}${unit.toUpperCase()}`,
      };
    }
  }
  throw createCrmError(
    400,
    "INVALID_DURATION_PRESET",
    `Gói thời hạn '${raw}' không hợp lệ (hỗ trợ +1h, +1d, +7d, +30d, +90d, permanent)`
  );
}

function parseFiniteExpiryMs(expiryAt) {
  if (expiryAt === null || expiryAt === undefined || expiryAt === "") return null;
  const str = String(expiryAt).trim();
  if (!str || str === "-1" || str.toLowerCase() === "permanent") return null;
  const ms = Date.parse(str);
  return Number.isNaN(ms) ? null : ms;
}

function formatReminderMessage(template, vars) {
  const base = String(template || DEFAULT_LIFECYCLE_POLICY.reminderTemplate);
  return base
    .replace(/\{ownerName\}/g, String(vars.ownerName || vars.ownerUid || "Quý khách"))
    .replace(/\{ownerUid\}/g, String(vars.ownerUid || ""))
    .replace(/\{botName\}/g, String(vars.botName || vars.botId || "Bot"))
    .replace(/\{botId\}/g, String(vars.botId || ""))
    .replace(/\{hoursLeft\}/g, String(vars.hoursLeft ?? 0))
    .replace(/\{expiryAt\}/g, String(vars.expiryAt || ""))
    .replace(/\{paymentBankName\}/g, String(vars.paymentBankName || ""))
    .replace(/\{paymentAccountNo\}/g, String(vars.paymentAccountNo || ""))
    .replace(/\{paymentAccountName\}/g, String(vars.paymentAccountName || ""))
    .replace(/\(\s*\)/g, "")
    .trim();
}

export class SaasCrmService {
  constructor({ root = process.cwd(), store = null, registry = null, auditStore = null } = {}) {
    this.root = path.resolve(root);
    this.store = store || getSharedControlStore(this.root);
    this.registry = registry || null;
    this.auditStore = auditStore || null;
    this.mybotsPath = path.join(this.root, "mybot", "mybots.json");
    this.botsDir = path.join(this.root, "mybot", "bots");
  }

  async #collectFleetBots() {
    const inventory = readJsonFile(this.mybotsPath, {});
    const registryMap = new Map();

    if (this.registry && typeof this.registry.list === "function") {
      try {
        const listed = await this.registry.list();
        for (const item of listed || []) {
          if (item && item.id) registryMap.set(item.id, item);
        }
      } catch {}
    }

    let diskBotIds = [];
    try {
      if (fs.existsSync(this.botsDir)) {
        diskBotIds = fs
          .readdirSync(this.botsDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !/credential/i.test(entry.name))
          .map((entry) => entry.name.replace(/\.json$/, ""));
      }
    } catch {}

    const allIds = new Set([
      ...Object.keys(inventory),
      ...diskBotIds,
      ...Array.from(registryMap.keys()).filter((id) => id !== "admin"),
    ]);

    const bots = [];
    for (const id of allIds) {
      if (id === "admin") continue;
      const inv = inventory[id] || {};
      const botFile = path.join(this.botsDir, `${id}.json`);
      const cfg = fs.existsSync(botFile) ? readJsonFile(botFile, {}) : {};
      const reg = registryMap.get(id) || {};
      if (reg.isPrimary) continue;

      const expiryAt = inv.expiryAt ?? cfg.expiryAt ?? reg.expiryAt ?? null;
      const trialStatus = inv.trialStatus || cfg.trialStatus || "pending";
      const ownerUid = String(inv.ownerUid || cfg.ownerUid || "").trim();
      const ownerName = String(inv.ownerName || cfg.ownerName || inv.ownerUsername || "").trim();
      const displayName = String(reg.displayName || inv.displayName || cfg.displayName || inv.name || id);
      const status = String(reg.status || inv.status || cfg.status || "stopped");

      bots.push({
        id,
        displayName,
        status,
        enabled: (inv.enabled ?? cfg.enabled ?? reg.enabled) !== false,
        expiryAt,
        trialStatus,
        ownerUid,
        ownerName,
        resellerId: inv.resellerId || cfg.resellerId || "",
      });
    }

    return bots;
  }

  async getSummary() {
    const now = Date.now();
    const bots = await this.#collectFleetBots();
    const storedCustomers = this.store.listCustomers();
    const vouchers = this.store.listVouchers();
    const allLedger = this.store.listLedger({ limit: 1000 });

    const customerMap = new Map();
    for (const cust of storedCustomers) {
      if (!cust?.ownerUid) continue;
      customerMap.set(cust.ownerUid, {
        ownerUid: cust.ownerUid,
        displayName: cust.displayName || cust.ownerUid,
        contactInfo: cust.contactInfo || "",
        tier: cust.tier || "standard",
        notes: cust.notes || "",
        maxBots: Number.isFinite(Number(cust.maxBots)) ? Number(cust.maxBots) : 5,
        totalSpentVnd: Number(cust.totalSpentVnd || 0) || 0,
        bots: [],
        updatedAt: cust.updatedAt || cust.createdAt || nowIso(),
      });
    }

    let activePaidBots = 0;
    let expiring24h = 0;
    let expiring72h = 0;
    let expiredBots = 0;
    const expiringSoon = [];

    for (const bot of bots) {
      const expiryState = classifyBotExpiry(bot, now);
      const expiryMs = parseFiniteExpiryMs(bot.expiryAt);
      let daysLeft = null;
      let hoursLeft = null;

      if (expiryState === "permanent") {
        if (bot.enabled) activePaidBots += 1;
        daysLeft = -1;
      } else if (expiryState === "active" && expiryMs !== null) {
        if (bot.enabled) activePaidBots += 1;
        hoursLeft = Math.max(0, Math.round(((expiryMs - now) / 3_600_000) * 10) / 10);
        daysLeft = Math.max(0, Math.ceil((expiryMs - now) / 86_400_000));
        if (hoursLeft <= 24) expiring24h += 1;
        if (hoursLeft <= 72) expiring72h += 1;
        if (hoursLeft <= 168) {
          expiringSoon.push({
            hoursLeft,
            ownerUid: bot.ownerUid || "",
            botId: bot.id,
            displayName: bot.displayName,
            expiryAt: bot.expiryAt,
          });
        }
      } else if (expiryState === "expired") {
        expiredBots += 1;
        daysLeft = 0;
      }

      if (bot.ownerUid) {
        if (!customerMap.has(bot.ownerUid)) {
          customerMap.set(bot.ownerUid, {
            ownerUid: bot.ownerUid,
            displayName: bot.ownerName || bot.ownerUid,
            contactInfo: "",
            tier: "standard",
            notes: "",
            maxBots: 5,
            totalSpentVnd: 0,
            bots: [],
            updatedAt: nowIso(),
          });
        }
        customerMap.get(bot.ownerUid).bots.push({
          id: bot.id,
          displayName: bot.displayName,
          status: expiryState === "expired" ? "expired" : bot.status,
          expiryAt: bot.expiryAt,
          daysLeft,
        });
      }
    }

    expiringSoon.sort((a, b) => a.hoursLeft - b.hoursLeft);

    const activeVouchers = vouchers.filter((v) => {
      if (v.status === "disabled" || v.status === "revoked") return false;
      if ((Number(v.usedCount) || 0) >= (Number(v.maxUses) || 1)) return false;
      const expMs = parseFiniteExpiryMs(v.expiresAt);
      if (expMs !== null && expMs <= now) return false;
      return true;
    }).length;

    const ledgerRedemptions = allLedger.filter((entry) => entry.type === "voucher_redeem");
    const voucherUsedSum = vouchers.reduce((acc, v) => acc + (Number(v.usedCount) || 0), 0);
    const totalRedemptions = Math.max(ledgerRedemptions.length, voucherUsedSum);

    const ledgerRevenue = allLedger.reduce((acc, entry) => acc + (Number(entry.amountVnd) || 0), 0);
    const customerSpentSum = Array.from(customerMap.values()).reduce(
      (acc, c) => acc + (Number(c.totalSpentVnd) || 0),
      0
    );
    const estimatedRevenueVnd = Math.max(ledgerRevenue, customerSpentSum);

    const customers = Array.from(customerMap.values()).sort((a, b) =>
      String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );

    return {
      kpis: {
        totalRentedBots: bots.length,
        activePaidBots,
        expiring24h,
        expiring72h,
        expiredBots,
        totalCustomers: customers.length,
        activeVouchers,
        totalRedemptions,
        estimatedRevenueVnd,
      },
      customers,
      expiringSoon,
      recentLedger: allLedger.slice(0, 50),
    };
  }

  upsertCustomer(ownerUid, payload = {}) {
    const isObjectFirst = ownerUid && typeof ownerUid === "object";
    const resolvedUid = String(isObjectFirst ? ownerUid.ownerUid : ownerUid || "").trim();
    const body = isObjectFirst ? ownerUid : payload || {};
    if (!resolvedUid) {
      throw createCrmError(400, "INVALID_OWNER_UID", "Mã định danh khách hàng (ownerUid) không hợp lệ");
    }

    const saved = this.store.upsertCustomer({
      ...body,
      ownerUid: resolvedUid,
    });
    this.auditStore
      ?.append?.({
        action: "crm.customer.upsert",
        ownerUid: resolvedUid,
        tier: saved.tier,
      })
      ?.catch?.(() => {});
    return saved;
  }

  deleteCustomer(ownerUid) {
    return this.store.deleteCustomer(ownerUid);
  }

  generateVoucherBatch({
    prefix = "MYBOT",
    count = 5,
    durationPreset = "+30d",
    priceVnd = 0,
    maxUses = 1,
    tier = "vip",
    note = "",
    expiresInDays = 90,
    actor = "admin",
  } = {}) {
    const cleanPrefix =
      String(prefix || "MYBOT")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 12) || "MYBOT";
    const batchCount = Math.max(1, Math.min(500, Number(count) || 1));
    const parsedDuration = resolveDurationPreset(durationPreset);
    const safePrice = Math.max(0, Number(priceVnd) || 0);
    const safeMaxUses = Math.max(1, Math.min(10_000, Number(maxUses) || 1));
    const expDays = Number(expiresInDays);
    const expiresAt =
      Number.isFinite(expDays) && expDays > 0
        ? new Date(Date.now() + expDays * 86_400_000).toISOString()
        : null;

    const vouchers = [];
    for (let i = 0; i < batchCount; i += 1) {
      let code = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = `${cleanPrefix}-${parsedDuration.codeTag}-${randomCodeSuffix(6)}`;
        if (!this.store.getVoucher(candidate)) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        code = `${cleanPrefix}-${parsedDuration.codeTag}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
      }

      const saved = this.store.upsertVoucher({
        code,
        prefix: cleanPrefix,
        durationPreset: parsedDuration.normalizedPreset,
        durationMs: parsedDuration.durationMs,
        priceVnd: safePrice,
        maxUses: safeMaxUses,
        usedCount: 0,
        tier: String(tier || "vip"),
        note: String(note || ""),
        status: "active",
        expiresAt,
        createdBy: String(actor || "admin"),
      });
      vouchers.push(saved);
    }

    this.auditStore
      ?.append?.({
        action: "crm.voucher.generate_batch",
        actor,
        count: vouchers.length,
        durationPreset: parsedDuration.normalizedPreset,
        priceVnd: safePrice,
      })
      ?.catch?.(() => {});

    return {
      created: vouchers.length,
      vouchers,
    };
  }

  listVouchers() {
    return this.store.listVouchers();
  }

  deleteVoucher(code) {
    return this.store.deleteVoucher(code);
  }

  async redeemVoucher({ code, botId, ownerUid = "", actor = "portal" } = {}) {
    const normalizedCode = String(code || "").trim().toUpperCase();
    if (!normalizedCode) {
      throw createCrmError(400, "MISSING_VOUCHER_CODE", "Vui lòng nhập mã voucher");
    }
    const cleanBotId = String(botId || "").trim();
    if (!cleanBotId || !/^[a-zA-Z0-9_-]+$/.test(cleanBotId)) {
      throw createCrmError(400, "INVALID_BOT_ID", "Mã bot cần gia hạn không hợp lệ");
    }

    const voucher = this.store.getVoucher(normalizedCode);
    if (!voucher) {
      throw createCrmError(404, "VOUCHER_NOT_FOUND", "Mã voucher không tồn tại");
    }
    if (voucher.status === "disabled" || voucher.status === "revoked") {
      throw createCrmError(400, "VOUCHER_DISABLED", "Mã voucher này đã bị vô hiệu hóa");
    }
    const voucherExpMs = parseFiniteExpiryMs(voucher.expiresAt);
    if (voucherExpMs !== null && voucherExpMs <= Date.now()) {
      throw createCrmError(400, "VOUCHER_EXPIRED", "Mã voucher đã hết hạn sử dụng");
    }
    const usedCount = Number(voucher.usedCount || 0);
    const maxUses = Math.max(1, Number(voucher.maxUses || 1));
    if (usedCount >= maxUses) {
      throw createCrmError(400, "VOUCHER_EXHAUSTED", "Mã voucher đã hết lượt sử dụng");
    }

    const mybots = readJsonFile(this.mybotsPath, {});
    const botFilePath = path.join(this.botsDir, `${cleanBotId}.json`);
    const hasBotFile = fs.existsSync(botFilePath);
    const botFileData = hasBotFile ? readJsonFile(botFilePath, {}) : {};

    if (!mybots[cleanBotId] && !hasBotFile) {
      throw createCrmError(404, "BOT_NOT_FOUND", `Không tìm thấy bot '${cleanBotId}' để gia hạn`);
    }

    const parsedDuration = resolveDurationPreset(voucher.durationPreset || "+30d");
    const previousExpiryAt = mybots[cleanBotId]?.expiryAt ?? botFileData?.expiryAt ?? null;
    const nowMs = Date.now();

    let nextExpiryAt;
    if (
      parsedDuration.isPermanent ||
      String(previousExpiryAt || "").trim() === "-1" ||
      String(previousExpiryAt || "").trim().toLowerCase() === "permanent"
    ) {
      nextExpiryAt = "-1";
    } else {
      const currentExpiryMs = parseFiniteExpiryMs(previousExpiryAt);
      const baseMs = currentExpiryMs !== null ? Math.max(nowMs, currentExpiryMs) : nowMs;
      nextExpiryAt = new Date(baseMs + parsedDuration.durationMs).toISOString();
    }

    const cleanOwnerUid = String(ownerUid || "").trim();
    const updatedIso = nowIso();

    // 1. Atomic update on mybot/mybots.json
    const prevInv = mybots[cleanBotId] || {
      name: cleanBotId,
      displayName: botFileData.displayName || cleanBotId,
      createdAt: botFileData.createdAt || updatedIso,
    };
    const nextInv = {
      ...prevInv,
      expiryAt: nextExpiryAt,
      trialStatus: "active",
      enabled: prevInv.disabledReason === "expired" ? true : prevInv.enabled !== false,
      lastUpdated: updatedIso,
    };
    if (nextInv.status === "expired" || nextInv.status === "trialExpired") {
      nextInv.status = "stopped";
    }
    if (nextInv.disabledReason === "expired") {
      delete nextInv.disabledReason;
      nextInv.disabledAt = null;
    }
    if (cleanOwnerUid) {
      nextInv.ownerUid = cleanOwnerUid;
    }
    mybots[cleanBotId] = nextInv;
    writeJsonAtomic(this.mybotsPath, mybots);

    // 2. Atomic update on mybot/bots/<botId>.json
    const nextBotFile = {
      id: cleanBotId,
      name: nextInv.name || cleanBotId,
      displayName: nextInv.displayName || cleanBotId,
      ...botFileData,
      expiryAt: nextExpiryAt,
      trialStatus: "active",
      updatedAt: updatedIso,
    };
    if (nextBotFile.status === "expired" || nextBotFile.status === "trialExpired") {
      nextBotFile.status = "stopped";
    }
    if (cleanOwnerUid) {
      nextBotFile.ownerUid = cleanOwnerUid;
    }
    writeJsonAtomic(botFilePath, nextBotFile);

    // 3. Update voucher usage, customer spend, ledger, notifications & audit
    const nextUsedCount = usedCount + 1;
    this.store.upsertVoucher({
      ...voucher,
      usedCount: nextUsedCount,
      status: nextUsedCount >= maxUses ? "exhausted" : "active",
      lastRedeemedAt: updatedIso,
      lastRedeemedBotId: cleanBotId,
      lastRedeemedBy: actor,
    });

    const effectiveOwnerUid = cleanOwnerUid || nextInv.ownerUid || nextBotFile.ownerUid || "";
    const priceVnd = Number(voucher.priceVnd || 0) || 0;
    if (effectiveOwnerUid) {
      const existingCustomer = this.store.getCustomer(effectiveOwnerUid);
      this.store.upsertCustomer({
        ...(existingCustomer || {}),
        ownerUid: effectiveOwnerUid,
        displayName: existingCustomer?.displayName || nextInv.ownerName || effectiveOwnerUid,
        tier: voucher.tier || existingCustomer?.tier || "vip",
        totalSpentVnd: (Number(existingCustomer?.totalSpentVnd) || 0) + priceVnd,
      });
    }

    this.store.appendLedger({
      type: "voucher_redeem",
      code: normalizedCode,
      botId: cleanBotId,
      ownerUid: effectiveOwnerUid,
      amountVnd: priceVnd,
      durationPreset: voucher.durationPreset,
      previousExpiryAt,
      nextExpiryAt,
      actor,
      note: voucher.note || "",
    });

    this.store.addNotification({
      level: "info",
      category: "crm",
      title: `Đã nạp voucher cho bot ${cleanBotId}`,
      message: `Mã ${normalizedCode} (${voucher.durationPreset}) được kích hoạt bởi ${actor}. Hạn mới: ${nextExpiryAt === "-1" ? "Vĩnh viễn" : nextExpiryAt}`,
      botId: cleanBotId,
      metadata: {
        code: normalizedCode,
        previousExpiryAt,
        nextExpiryAt,
        durationPreset: voucher.durationPreset,
        actor,
      },
    });

    if (this.auditStore && typeof this.auditStore.append === "function") {
      await this.auditStore.append({
        action: "crm.voucher.redeem",
        actor,
        botId: cleanBotId,
        code: normalizedCode,
        ownerUid: effectiveOwnerUid,
        previousExpiryAt,
        nextExpiryAt,
        durationPreset: voucher.durationPreset,
      });
    }

    return {
      redeemed: true,
      code: normalizedCode,
      botId: cleanBotId,
      previousExpiryAt,
      nextExpiryAt,
      durationPreset: voucher.durationPreset,
    };
  }

  getLifecyclePolicy() {
    const saved = this.store.getDoc("crm", "lifecycle_policy", null);
    return {
      ...DEFAULT_LIFECYCLE_POLICY,
      ...(saved && typeof saved === "object" ? saved : {}),
    };
  }

  updateLifecyclePolicy(patch = {}) {
    const current = this.getLifecyclePolicy();
    const next = {
      ...current,
      ...(patch.autoRemind72h !== undefined ? { autoRemind72h: Boolean(patch.autoRemind72h) } : {}),
      ...(patch.autoRemind24h !== undefined ? { autoRemind24h: Boolean(patch.autoRemind24h) } : {}),
      ...(patch.autoRemind2h !== undefined ? { autoRemind2h: Boolean(patch.autoRemind2h) } : {}),
      ...(patch.autoStandbyOnExpiry !== undefined
        ? { autoStandbyOnExpiry: Boolean(patch.autoStandbyOnExpiry) }
        : {}),
      ...(patch.reminderTemplate !== undefined
        ? { reminderTemplate: String(patch.reminderTemplate || "") }
        : {}),
      ...(patch.paymentBankName !== undefined
        ? { paymentBankName: String(patch.paymentBankName || "").trim() }
        : {}),
      ...(patch.paymentAccountNo !== undefined
        ? { paymentAccountNo: String(patch.paymentAccountNo || "").trim() }
        : {}),
      ...(patch.paymentAccountName !== undefined
        ? { paymentAccountName: String(patch.paymentAccountName || "").trim() }
        : {}),
    };
    this.store.setDoc("crm", "lifecycle_policy", next);
    return next;
  }

  async runExpirySweep({ onNotifyZalo, now = Date.now() } = {}) {
    const policy = this.getLifecyclePolicy();
    const bots = await this.#collectFleetBots();
    const reminded = [];
    const expiredHandled = [];
    let mybotsDirty = false;
    const mybots = readJsonFile(this.mybotsPath, {});

    for (const bot of bots) {
      const state = classifyBotExpiry(bot, now);

      if (state === "expired") {
        const markerKey = `${bot.id}:${bot.expiryAt}:expired`;
        if (!this.store.getDoc("crm_reminded", markerKey, null)) {
          const msg = `Bot ${bot.displayName} (${bot.id}) đã hết hạn thuê lúc ${bot.expiryAt}.`;
          this.store.setDoc("crm_reminded", markerKey, {
            botId: bot.id,
            stage: "expired",
            expiryAt: bot.expiryAt,
            remindedAt: new Date(now).toISOString(),
          });
          this.store.addNotification({
            level: "warn",
            category: "crm_expiry",
            title: `Bot ${bot.displayName} đã hết hạn`,
            message: msg,
            botId: bot.id,
            metadata: { stage: "expired", expiryAt: bot.expiryAt, ownerUid: bot.ownerUid || "" },
          });

          if (policy.autoStandbyOnExpiry && mybots[bot.id] && mybots[bot.id].status !== "expired") {
            mybots[bot.id] = {
              ...mybots[bot.id],
              status: "expired",
              lastUpdated: new Date(now).toISOString(),
            };
            mybotsDirty = true;
          }

          if (typeof onNotifyZalo === "function" && bot.ownerUid) {
            try {
              await onNotifyZalo({
                botId: bot.id,
                ownerUid: bot.ownerUid,
                stage: "expired",
                hoursLeft: 0,
                expiryAt: bot.expiryAt,
                message: msg,
              });
            } catch {}
          }

          expiredHandled.push({
            botId: bot.id,
            ownerUid: bot.ownerUid || "",
            expiryAt: bot.expiryAt,
          });
        }
        continue;
      }

      if (state !== "active") continue;
      const expiryMs = parseFiniteExpiryMs(bot.expiryAt);
      if (expiryMs === null) continue;

      const hoursLeft = Math.max(0, Math.round(((expiryMs - now) / 3_600_000) * 10) / 10);
      let stage = null;
      if (hoursLeft <= 2 && policy.autoRemind2h) {
        stage = "2h";
      } else if (hoursLeft <= 24 && policy.autoRemind24h) {
        stage = "24h";
      } else if (hoursLeft <= 72 && policy.autoRemind72h) {
        stage = "72h";
      }
      if (!stage) continue;

      const markerKey = `${bot.id}:${bot.expiryAt}:${stage}`;
      if (this.store.getDoc("crm_reminded", markerKey, null)) continue;

      const customer = bot.ownerUid ? this.store.getCustomer(bot.ownerUid) : null;
      const renderedMessage = formatReminderMessage(policy.reminderTemplate, {
        ownerName: customer?.displayName || bot.ownerName || bot.ownerUid || "Quý khách",
        ownerUid: bot.ownerUid,
        botName: bot.displayName,
        botId: bot.id,
        hoursLeft,
        expiryAt: bot.expiryAt,
        paymentBankName: policy.paymentBankName,
        paymentAccountNo: policy.paymentAccountNo,
        paymentAccountName: policy.paymentAccountName,
      });

      this.store.setDoc("crm_reminded", markerKey, {
        botId: bot.id,
        stage,
        hoursLeft,
        expiryAt: bot.expiryAt,
        remindedAt: new Date(now).toISOString(),
      });

      this.store.addNotification({
        level: stage === "2h" ? "warn" : "info",
        category: "crm_expiry",
        title: `Sắp hết hạn (${stage}): ${bot.displayName}`,
        message: renderedMessage,
        botId: bot.id,
        metadata: { stage, hoursLeft, expiryAt: bot.expiryAt, ownerUid: bot.ownerUid || "" },
      });

      if (typeof onNotifyZalo === "function" && bot.ownerUid) {
        try {
          await onNotifyZalo({
            botId: bot.id,
            ownerUid: bot.ownerUid,
            stage,
            hoursLeft,
            expiryAt: bot.expiryAt,
            message: renderedMessage,
          });
        } catch {}
      }

      reminded.push({
        botId: bot.id,
        ownerUid: bot.ownerUid || "",
        stage,
        hoursLeft,
        expiryAt: bot.expiryAt,
      });
    }

    if (mybotsDirty) {
      writeJsonAtomic(this.mybotsPath, mybots);
    }

    return {
      checked: bots.length,
      remindedCount: reminded.length,
      expiredCount: expiredHandled.length,
      reminded,
      expiredHandled,
    };
  }
}
