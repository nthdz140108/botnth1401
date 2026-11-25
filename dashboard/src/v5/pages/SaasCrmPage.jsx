import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatDateVi, formatExpiryVi } from "../../v4/http.js";

function formatVnd(amount) {
  const n = Number(amount) || 0;
  return `${n.toLocaleString("vi-VN")} ₫`;
}

function parseRemainingHours(expiryAt) {
  if (!expiryAt || expiryAt === "Never" || expiryAt === "-1" || expiryAt === -1 || expiryAt === "permanent") {
    return Infinity;
  }
  const ts = typeof expiryAt === "object" && expiryAt.at ? Date.parse(expiryAt.at) : Date.parse(String(expiryAt));
  if (Number.isNaN(ts)) return Infinity;
  return (ts - Date.now()) / (3600 * 1000);
}

function downloadCsv(filename, headers, rows) {
  const escapeCell = (val) => `"${String(val ?? "").replace(/"/g, '""')}"`;
  const csvContent =
    "\uFEFF" +
    [headers.map(escapeCell).join(","), ...rows.map((r) => r.map(escapeCell).join(","))].join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SaasCrmPage() {
  const {
    enrichedFleet,
    crmSummary,
    refreshCrm,
    refreshAll,
    refreshV5,
    runBotAction,
    v5Fetch,
    notify,
  } = useV5();

  const [tab, setTab] = useState(() => {
    try {
      const saved = sessionStorage.getItem("mybot_v5_crm_tab");
      if (saved) {
        sessionStorage.removeItem("mybot_v5_crm_tab");
        return saved;
      }
    } catch {}
    return "customers";
  });

  const [customersMap, setCustomersMap] = useState({});
  const [vouchers, setVouchers] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [policy, setPolicy] = useState({
    autoRemind72h: true,
    autoRemind24h: true,
    autoRemind2h: true,
    autoStandbyOnExpiry: true,
    bankTransferTemplate:
      "🔔 Thông báo gia hạn Bot {botName}: Gói thuê của quý khách (UID {ownerUid}) sẽ hết hạn vào {expiryDate}. Vui lòng chuyển khoản {amountVnd} với nội dung MYBOT {botId} để gia hạn tự động.",
  });

  // Customer edit modal state
  const [editingOwner, setEditingOwner] = useState(null);
  const [ownerForm, setOwnerForm] = useState({ name: "", phone: "", tier: "VIP", notes: "" });
  const [savingOwner, setSavingOwner] = useState(false);

  // Generated owner portal magic access code modal
  const [generatedPortalToken, setGeneratedPortalToken] = useState(null);

  // Batch voucher generator state
  const [batchForm, setBatchForm] = useState({
    prefix: "MYBOT",
    count: 10,
    durationPreset: "+30d",
    priceVnd: 150000,
    maxUses: 1,
    tier: "VIP",
    note: "Lô mã gia hạn tháng",
  });
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [lastCreatedCodes, setLastCreatedCodes] = useState([]);

  // Instant redeem tester state
  const [redeemBotId, setRedeemBotId] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  // Policy & sweep state
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState(null);
  const [ledgerSearch, setLedgerSearch] = useState("");

  useEffect(() => {
    const onSwitchTab = (e) => {
      if (e.detail?.tab) setTab(e.detail.tab);
    };
    window.addEventListener("v5:crm-tab", onSwitchTab);
    return () => window.removeEventListener("v5:crm-tab", onSwitchTab);
  }, []);

  const loadCrmDetails = useCallback(async () => {
    const [sumRes, custRes, vouchRes, policyRes, ledgerRes] = await Promise.allSettled([
      refreshCrm(),
      v5Fetch("/api/v5/crm/customers"),
      v5Fetch("/api/v5/crm/vouchers"),
      v5Fetch("/api/v5/crm/policy"),
      v5Fetch("/api/v5/crm/ledger"),
    ]);

    const summaryObj = sumRes.status === "fulfilled" ? sumRes.value : null;

    if (custRes.status === "fulfilled" && custRes.value) {
      const raw = custRes.value.customers ?? custRes.value;
      if (Array.isArray(raw)) {
        const m = {};
        for (const c of raw) {
          if (c?.ownerUid) m[c.ownerUid] = c;
        }
        setCustomersMap(m);
      } else if (raw && typeof raw === "object") {
        setCustomersMap(raw);
      }
    } else if (summaryObj?.customers && typeof summaryObj.customers === "object") {
      setCustomersMap(summaryObj.customers);
    }

    if (vouchRes.status === "fulfilled" && vouchRes.value) {
      const list = Array.isArray(vouchRes.value)
        ? vouchRes.value
        : Array.isArray(vouchRes.value.vouchers)
          ? vouchRes.value.vouchers
          : [];
      setVouchers(list);
    } else if (Array.isArray(summaryObj?.vouchers)) {
      setVouchers(summaryObj.vouchers);
    }

    if (policyRes.status === "fulfilled" && policyRes.value) {
      const pol = policyRes.value.policy || policyRes.value;
      if (pol && typeof pol === "object") {
        setPolicy((prev) => ({ ...prev, ...pol }));
      }
    } else if (summaryObj?.policy && typeof summaryObj.policy === "object") {
      setPolicy((prev) => ({ ...prev, ...summaryObj.policy }));
    }

    if (ledgerRes.status === "fulfilled" && ledgerRes.value) {
      const list = Array.isArray(ledgerRes.value)
        ? ledgerRes.value
        : Array.isArray(ledgerRes.value.entries)
          ? ledgerRes.value.entries
          : Array.isArray(ledgerRes.value.ledger)
            ? ledgerRes.value.ledger
            : [];
      setLedger(list);
    } else if (Array.isArray(summaryObj?.ledger)) {
      setLedger(summaryObj.ledger);
    }
  }, [refreshCrm, v5Fetch]);

  useEffect(() => {
    loadCrmDetails();
  }, [loadCrmDetails]);

  useEffect(() => {
    if (!redeemBotId && enrichedFleet.length > 0) {
      const nonAdmin = enrichedFleet.find((b) => !b.isPrimaryAdmin) || enrichedFleet[0];
      if (nonAdmin) setRedeemBotId(nonAdmin.id);
    }
  }, [redeemBotId, enrichedFleet]);

  // Group bots by ownerUid for Customer 360°
  const customerGroups = useMemo(() => {
    const groups = new Map();
    for (const bot of enrichedFleet) {
      if (bot.isPrimaryAdmin && !bot.ownerUid) continue;
      const ownerKey = bot.ownerUid || `unassigned_${bot.id}`;
      if (!groups.has(ownerKey)) {
        const meta = customersMap[ownerKey] || {};
        groups.set(ownerKey, {
          ownerUid: ownerKey,
          isUnassigned: !bot.ownerUid,
          name: meta.name || meta.displayName || (bot.ownerUid ? `Khách thuê ${bot.ownerUid}` : "Chưa gán Owner UID"),
          phone: meta.phone || "",
          tier: meta.tier || (bot.tags?.includes("VIP") ? "VIP" : "Standard"),
          notes: meta.notes || "",
          bots: [],
        });
      }
      groups.get(ownerKey).bots.push(bot);
    }
    return [...groups.values()];
  }, [enrichedFleet, customersMap]);

  const expiringBots = useMemo(() => {
    return enrichedFleet
      .filter((b) => !b.isPrimaryAdmin && parseRemainingHours(b.expiryAt) <= 72)
      .sort((a, b) => parseRemainingHours(a.expiryAt) - parseRemainingHours(b.expiryAt));
  }, [enrichedFleet]);

  const kpis = useMemo(() => {
    const rentedBots = enrichedFleet.filter((b) => !b.isPrimaryAdmin).length;
    const expiringCount = Number(crmSummary?.expiringWithin72h ?? expiringBots.length);

    let availableVouchers = 0;
    let redeemedVouchers = 0;
    let calcRevenue = 0;

    for (const v of vouchers) {
      const used = Number(v.usedCount || 0);
      const max = Number(v.maxUses || 1);
      if (used >= max || v.status === "exhausted" || v.redeemed) {
        redeemedVouchers += 1;
      } else {
        availableVouchers += 1;
      }
      calcRevenue += used * Number(v.priceVnd || 0);
    }

    for (const entry of ledger) {
      if (entry.amountVnd && !entry.voucherCode) {
        calcRevenue += Number(entry.amountVnd || 0);
      }
    }

    return {
      rentedBots: Number(crmSummary?.totalRentedBots ?? rentedBots),
      expiringCount,
      availableVouchers: Number(crmSummary?.availableVouchers ?? availableVouchers),
      redeemedVouchers: Number(crmSummary?.redeemedVouchers ?? redeemedVouchers),
      estimatedRevenueVnd: Number(crmSummary?.estimatedRevenueVnd ?? calcRevenue),
    };
  }, [enrichedFleet, crmSummary, expiringBots.length, vouchers, ledger]);

  const handleExtendBot = async (bot, preset) => {
    try {
      await v5Fetch(`/api/v5/crm/bots/${encodeURIComponent(bot.id)}/extend`, {
        method: "POST",
        body: { preset, ownerUid: bot.ownerUid || undefined },
      }).catch(() =>
        v5Fetch(`/api/bots/${encodeURIComponent(bot.id)}/expiry`, {
          method: "PUT",
          body: { preset, ownerUid: bot.ownerUid || undefined },
        })
      );
      notify(
        `Đã gia hạn ${preset === "permanent" ? "Vĩnh viễn" : preset} cho "${bot.displayName}"!`,
        "success"
      );
      await Promise.all([refreshAll(), refreshV5(), loadCrmDetails()]);
    } catch (err) {
      notify(err.message || "Gia hạn Bot thất bại", "error");
    }
  };

  const openCustomerEditor = (cust) => {
    setEditingOwner(cust.ownerUid);
    setOwnerForm({
      name: cust.name || "",
      phone: cust.phone || "",
      tier: cust.tier || "VIP",
      notes: cust.notes || "",
    });
  };

  const handleSaveCustomer = async (e) => {
    e.preventDefault();
    if (!editingOwner) return;
    setSavingOwner(true);
    try {
      await v5Fetch(`/api/v5/crm/customers/${encodeURIComponent(editingOwner)}`, {
        method: "PUT",
        body: ownerForm,
      });
      setCustomersMap((prev) => ({
        ...prev,
        [editingOwner]: { ...(prev[editingOwner] || {}), ownerUid: editingOwner, ...ownerForm },
      }));
      notify("Đã lưu hồ sơ Chủ Thuê thành công!", "success");
      setEditingOwner(null);
      loadCrmDetails();
    } catch (err) {
      notify(err.message || "Lưu hồ sơ khách thuê thất bại", "error");
    } finally {
      setSavingOwner(false);
    }
  };

  const handleIssueOwnerPortalToken = async (cust) => {
    try {
      const botIds = cust.bots.map((b) => b.id);
      const res = await v5Fetch("/api/v5/iam/owner-token", {
        method: "POST",
        body: {
          ownerUid: cust.ownerUid,
          customerName: cust.name,
          allowedBotIds: botIds,
        },
      });
      const code = res?.ownerAccessCode || res?.token || res?.accessCode || "";
      setGeneratedPortalToken({
        ownerUid: cust.ownerUid,
        customerName: cust.name,
        code,
        expiresAt: res?.expiresAt || null,
        botCount: botIds.length,
      });
      if (code) {
        navigator.clipboard?.writeText(code).catch(() => {});
        notify("Đã tạo và sao chép Mã Truy Cập Cổng Khách Thuê!", "success");
      }
    } catch (err) {
      notify(err.message || "Không thể tạo mã truy cập cổng khách thuê", "error");
    }
  };

  const handleCreateVoucherBatch = async (e) => {
    e.preventDefault();
    setCreatingBatch(true);
    try {
      const res = await v5Fetch("/api/v5/crm/vouchers/batch", {
        method: "POST",
        body: {
          prefix: batchForm.prefix.trim() || "MYBOT",
          count: Math.max(1, Math.min(200, Number(batchForm.count) || 10)),
          durationPreset: batchForm.durationPreset,
          priceVnd: Math.max(0, Number(batchForm.priceVnd) || 0),
          maxUses: Math.max(1, Number(batchForm.maxUses) || 1),
          tier: batchForm.tier,
          note: batchForm.note.trim(),
        },
      });
      const created = Array.isArray(res?.vouchers)
        ? res.vouchers
        : Array.isArray(res?.codes)
          ? res.codes.map((c) => (typeof c === "string" ? { code: c } : c))
          : [];
      setLastCreatedCodes(created.map((item) => item.code || String(item)));
      notify(`Đã phát hành lô ${created.length || batchForm.count} mã Giftcode thành công!`, "success");
      await loadCrmDetails();
    } catch (err) {
      notify(err.message || "Tạo lô Giftcode thất bại", "error");
    } finally {
      setCreatingBatch(false);
    }
  };

  const handleRedeemVoucher = async (e) => {
    e.preventDefault();
    if (!redeemBotId || !redeemCode.trim()) {
      notify("Vui lòng chọn Bot và nhập mã Giftcode cần nạp.", "error");
      return;
    }
    setRedeeming(true);
    try {
      const res = await v5Fetch("/api/v5/crm/vouchers/redeem", {
        method: "POST",
        body: {
          botId: redeemBotId,
          code: redeemCode.trim(),
        },
      });
      notify(res?.message || `Đã nạp mã "${redeemCode.trim()}" thành công cho Bot ${redeemBotId}!`, "success");
      setRedeemCode("");
      await Promise.all([refreshAll(), refreshV5(), loadCrmDetails()]);
    } catch (err) {
      notify(err.message || "Nạp mã Giftcode thất bại", "error");
    } finally {
      setRedeeming(false);
    }
  };

  const handleDeleteVoucher = async (codeOrId) => {
    try {
      await v5Fetch(`/api/v5/crm/vouchers/${encodeURIComponent(codeOrId)}`, {
        method: "DELETE",
      });
      setVouchers((prev) => prev.filter((v) => (v.id || v.code) !== codeOrId && v.code !== codeOrId));
      notify(`Đã thu hồi mã Giftcode "${codeOrId}".`, "info");
    } catch (err) {
      notify(err.message || "Xóa mã Giftcode thất bại", "error");
    }
  };

  const handleSavePolicy = async (e) => {
    e.preventDefault();
    setSavingPolicy(true);
    try {
      await v5Fetch("/api/v5/crm/policy", {
        method: "PUT",
        body: policy,
      });
      notify("Đã lưu Chính Sách Nhắc Hạn & Thu Hồi Tự Động!", "success");
    } catch (err) {
      notify(err.message || "Lưu chính sách thất bại", "error");
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleRunSweep = async () => {
    setSweeping(true);
    try {
      const res = await v5Fetch("/api/v5/crm/sweep", {
        method: "POST",
        body: {},
      });
      setSweepResult(res);
      notify(res?.message || "Đã quét hạn thuê & gửi nhắc tự động hoàn tất!", "success");
      await Promise.all([refreshAll(), refreshV5(), loadCrmDetails()]);
    } catch (err) {
      notify(err.message || "Quét hạn thuê thất bại", "error");
    } finally {
      setSweeping(false);
    }
  };

  const filteredLedger = useMemo(() => {
    const q = ledgerSearch.trim().toLowerCase();
    if (!q) return ledger;
    return ledger.filter(
      (item) =>
        String(item.botId || "").toLowerCase().includes(q) ||
        String(item.ownerUid || "").toLowerCase().includes(q) ||
        String(item.voucherCode || item.code || "").toLowerCase().includes(q) ||
        String(item.type || item.action || "").toLowerCase().includes(q)
    );
  }, [ledger, ledgerSearch]);

  return (
    <div className="v5-stack">
      {/* 4 Business KPIs */}
      <div className="v4-grid-4">
        <div className="v4-card v4-stat-card">
          <div className="v4-muted">Tổng Bot Đang Cho Thuê</div>
          <div className="v4-kpi-value v5-tabular" style={{ color: "var(--primary)" }}>
            {kpis.rentedBots} <span style={{ fontSize: 14, color: "var(--text-muted)" }}>Bot thuê bao</span>
          </div>
          <div className="v4-muted v4-stat-sub">{customerGroups.length} đầu mối chủ thuê hoạt động</div>
        </div>

        <div className="v4-card v4-stat-card" style={{ cursor: "pointer" }} onClick={() => setTab("expiring")}>
          <div className="v4-muted">Sắp Hết Hạn (72 Giờ Tới)</div>
          <div
            className="v4-kpi-value v5-tabular"
            style={{ color: kpis.expiringCount > 0 ? "var(--warning)" : "var(--success)" }}
          >
            {kpis.expiringCount} <span style={{ fontSize: 14, color: "var(--text-muted)" }}>cần gia hạn</span>
          </div>
          <div className="v4-muted v4-stat-sub">Tự động nhắc 72h / 24h / 2h</div>
        </div>

        <div className="v4-card v4-stat-card" style={{ cursor: "pointer" }} onClick={() => setTab("vouchers")}>
          <div className="v4-muted">Mã Giftcode Khả Dụng / Đã Nạp</div>
          <div className="v4-kpi-value v5-tabular">
            <span style={{ color: "var(--success)" }}>{kpis.availableVouchers}</span>{" "}
            <span style={{ fontSize: 15, color: "var(--text-muted)" }}>/ {kpis.redeemedVouchers} đã nạp</span>
          </div>
          <div className="v4-muted v4-stat-sub">Hỗ trợ tạo lô hàng loạt & xuất CSV</div>
        </div>

        <div className="v4-card v4-stat-card" style={{ cursor: "pointer" }} onClick={() => setTab("ledger")}>
          <div className="v4-muted">Doanh Thu Ước Tính (VNĐ)</div>
          <div className="v4-kpi-value v5-tabular" style={{ color: "var(--success)" }}>
            {formatVnd(kpis.estimatedRevenueVnd)}
          </div>
          <div className="v4-muted v4-stat-sub">Đối soát sổ cái giao dịch tự động</div>
        </div>
      </div>

      {/* Main CRM Tabs Container */}
      <div className="v4-card">
        <div className="v4-tabs">
          <button
            type="button"
            className={`v4-tab ${tab === "customers" ? "active" : ""}`}
            onClick={() => setTab("customers")}
          >
            👥 Danh Bạ Chủ Thuê (Customer 360°)
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "vouchers" ? "active" : ""}`}
            onClick={() => setTab("vouchers")}
          >
            🎟️ Kho Giftcode & Mã Kích Hoạt ({vouchers.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "expiring" ? "active" : ""}`}
            onClick={() => setTab("expiring")}
          >
            ⏰ Hàng Đợi Sắp Hết Hạn & Nhắc Tự Động ({expiringBots.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "ledger" ? "active" : ""}`}
            onClick={() => setTab("ledger")}
          >
            📒 Sổ Cái Giao Dịch (Subscription Ledger)
          </button>
        </div>

        {/* SUB-TAB 1: CUSTOMER 360 */}
        {tab === "customers" && (
          <div className="v5-stack">
            {customerGroups.length === 0 ? (
              <div style={{ textAlign: "center", padding: 36 }} className="v4-muted">
                Chưa có Bot khách thuê nào. Khi tạo Bot phụ bằng QR và gán <code>ownerUid</code>, hồ sơ khách hàng 360° sẽ tự động tổng hợp tại đây.
              </div>
            ) : (
              customerGroups.map((cust) => (
                <div key={cust.ownerUid} className="v4-card" style={{ background: "var(--v5-surface-2)" }}>
                  <div className="v5-row-between" style={{ marginBottom: 12 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <h3 style={{ margin: 0, fontSize: 16 }}>{cust.name}</h3>
                        <span className="v5-tag vip">{cust.tier}</span>
                        <span className="v4-badge neutral v4-mono">UID: {cust.ownerUid}</span>
                        {cust.phone && <span className="v4-badge info">📞 {cust.phone}</span>}
                      </div>
                      {cust.notes && (
                        <div className="v4-muted" style={{ marginTop: 4 }}>
                          📝 {cust.notes}
                        </div>
                      )}
                    </div>

                    <div className="v5-inline-actions">
                      <button
                        type="button"
                        className="v4-btn sm"
                        onClick={() => openCustomerEditor(cust)}
                      >
                        ✏️ Sửa Hồ Sơ Khách
                      </button>
                      <button
                        type="button"
                        className="v4-btn sm primary"
                        onClick={() => handleIssueOwnerPortalToken(cust)}
                      >
                        🔑 Tạo Mã Truy Cập Cổng Khách Thuê
                      </button>
                    </div>
                  </div>

                  <div className="v4-table-wrap">
                    <table className="v4-table">
                      <thead>
                        <tr>
                          <th>Bot Đang Thuê</th>
                          <th>Trạng Thái</th>
                          <th>Hạn Sử Dụng</th>
                          <th style={{ textAlign: "right" }}>Gia Hạn Nhanh 1-Click</th>
                        </tr>
                      </thead>
                      <tbody>
                        {cust.bots.map((bot) => (
                          <tr key={bot.id}>
                            <td>
                              <strong>{bot.displayName}</strong>{" "}
                              <span className="v4-muted v4-mono">({bot.id})</span>
                            </td>
                            <td>
                              <span className={`v4-badge ${bot.wsConnected ? "success" : bot.cookieDead ? "danger" : "neutral"}`}>
                                {bot.status}
                              </span>
                            </td>
                            <td>
                              <strong>{formatExpiryVi(bot.expiryAt)}</strong>
                            </td>
                            <td>
                              <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  className="v4-btn sm"
                                  onClick={() => handleExtendBot(bot, "+7d")}
                                >
                                  +7 ngày
                                </button>
                                <button
                                  type="button"
                                  className="v4-btn sm success"
                                  onClick={() => handleExtendBot(bot, "+30d")}
                                >
                                  +30 ngày
                                </button>
                                <button
                                  type="button"
                                  className="v4-btn sm primary"
                                  onClick={() => handleExtendBot(bot, "permanent")}
                                >
                                  ♾ Vĩnh viễn
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* SUB-TAB 2: GIFTCODE & VOUCHER WAREHOUSE */}
        {tab === "vouchers" && (
          <div className="v5-stack">
            <div className="v4-grid-2">
              {/* Batch Generator Form */}
              <div className="v4-card" style={{ background: "var(--v5-surface-2)" }}>
                <div className="v4-card-header">
                  <div>
                    <h3>🎟️ Phát Hành Lô Giftcode Gia Hạn</h3>
                    <div className="v4-muted">Sinh mã hàng loạt kèm mệnh giá để gửi cho khách hoặc đại lý</div>
                  </div>
                </div>

                <form onSubmit={handleCreateVoucherBatch}>
                  <div className="v4-grid-2">
                    <div className="v4-field">
                      <label>Tiền tố mã (Prefix)</label>
                      <input
                        className="v4-input v4-mono"
                        value={batchForm.prefix}
                        onChange={(e) => setBatchForm((p) => ({ ...p, prefix: e.target.value.toUpperCase() }))}
                      />
                    </div>
                    <div className="v4-field">
                      <label>Số lượng mã cần tạo</label>
                      <input
                        type="number"
                        min={1}
                        max={200}
                        className="v4-input v4-mono"
                        value={batchForm.count}
                        onChange={(e) => setBatchForm((p) => ({ ...p, count: e.target.value }))}
                      />
                    </div>
                    <div className="v4-field">
                      <label>Thời hạn cộng thêm</label>
                      <select
                        className="v4-select"
                        value={batchForm.durationPreset}
                        onChange={(e) => setBatchForm((p) => ({ ...p, durationPreset: e.target.value }))}
                      >
                        <option value="+7d">+7 Ngày (Gói Tuần)</option>
                        <option value="+15d">+15 Ngày</option>
                        <option value="+30d">+30 Ngày (Gói Tháng)</option>
                        <option value="+90d">+90 Ngày (Gói Quý)</option>
                        <option value="+365d">+365 Ngày (Gói Năm)</option>
                        <option value="permanent">Vĩnh viễn</option>
                      </select>
                    </div>
                    <div className="v4-field">
                      <label>Đơn giá ước tính (VNĐ)</label>
                      <input
                        type="number"
                        min={0}
                        step={1000}
                        className="v4-input v4-mono"
                        value={batchForm.priceVnd}
                        onChange={(e) => setBatchForm((p) => ({ ...p, priceVnd: e.target.value }))}
                      />
                    </div>
                    <div className="v4-field">
                      <label>Số lượt nạp tối đa / mã</label>
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        className="v4-input v4-mono"
                        value={batchForm.maxUses}
                        onChange={(e) => setBatchForm((p) => ({ ...p, maxUses: e.target.value }))}
                      />
                    </div>
                    <div className="v4-field">
                      <label>Hạng gói (Tier)</label>
                      <select
                        className="v4-select"
                        value={batchForm.tier}
                        onChange={(e) => setBatchForm((p) => ({ ...p, tier: e.target.value }))}
                      >
                        <option value="VIP">VIP</option>
                        <option value="Standard">Tiêu chuẩn (Standard)</option>
                        <option value="Reseller">Đại lý (Reseller)</option>
                      </select>
                    </div>
                  </div>
                  <div className="v4-field">
                    <label>Ghi chú lô phát hành</label>
                    <input
                      className="v4-input"
                      value={batchForm.note}
                      onChange={(e) => setBatchForm((p) => ({ ...p, note: e.target.value }))}
                      placeholder="VD: Lô khuyến mãi đại lý tháng 11..."
                    />
                  </div>
                  <button type="submit" className="v4-btn success" disabled={creatingBatch}>
                    {creatingBatch ? "Đang sinh mã..." : "⚡ Tạo Lô Giftcode Ngay"}
                  </button>
                </form>

                {lastCreatedCodes.length > 0 && (
                  <div className="v4-card" style={{ marginTop: 12, padding: 12 }}>
                    <div className="v5-row-between" style={{ marginBottom: 6 }}>
                      <strong>Vừa tạo {lastCreatedCodes.length} mã mới:</strong>
                      <button
                        type="button"
                        className="v4-btn sm primary"
                        onClick={() => {
                          navigator.clipboard?.writeText(lastCreatedCodes.join("\n")).catch(() => {});
                          notify("Đã sao chép toàn bộ lô mã vừa tạo!", "success");
                        }}
                      >
                        📋 Copy Tất Cả Mã Mới
                      </button>
                    </div>
                    <div className="v4-mono v4-muted" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
                      {lastCreatedCodes.join(", ")}
                    </div>
                  </div>
                )}
              </div>

              {/* Instant Redeem Tester */}
              <div className="v4-card" style={{ background: "var(--v5-surface-2)" }}>
                <div className="v4-card-header">
                  <div>
                    <h3>⚡ Nạp Thử / Kích Hoạt Mã Tức Thì</h3>
                    <div className="v4-muted">Áp dụng trực tiếp mã Giftcode cho bất kỳ Bot nào trong đội hình</div>
                  </div>
                </div>

                <form onSubmit={handleRedeemVoucher}>
                  <div className="v4-field">
                    <label>Chọn Bot nhận gia hạn</label>
                    <select
                      className="v4-select"
                      value={redeemBotId}
                      onChange={(e) => setRedeemBotId(e.target.value)}
                    >
                      {enrichedFleet.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.displayName} ({b.id} • Hạn: {formatExpiryVi(b.expiryAt)})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="v4-field">
                    <label>Nhập mã Giftcode</label>
                    <input
                      className="v4-input v4-mono"
                      placeholder="MYBOT-XXXX-XXXX"
                      value={redeemCode}
                      onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
                    />
                  </div>
                  <button type="submit" className="v4-btn primary" disabled={redeeming}>
                    {redeeming ? "Đang kích hoạt..." : "🚀 Nạp Mã & Cộng Hạn Ngay"}
                  </button>
                </form>

                <div style={{ borderTop: "1px solid var(--border)", marginTop: 18, paddingTop: 14 }}>
                  <div className="v4-muted" style={{ marginBottom: 8 }}>
                    Công cụ xuất dữ liệu kho Giftcode ({vouchers.length} mã):
                  </div>
                  <div className="v5-inline-actions">
                    <button
                      type="button"
                      className="v4-btn sm"
                      disabled={vouchers.length === 0}
                      onClick={() => {
                        const available = vouchers
                          .filter((v) => Number(v.usedCount || 0) < Number(v.maxUses || 1))
                          .map((v) => v.code);
                        navigator.clipboard?.writeText(available.join("\n")).catch(() => {});
                        notify(`Đã sao chép ${available.length} mã khả dụng vào bộ nhớ tạm!`, "success");
                      }}
                    >
                      📋 Copy Toàn Bộ Mã Khả Dụng
                    </button>
                    <button
                      type="button"
                      className="v4-btn sm"
                      disabled={vouchers.length === 0}
                      onClick={() => {
                        downloadCsv(
                          `mybot-giftcodes-${new Date().toISOString().slice(0, 10)}.csv`,
                          ["Code", "Duration", "Tier", "PriceVND", "Used", "MaxUses", "Note", "CreatedAt"],
                          vouchers.map((v) => [
                            v.code,
                            v.durationPreset || v.duration || "+30d",
                            v.tier || "VIP",
                            v.priceVnd || 0,
                            v.usedCount || 0,
                            v.maxUses || 1,
                            v.note || "",
                            v.createdAt || "",
                          ])
                        );
                        notify("Đã xuất tệp CSV danh sách Giftcode!", "success");
                      }}
                    >
                      📥 Xuất Tệp CSV
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Active Vouchers Table */}
            <div className="v4-table-wrap">
              <table className="v4-table">
                <thead>
                  <tr>
                    <th>Mã Giftcode</th>
                    <th>Thời Hạn</th>
                    <th>Hạng</th>
                    <th>Mệnh Giá</th>
                    <th>Lượt Dùng</th>
                    <th>Ghi Chú</th>
                    <th style={{ textAlign: "right" }}>Thao Tác</th>
                  </tr>
                </thead>
                <tbody>
                  {vouchers.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: 28 }} className="v4-muted">
                        Kho Giftcode hiện đang trống. Hãy tạo lô mã mới ở biểu mẫu bên trên.
                      </td>
                    </tr>
                  ) : (
                    vouchers.map((v) => {
                      const code = v.code || v.id;
                      const used = Number(v.usedCount || 0);
                      const max = Number(v.maxUses || 1);
                      const exhausted = used >= max || v.status === "exhausted";
                      return (
                        <tr key={code}>
                          <td className="v4-mono" style={{ fontWeight: 700 }}>
                            {code}
                          </td>
                          <td>{v.durationPreset || v.duration || "+30d"}</td>
                          <td>
                            <span className="v5-tag vip">{v.tier || "VIP"}</span>
                          </td>
                          <td className="v4-mono">{formatVnd(v.priceVnd || 0)}</td>
                          <td className="v4-mono">
                            <span className={`v4-badge ${exhausted ? "neutral" : "success"}`}>
                              {used}/{max} {exhausted ? "(Hết lượt)" : "(Khả dụng)"}
                            </span>
                          </td>
                          <td className="v4-muted">{v.note || "--"}</td>
                          <td style={{ textAlign: "right" }}>
                            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
                              <button
                                type="button"
                                className="v4-btn sm"
                                onClick={() => {
                                  navigator.clipboard?.writeText(code).catch(() => {});
                                  setRedeemCode(code);
                                  notify(`Đã sao chép mã ${code}`, "info");
                                }}
                              >
                                📋 Copy
                              </button>
                              <button
                                type="button"
                                className="v4-btn sm danger"
                                onClick={() => handleDeleteVoucher(code)}
                              >
                                🗑 Xóa
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* SUB-TAB 3: EXPIRING QUEUE & LIFECYCLE POLICY */}
        {tab === "expiring" && (
          <div className="v4-grid-2">
            <div className="v4-card" style={{ background: "var(--v5-surface-2)" }}>
              <div className="v4-card-header">
                <div>
                  <h3>⏰ Hàng Đợi Bot Sắp Hết Hạn (&le; 72 Giờ)</h3>
                  <div className="v4-muted">Ưu tiên xử lý gia hạn hoặc đưa vào chế độ Chờ Nóng an toàn</div>
                </div>
                <button
                  type="button"
                  className="v4-btn warning sm"
                  disabled={sweeping}
                  onClick={handleRunSweep}
                >
                  {sweeping ? "Đang quét..." : "⚡ Quét & Nhắc Hạn Ngay"}
                </button>
              </div>

              {sweepResult && (
                <div className="v4-card" style={{ marginBottom: 12, padding: 10 }}>
                  <div style={{ fontWeight: 700, color: "var(--success)" }}>
                    ✅ Kết quả quét vòng đời gần nhất:
                  </div>
                  <div className="v4-muted">
                    Đã nhắc hạn: {sweepResult.remindedCount ?? sweepResult.reminded ?? 0} Bot • Chuyển Standby quá hạn:{" "}
                    {sweepResult.standbyCount ?? sweepResult.suspended ?? 0} Bot
                  </div>
                </div>
              )}

              {expiringBots.length === 0 ? (
                <div style={{ textAlign: "center", padding: 32 }} className="v4-muted">
                  🎉 Tuyệt vời! Không có Bot khách thuê nào sắp hết hạn trong 72 giờ tới.
                </div>
              ) : (
                <div className="v5-stack">
                  {expiringBots.map((bot) => {
                    const hrs = Math.round(parseRemainingHours(bot.expiryAt));
                    return (
                      <div key={bot.id} className="v4-card" style={{ padding: 12 }}>
                        <div className="v5-row-between">
                          <div>
                            <strong>{bot.displayName}</strong>{" "}
                            <span className="v4-muted v4-mono">({bot.id})</span>
                            <div className="v4-muted" style={{ fontSize: 12 }}>
                              Hạn: {formatExpiryVi(bot.expiryAt)} • Chủ: {bot.ownerUid || "Chưa gán"}
                            </div>
                          </div>
                          <span className={`v4-badge ${hrs <= 0 ? "danger" : "warning"}`}>
                            {hrs <= 0 ? "Đã quá hạn" : `Còn ~${hrs}h`}
                          </span>
                        </div>
                        <div className="v5-inline-actions" style={{ marginTop: 10 }}>
                          <button
                            type="button"
                            className="v4-btn sm success"
                            onClick={() => handleExtendBot(bot, "+30d")}
                          >
                            +30 ngày
                          </button>
                          <button
                            type="button"
                            className="v4-btn sm"
                            onClick={() => handleExtendBot(bot, "+7d")}
                          >
                            +7 ngày
                          </button>
                          <button
                            type="button"
                            className="v4-btn sm accent"
                            onClick={() => runBotAction(bot.id, "hot_standby")}
                          >
                            ⚡ Chuyển Chờ Nóng
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Lifecycle Policy Editor */}
            <div className="v4-card" style={{ background: "var(--v5-surface-2)" }}>
              <div className="v4-card-header">
                <div>
                  <h3>🤖 Chính Sách Nhắc Hạn & Thu Hồi Tự Động</h3>
                  <div className="v4-muted">Tự động hóa chăm sóc khách thuê 24/7 không cần nhắc tay</div>
                </div>
              </div>

              <form onSubmit={handleSavePolicy} className="v5-stack">
                {[
                  {
                    key: "autoRemind72h",
                    title: "Nhắc gia hạn trước 72 giờ",
                    desc: "Gửi thông báo nhắc sớm để chủ thuê chủ động chuyển khoản",
                  },
                  {
                    key: "autoRemind24h",
                    title: "Nhắc gia hạn trước 24 giờ",
                    desc: "Gửi thông báo ưu tiên kèm cú pháp chuyển khoản ngân hàng",
                  },
                  {
                    key: "autoRemind2h",
                    title: "Cảnh báo khẩn trước 2 giờ cuối",
                    desc: "Nhắc lần cuối trước khi hệ thống tạm dừng phiên kết nối",
                  },
                  {
                    key: "autoStandbyOnExpiry",
                    title: "Tự động chuyển sang Chờ Nóng (Hot Standby) khi hết hạn",
                    desc: "Giữ nguyên dữ liệu & Cookie để bật lại trong 1 giây ngay khi khách nạp mã",
                  },
                ].map((item) => (
                  <div key={item.key} className="v4-switch-card">
                    <div>
                      <div style={{ fontWeight: 700 }}>{item.title}</div>
                      <div className="v4-muted">{item.desc}</div>
                    </div>
                    <button
                      type="button"
                      className={`v4-switch ${policy[item.key] ? "on" : ""}`}
                      onClick={() => setPolicy((p) => ({ ...p, [item.key]: !p[item.key] }))}
                    >
                      <span className="v4-switch-knob" />
                    </button>
                  </div>
                ))}

                <div className="v4-field" style={{ marginBottom: 0 }}>
                  <label>
                    Mẫu tin nhắn nhắc gia hạn & Thông tin chuyển khoản (Biến: <code>{"{botName}"}</code>,{" "}
                    <code>{"{ownerUid}"}</code>, <code>{"{expiryDate}"}</code>, <code>{"{amountVnd}"}</code>)
                  </label>
                  <textarea
                    className="v4-textarea"
                    rows={4}
                    value={policy.bankTransferTemplate || ""}
                    onChange={(e) => setPolicy((p) => ({ ...p, bankTransferTemplate: e.target.value }))}
                  />
                </div>

                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button type="submit" className="v4-btn success" disabled={savingPolicy}>
                    {savingPolicy ? "Đang lưu..." : "💾 Lưu Chính Sách Vòng Đời"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* SUB-TAB 4: SUBSCRIPTION LEDGER */}
        {tab === "ledger" && (
          <div className="v5-stack">
            <div className="v4-toolbar" style={{ justifyContent: "space-between" }}>
              <input
                className="v4-input"
                style={{ maxWidth: 360 }}
                placeholder="Tìm theo Bot ID, Owner UID, Mã Giftcode..."
                value={ledgerSearch}
                onChange={(e) => setLedgerSearch(e.target.value)}
              />
              <button
                type="button"
                className="v4-btn sm"
                disabled={filteredLedger.length === 0}
                onClick={() => {
                  downloadCsv(
                    `mybot-subscription-ledger-${new Date().toISOString().slice(0, 10)}.csv`,
                    ["Time", "Type", "BotId", "OwnerUid", "VoucherCode", "Duration", "AmountVND", "Actor"],
                    filteredLedger.map((row) => [
                      row.createdAt || row.timestamp || "",
                      row.type || row.action || "extend",
                      row.botId || "",
                      row.ownerUid || "",
                      row.voucherCode || row.code || "",
                      row.duration || row.preset || "",
                      row.amountVnd || 0,
                      row.actor || "admin",
                    ])
                  );
                }}
              >
                📥 Xuất Sổ Cái CSV
              </button>
            </div>

            <div className="v4-table-wrap">
              <table className="v4-table">
                <thead>
                  <tr>
                    <th>Thời Gian</th>
                    <th>Loại Giao Dịch</th>
                    <th>Bot</th>
                    <th>Chủ Thuê</th>
                    <th>Mã Giftcode</th>
                    <th>Thời Hạn Cộng</th>
                    <th>Số Tiền (VNĐ)</th>
                    <th>Người Thực Hiện</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLedger.length === 0 ? (
                    <tr>
                      <td colSpan={8} style={{ textAlign: "center", padding: 32 }} className="v4-muted">
                        Chưa có bút toán giao dịch nào được ghi nhận. Mọi thao tác gia hạn hoặc nạp Giftcode sẽ tự động lưu vào sổ cái này.
                      </td>
                    </tr>
                  ) : (
                    filteredLedger.map((entry, idx) => (
                      <tr key={entry.id || `${entry.createdAt}_${idx}`}>
                        <td className="v4-mono">{formatDateVi(entry.createdAt || entry.timestamp)}</td>
                        <td>
                          <span className="v4-badge info">{entry.type || entry.action || "extend"}</span>
                        </td>
                        <td className="v4-mono">{entry.botId || "--"}</td>
                        <td className="v4-mono">{entry.ownerUid || "--"}</td>
                        <td className="v4-mono">{entry.voucherCode || entry.code || "--"}</td>
                        <td>{entry.duration || entry.preset || "--"}</td>
                        <td className="v4-mono" style={{ fontWeight: 700, color: "var(--success)" }}>
                          {formatVnd(entry.amountVnd || 0)}
                        </td>
                        <td className="v4-muted">{entry.actor || "system"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Modal: Edit Customer 360 Profile */}
      {editingOwner && (
        <div className="v4-modal-backdrop" onClick={() => !savingOwner && setEditingOwner(null)}>
          <div className="v4-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>✏️ Hồ Sơ Chủ Thuê — {editingOwner}</h3>
                <div className="v4-muted">Thông tin quản lý khách hàng CRM nội bộ</div>
              </div>
              <button type="button" className="v4-btn sm" onClick={() => setEditingOwner(null)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleSaveCustomer}>
              <div className="v4-field">
                <label>Tên hiển thị khách thuê / Đối tác</label>
                <input
                  className="v4-input"
                  value={ownerForm.name}
                  onChange={(e) => setOwnerForm((p) => ({ ...p, name: e.target.value }))}
                />
              </div>
              <div className="v4-field">
                <label>Số điện thoại / Zalo liên hệ</label>
                <input
                  className="v4-input"
                  value={ownerForm.phone}
                  onChange={(e) => setOwnerForm((p) => ({ ...p, phone: e.target.value }))}
                />
              </div>
              <div className="v4-field">
                <label>Phân hạng khách hàng (Tier)</label>
                <select
                  className="v4-select"
                  value={ownerForm.tier}
                  onChange={(e) => setOwnerForm((p) => ({ ...p, tier: e.target.value }))}
                >
                  <option value="Standard">Standard</option>
                  <option value="VIP">VIP</option>
                  <option value="Reseller">Đại Lý (Reseller)</option>
                  <option value="Enterprise">Doanh Nghiệp (Enterprise)</option>
                </select>
              </div>
              <div className="v4-field">
                <label>Ghi chú hợp đồng / Thanh toán</label>
                <textarea
                  className="v4-textarea"
                  value={ownerForm.notes}
                  onChange={(e) => setOwnerForm((p) => ({ ...p, notes: e.target.value }))}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="v4-btn" onClick={() => setEditingOwner(null)}>
                  Đóng
                </button>
                <button type="submit" className="v4-btn success" disabled={savingOwner}>
                  {savingOwner ? "Đang lưu..." : "💾 Lưu Hồ Sơ"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Display Magic Access Code for Customer Portal */}
      {generatedPortalToken && (
        <div className="v4-modal-backdrop" onClick={() => setGeneratedPortalToken(null)}>
          <div className="v4-modal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>🔑 Mã Truy Cập Cổng Khách Thuê (Tenant Portal)</h3>
                <div className="v4-muted">
                  Khách hàng: <strong>{generatedPortalToken.customerName}</strong> ({generatedPortalToken.botCount} Bot được phép quản lý)
                </div>
              </div>
              <button type="button" className="v4-btn sm" onClick={() => setGeneratedPortalToken(null)}>
                ✕
              </button>
            </div>

            <p className="v4-muted" style={{ marginTop: 0 }}>
              Gửi mã truy cập bên dưới cho chủ thuê. Khách thuê mở trang đăng nhập Dashboard, chọn mục{" "}
              <strong>“Cổng Khách Thuê / Đại Lý”</strong> và dán mã này để tự quét QR hoặc điều khiển riêng Bot của họ:
            </p>

            <div
              className="v4-card v4-mono"
              style={{
                padding: 14,
                fontSize: 14,
                fontWeight: 700,
                wordBreak: "break-all",
                background: "var(--bg-input)",
                borderColor: "var(--primary)",
              }}
            >
              {generatedPortalToken.code || "Chưa nhận được mã từ máy chủ"}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button
                type="button"
                className="v4-btn primary"
                onClick={() => {
                  navigator.clipboard?.writeText(generatedPortalToken.code || "").catch(() => {});
                  notify("Đã sao chép Mã Truy Cập Cổng Khách Thuê!", "success");
                }}
              >
                📋 Sao Chép Mã Truy Cập
              </button>
              <button type="button" className="v4-btn" onClick={() => setGeneratedPortalToken(null)}>
                Hoàn tất
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
