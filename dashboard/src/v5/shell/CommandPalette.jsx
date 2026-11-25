import React, { useEffect, useMemo, useRef, useState } from "react";
import { useV5 } from "../v5-store.jsx";

function normalizeVi(input = "") {
  return String(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

const V5_PAGES = [
  {
    id: "overview",
    icon: "📡",
    title: "Đội Hình & Cụm HA (Fleet Orchestrator)",
    subtitle: "Bảng chi tiết, lưới thẻ, sơ đồ cụm HA Primary-Standby, Health Score & Proxy",
    keywords: "overview fleet doi hinh bot ha failover proxy tag",
  },
  {
    id: "crm",
    icon: "💎",
    title: "Kinh Doanh Cho Thuê & Giftcode (SaaS CRM)",
    subtitle: "Danh bạ chủ thuê 360°, tạo lô mã Giftcode, hàng đợi sắp hết hạn & sổ cái doanh thu",
    keywords: "crm saas khach thue chu bot giftcode voucher gia han doanh thu",
  },
  {
    id: "campaigns",
    icon: "🚀",
    title: "Chiến Dịch & Điều Khiển Từ Xa (Campaigns & Remote)",
    subtitle: "Gửi tin Spintax chống spam, lên lịch Broadcast đa nhóm & chạy lệnh từ xa",
    keywords: "campaigns remote broadcast chien dich gui tin spintax dieu khien",
  },
  {
    id: "groups",
    icon: "🛡️",
    title: "Quản Trị Nhóm & 17 Khiên Bảo Vệ (Groups & Shields)",
    subtitle: "Chống link, chống spam, chống thu hồi, cấu hình chuyên sâu theo từng nhóm Zalo",
    keywords: "groups nhom anti shield khien bao ve spam link",
  },
  {
    id: "studio",
    icon: "🎛️",
    title: "Studio 218 Lệnh V2.5 & Lịch 24 Giờ (Command Studio)",
    subtitle: "Chỉnh cấu hình đa tầng Global/Bot/Group, xem Provenance, Diff & Rollback tức thì",
    keywords: "studio command lenh sendtask lich 24h config",
  },
  {
    id: "operations",
    icon: "📋",
    title: "Trung Tâm Tiến Trình & Khắc Phục (Operations Center)",
    subtitle: "Timeline 3 pha accepted → connecting → ws_ready, mã operationId & gỡ lỗi 1-Click",
    keywords: "operations ops tien trinh lich su thao tac loi",
  },
  {
    id: "telemetry",
    icon: "📈",
    title: "Đo Lường SRE, Cảnh Báo & Tự Phục Hồi (Telemetry & SRE)",
    subtitle: "Biểu đồ Throughput, độ trễ p50/p95/p99, bảng xếp hạng lệnh, Cảnh báo Telegram/Discord & Auto-Heal",
    keywords: "telemetry sre performance hieu nang do tre chart alert telegram discord auto heal",
  },
  {
    id: "logs",
    icon: "📜",
    title: "Nhật Ký Hoạt Động Trực Tiếp (Live Logs)",
    subtitle: "Luồng sự kiện WebSocket thời gian thực, lọc theo Bot và mức độ nghiêm trọng",
    keywords: "logs nhat ky terminal console loi",
  },
  {
    id: "governance",
    icon: "🏛️",
    title: "Phân Quyền IAM, Bảo Mật 2FA & Hệ Thống (Governance)",
    subtitle: "Tài khoản Operator/Reseller, nhật ký kiểm toán Audit, Sao lưu Snapshot & Khóa AI",
    keywords: "governance security iam phan quyen totp 2fa audit backup mật khẩu",
  },
];

export default function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    enrichedFleet,
    setPage,
    setDetailBotId,
    setSelectedBotId,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    theme,
    setTheme,
    notify,
    v5Fetch,
    refreshV5,
    openCommandInStudio,
  } = useV5();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const [catalogCommands, setCatalogCommands] = useState([]);
  const catalogLoadedRef = useRef(false);
  const inputRef = useRef(null);
  const activeItemRef = useRef(null);

  useEffect(() => {
    if (!commandPaletteOpen) return;
    setQuery("");
    setActiveIndex(0);
    setTimeout(() => inputRef.current?.focus(), 20);

    if (!catalogLoadedRef.current) {
      catalogLoadedRef.current = true;
      v5Fetch("/api/command-studio/catalog")
        .then((res) => {
          const list = Array.isArray(res?.commands) ? res.commands : Array.isArray(res) ? res : [];
          if (list.length > 0) {
            setCatalogCommands(list);
          } else {
            return v5Fetch("/api/commands").then((fallback) => {
              const arr = Array.isArray(fallback?.commands) ? fallback.commands : Array.isArray(fallback) ? fallback : [];
              setCatalogCommands(arr);
            });
          }
          return null;
        })
        .catch(() => {
          catalogLoadedRef.current = false;
        });
    }
  }, [commandPaletteOpen, v5Fetch]);

  const closePalette = () => setCommandPaletteOpen(false);

  const quickActions = useMemo(
    () => [
      {
        id: "act_qr_admin",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: "⚡",
        title: "Quét QR Cứu Hộ Admin",
        subtitle: "Mở ngay trình quét mã QR Zalo khôi phục Bot Admin Chính",
        keywords: "quet qr cuu ho admin recovery cookie",
        badge: "Khẩn cấp",
        badgeTone: "danger",
        run: () => {
          closePalette();
          setShowAdminRecovery(true);
        },
      },
      {
        id: "act_create_bot",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: "➕",
        title: "Tạo Bot Phụ Mới",
        subtitle: "Khởi tạo Bot phụ mới bằng mã QR Zalo trực tiếp trên Web",
        keywords: "tao bot phu moi create qr",
        badge: "1-Click",
        badgeTone: "success",
        run: () => {
          closePalette();
          setCreateQrTargetBot({ mode: "create" });
        },
      },
      {
        id: "act_batch_giftcode",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: "🎟️",
        title: "Tạo Lô Giftcode Gia Hạn",
        subtitle: "Chuyển tới Kho Giftcode & Mã Kích Hoạt trong SaaS CRM",
        keywords: "tao lo giftcode gia han voucher ma kich hoat",
        badge: "CRM",
        badgeTone: "info",
        run: () => {
          closePalette();
          try {
            sessionStorage.setItem("mybot_v5_crm_tab", "vouchers");
            window.dispatchEvent(new CustomEvent("v5:crm-tab", { detail: { tab: "vouchers" } }));
          } catch {}
          setPage("crm");
        },
      },
      {
        id: "act_system_doctor",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: "🩺",
        title: "Chạy Bác Sĩ Hệ Thống",
        subtitle: "Chẩn đoán Node.js, FFmpeg, yt-dlp, RAM và kết nối Cookie toàn cục",
        keywords: "chay bac si he thong doctor health check",
        badge: "Chẩn đoán",
        badgeTone: "info",
        run: async () => {
          closePalette();
          notify("Đang chạy Bác Sĩ Hệ Thống...", "info");
          try {
            const report = await v5Fetch("/api/system/doctor");
            const okCount = Array.isArray(report?.checks)
              ? report.checks.filter((c) => c.status === "ok").length
              : 0;
            const total = Array.isArray(report?.checks) ? report.checks.length : 0;
            notify(
              `Bác Sĩ Hệ Thống hoàn tất: ${okCount}/${total} hạng mục đạt chuẩn!`,
              report?.ok !== false ? "success" : "warning"
            );
          } catch (err) {
            notify(err.message || "Không thể chạy Bác Sĩ Hệ Thống", "error");
          }
        },
      },
      {
        id: "act_disk_cleanup",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: "🧹",
        title: "Dọn Rác Ổ Đĩa",
        subtitle: "Giải phóng ảnh, video, âm thanh đệm tạm thời trên máy chủ",
        keywords: "don rac o dia cleanup disk temp cache",
        badge: "Bảo trì",
        badgeTone: "neutral",
        run: async () => {
          closePalette();
          notify("Đang dọn rác ổ đĩa và bộ đệm tạm...", "info");
          try {
            const res = await v5Fetch("/api/system/disk-cleanup", { method: "POST", body: {} });
            notify(res?.message || "Đã dọn sạch bộ đệm rác ổ đĩa thành công!", "success");
            refreshV5();
          } catch (err) {
            notify(err.message || "Dọn rác ổ đĩa thất bại", "error");
          }
        },
      },
      {
        id: "act_snapshot_backup",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: "📸",
        title: "Tạo Bản Sao Lưu Snapshot",
        subtitle: "Đóng gói cấu hình an toàn (ẩn khóa nhạy cảm) để khôi phục bất kỳ lúc nào",
        keywords: "tao ban sao luu snapshot backup khoi phuc",
        badge: "An toàn",
        badgeTone: "success",
        run: async () => {
          closePalette();
          try {
            const snap = await v5Fetch("/api/v5/governance/snapshots", {
              method: "POST",
              body: { label: `Quick Snapshot (${new Date().toLocaleString("vi-VN")})` },
            });
            notify(
              `Đã tạo Snapshot sao lưu "${snap?.id || snap?.snapshot?.id || "mới"}" thành công!`,
              "success"
            );
          } catch {
            try {
              const bundle = await v5Fetch("/api/system/backup/download");
              const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `mybot-snapshot-${new Date().toISOString().slice(0, 10)}.json`;
              a.click();
              URL.revokeObjectURL(url);
              notify("Đã tải xuống tệp Bản Sao Lưu Snapshot an toàn!", "success");
            } catch (err) {
              notify(err.message || "Tạo Snapshot thất bại", "error");
            }
          }
        },
      },
      {
        id: "act_toggle_theme",
        category: "actions",
        groupLabel: "Thao Tác Nhanh 1-Click",
        icon: theme === "dark" ? "☀️" : "🌙",
        title: "Đổi Giao Diện Sáng/Tối",
        subtitle: `Chuyển từ chế độ ${theme === "dark" ? "Tối (Dark)" : "Sáng (Light)"} sang ${theme === "dark" ? "Sáng (Light)" : "Tối (Dark)"}`,
        keywords: "doi giao dien sang toi dark light theme mode",
        badge: theme === "dark" ? "Light" : "Dark",
        badgeTone: "neutral",
        run: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          closePalette();
        },
      },
    ],
    [theme, setTheme, setShowAdminRecovery, setCreateQrTargetBot, setPage, notify, v5Fetch, refreshV5]
  );

  const allItems = useMemo(() => {
    const items = [];

    // 1. 9 Trang Điều Hành V5
    for (const p of V5_PAGES) {
      items.push({
        id: `page_${p.id}`,
        category: "pages",
        groupLabel: "9 Trang Điều Hành V5",
        icon: p.icon,
        title: p.title,
        subtitle: p.subtitle,
        searchText: normalizeVi(`${p.title} ${p.subtitle} ${p.keywords}`),
        badge: "Trang",
        badgeTone: "info",
        run: () => {
          closePalette();
          setPage(p.id);
        },
      });
    }

    // 2. Thao Tác Nhanh 1-Click
    for (const act of quickActions) {
      items.push({
        ...act,
        searchText: normalizeVi(`${act.title} ${act.subtitle} ${act.keywords}`),
      });
    }

    // 3. Toàn Bộ Đội Hình Bot
    for (const bot of enrichedFleet) {
      const baseKw = `${bot.displayName} ${bot.id} ${bot.uid} ${bot.ownerUid || ""} ${(bot.tags || []).join(" ")}`;
      items.push({
        id: `bot_detail_${bot.id}`,
        category: "bots",
        groupLabel: "Toàn Bộ Đội Hình Bot",
        icon: bot.isPrimaryAdmin ? "👑" : "🤖",
        title: `${bot.displayName} — Mở Chi Tiết & Cấu Hình`,
        subtitle: `UID: ${bot.uid} • Health: ${bot.healthScore}/100 • Trạng thái: ${bot.status}`,
        searchText: normalizeVi(`${baseKw} chi tiet cau hinh bot detail`),
        badge: `${bot.healthScore}đ`,
        badgeTone: bot.healthScore >= 80 ? "success" : bot.healthScore >= 50 ? "warning" : "danger",
        run: () => {
          closePalette();
          setDetailBotId(bot.id);
        },
      });
      items.push({
        id: `bot_remote_${bot.id}`,
        category: "bots",
        groupLabel: "Toàn Bộ Đội Hình Bot",
        icon: "🎮",
        title: `${bot.displayName} — Điều Khiển Từ Xa`,
        subtitle: `Gửi tin nhắn, Broadcast & thực thi lệnh trực tiếp qua ${bot.displayName}`,
        searchText: normalizeVi(`${baseKw} dieu khien tu xa remote control`),
        badge: "Remote",
        badgeTone: "info",
        run: () => {
          closePalette();
          setSelectedBotId(bot.id);
          setPage("campaigns");
        },
      });
      items.push({
        id: `bot_qr_${bot.id}`,
        category: "bots",
        groupLabel: "Toàn Bộ Đội Hình Bot",
        icon: "📱",
        title: `${bot.displayName} — Quét Mã QR Đăng Nhập`,
        subtitle: `Làm mới Cookie Zalo cho ${bot.displayName} (${bot.id})`,
        searchText: normalizeVi(`${baseKw} quet ma qr dang nhap relogin cookie`),
        badge: bot.cookieDead ? "Cần QR" : "QR Login",
        badgeTone: bot.cookieDead ? "danger" : "neutral",
        run: () => {
          closePalette();
          if (bot.isPrimaryAdmin || bot.isMain) {
            setShowAdminRecovery(true);
          } else {
            setCreateQrTargetBot({ mode: "relogin", botId: bot.id });
          }
        },
      });
    }

    // 4. 218 Lệnh Hệ Thống
    for (const cmd of catalogCommands) {
      const cmdName = String(cmd.commandName || cmd.name || cmd.id || "");
      if (!cmdName) continue;
      const aliases = Array.isArray(cmd.aliases) ? cmd.aliases.join(", ") : "";
      const moduleInfo = cmd.handlerRef?.module || cmd.category || "command";
      items.push({
        id: `cmd_${cmdName}`,
        category: "commands",
        groupLabel: `218 Lệnh Hệ Thống (${catalogCommands.length || 218})`,
        icon: "⚙️",
        title: `!${cmdName}${aliases ? ` (${aliases})` : ""}`,
        subtitle: `Mở trong Studio V2.5 • Phân quyền: ${cmd.permission || "all"} • Module: ${moduleInfo}`,
        searchText: normalizeVi(`${cmdName} ${aliases} ${moduleInfo} ${cmd.description || ""} lenh studio`),
        badge: "Studio V2.5",
        badgeTone: "neutral",
        run: () => {
          closePalette();
          openCommandInStudio(cmdName);
        },
      });
    }

    return items;
  }, [
    quickActions,
    enrichedFleet,
    catalogCommands,
    setPage,
    setDetailBotId,
    setSelectedBotId,
    setShowAdminRecovery,
    setCreateQrTargetBot,
    openCommandInStudio,
  ]);

  const filteredItems = useMemo(() => {
    const q = normalizeVi(query);
    const matches = allItems.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (!q) return true;
      const tokens = q.split(/\s+/).filter(Boolean);
      return tokens.every((tk) => item.searchText.includes(tk));
    });
    // Limit rendered rows when query is empty to keep DOM ultra-snappy while still showing every category
    if (!q && category === "all") {
      const pages = matches.filter((m) => m.category === "pages");
      const actions = matches.filter((m) => m.category === "actions");
      const bots = matches.filter((m) => m.category === "bots").slice(0, 9);
      const cmds = matches.filter((m) => m.category === "commands").slice(0, 18);
      return [...pages, ...actions, ...bots, ...cmds];
    }
    return matches.slice(0, 90);
  }, [allItems, query, category]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, category]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (!commandPaletteOpen) return null;

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredItems.length > 0) {
        setActiveIndex((prev) => (prev + 1) % filteredItems.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredItems.length > 0) {
        setActiveIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = filteredItems[activeIndex];
      if (chosen) chosen.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  };

  // Group consecutive items by groupLabel while preserving flat index for keyboard nav
  const groupedSections = [];
  filteredItems.forEach((item, flatIdx) => {
    const last = groupedSections[groupedSections.length - 1];
    if (!last || last.label !== item.groupLabel) {
      groupedSections.push({ label: item.groupLabel, rows: [{ item, flatIdx }] });
    } else {
      last.rows.push({ item, flatIdx });
    }
  });

  return (
    <div className="v5-cmdk-backdrop" onClick={closePalette} role="dialog" aria-modal="true" aria-label="Bảng Lệnh Nhanh V5">
      <div className="v5-cmdk-modal" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="v5-cmdk-search-row">
          <span className="v5-cmdk-search-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="v5-cmdk-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm nhanh 9 trang V5, Bot, thao tác 1-Click, hoặc gõ tên trong 218 lệnh (hỗ trợ không dấu)..."
          />
          {query && (
            <button type="button" className="v4-btn sm" onClick={() => setQuery("")}>
              Xóa
            </button>
          )}
          <kbd className="v4-kbd">ESC</kbd>
        </div>

        <div className="v5-cmdk-cats">
          {[
            { id: "all", label: "Tất cả" },
            { id: "pages", label: "🧭 9 Trang V5" },
            { id: "actions", label: "⚡ Thao Tác 1-Click" },
            { id: "bots", label: `🤖 Đội Hình Bot (${enrichedFleet.length})` },
            { id: "commands", label: `🎛️ 218 Lệnh (${catalogCommands.length || 218})` },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              className={`v5-cmdk-cat-pill ${category === cat.id ? "active" : ""}`}
              onClick={() => setCategory(cat.id)}
            >
              {cat.label}
            </button>
          ))}
        </div>

        <div className="v5-cmdk-list">
          {groupedSections.length === 0 ? (
            <div style={{ textAlign: "center", padding: "38px 16px" }} className="v4-muted">
              Không tìm thấy kết quả nào khớp với <strong>“{query}”</strong>. Hãy thử từ khóa ngắn hơn hoặc gõ không dấu.
            </div>
          ) : (
            groupedSections.map((section) => (
              <div key={section.label}>
                <div className="v5-cmdk-group-title">{section.label}</div>
                {section.rows.map(({ item, flatIdx }) => {
                  const isActive = flatIdx === activeIndex;
                  return (
                    <button
                      key={item.id}
                      ref={isActive ? activeItemRef : null}
                      type="button"
                      className={`v5-cmdk-item ${isActive ? "active" : ""}`}
                      onMouseEnter={() => setActiveIndex(flatIdx)}
                      onClick={() => item.run()}
                    >
                      <div className="v5-cmdk-item-left">
                        <span className="v5-cmdk-item-icon">{item.icon}</span>
                        <div style={{ minWidth: 0 }}>
                          <div className="v5-cmdk-item-title">{item.title}</div>
                          <div className="v5-cmdk-item-sub">{item.subtitle}</div>
                        </div>
                      </div>
                      <span className={`v4-badge ${item.badgeTone || "neutral"}`}>{item.badge}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="v5-cmdk-footer">
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span>
              <kbd className="v4-kbd sm">↑</kbd> <kbd className="v4-kbd sm">↓</kbd> Di chuyển
            </span>
            <span>
              <kbd className="v4-kbd sm">Enter</kbd> Thực thi ngay
            </span>
            <span>
              <kbd className="v4-kbd sm">Ctrl</kbd>+<kbd className="v4-kbd sm">K</kbd> Mở/Đóng nhanh
            </span>
          </div>
          <span>Hỗ trợ tìm kiếm Tiếng Việt có dấu & không dấu</span>
        </div>
      </div>
    </div>
  );
}
