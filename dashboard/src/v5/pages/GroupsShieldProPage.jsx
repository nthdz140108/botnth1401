import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatDateVi, v4Fetch } from "../../v4/http.js";

async function callV5(v5Fetch, subPath, options = {}) {
  const cleanSub = subPath.startsWith("/") ? subPath : `/${subPath}`;
  if (typeof v5Fetch === "function") {
    try {
      return await v5Fetch(cleanSub, options);
    } catch (err) {
      if (err && err.status === 404 && !err.code) {
        return v4Fetch(`/api/v5${cleanSub}`, options);
      }
      throw err;
    }
  }
  return v4Fetch(`/api/v5${cleanSub}`, options);
}

const CORE_SWITCHES = [
  { key: "activeBot", title: "Kích Hoạt Bot Trong Nhóm", desc: "Cho phép Bot nghe và xử lý lệnh trong nhóm này" },
  { key: "onlyAdminBox", title: "Chỉ Quản Trị Viên Nhóm Dùng Lệnh", desc: "Chặn thành viên thường spam các lệnh giải trí" },
  { key: "sendTask", title: "Nhận Lịch Tự Động Mỗi Giờ (SendTask)", desc: "Tự động gửi lời chúc / ảnh / video / nhạc theo giờ" },
  { key: "enableSetup", title: "Thẻ Chào Mừng & Tạm Biệt", desc: "Tự động gửi thông điệp khi có người vào/rời nhóm" },
  { key: "learnEnabled", title: "Cho Phép Học Từ Điển Hội Thoại", desc: "Bot học câu trả lời riêng của từng nhóm" },
  { key: "replyEnabled", title: "Tự Động Phản Hồi Từ Khóa", desc: "Tự trả lời thông minh khi khớp từ khóa đã dạy" },
];

const ANTI_SHIELDS = [
  { key: "antiSpam", title: "1. Chống Spam Tin Nhắn Liên Tục", desc: "Cảnh báo, mute hoặc kick thành viên xả tin quá nhanh" },
  { key: "filterBadWords", title: "2. Lọc & Xóa Từ Ngữ Thô Tục", desc: "Ẩn/xóa ngay tin nhắn chứa từ cấm vi phạm nội quy" },
  { key: "removeLinks", title: "3. Tự Động Xóa Link Lạ", desc: "Thu hồi đường dẫn ngoài danh sách tên miền an toàn" },
  { key: "antiLink", title: "4. Khiên Chặn Quảng Cáo Link", desc: "Cảnh cáo hành vi rải link lôi kéo khách hàng" },
  { key: "antiMention", title: "5. Chống Tag All (@Mọi người)", desc: "Ngăn thành viên thường làm phiền toàn bộ nhóm" },
  { key: "antiUndo", title: "6. Chống Thu Hồi Tin Nhắn (Anti-Undo)", desc: "Chụp lại và lưu vết nội dung tin nhắn vừa thu hồi" },
  { key: "antiMedia", title: "7. Kiểm Soát Gửi Ảnh / Video", desc: "Chặn xả ảnh/video hàng loạt gây trôi tin nhắn" },
  { key: "antiSticker", title: "8. Chống Spam Nhãn Dán (Sticker)", desc: "Giới hạn tốc độ thả chuỗi sticker liên hoàn" },
  { key: "antiNude", title: "9. Chặn Ảnh Nhạy Cảm / 18+", desc: "Quét và xóa tức thì hình ảnh phản cảm" },
  { key: "antiForward", title: "10. Chặn Chuyển Tiếp Tin Nhắn", desc: "Ngăn forward tin quảng cáo dây chuyền từ nơi khác" },
  { key: "antiVoice", title: "11. Chặn Tin Nhắn Thoại (Voice)", desc: "Không cho phép spam ghi âm trong nhóm" },
  { key: "antiFile", title: "12. Chặn Tệp Đính Kèm Nguy Hiểm", desc: "Ngăn phát tán mã độc .exe, .apk, .bat, .zip lạ" },
  { key: "antiCard", title: "13. Chặn Rải Danh Thiếp Zalo", desc: "Chống gửi danh thiếp quảng cáo cá nhân lạ" },
  { key: "antiBot", title: "14. Chống Tài Khoản Bot Clone", desc: "Phát hiện và chặn bot lạ xâm nhập phá nhóm" },
  { key: "antiJoinLeave", title: "15. Ẩn & Kiểm Soát Ra/Vào Nhóm", desc: "Giữ khung chat sạch và chống ra/vào liên tục" },
  { key: "antiKickBlock", title: "16. Bảo Vệ Phó Nhóm (Anti-Kick)", desc: "Ngăn chặn hành vi chiếm quyền kick hàng loạt" },
  { key: "antiPoll", title: "17. Chặn Tạo Bình Chọn Rác & Only-Text", desc: "Ngăn spam bảng bình chọn làm loãng nhóm" },
  { key: "onlyText", title: "18. Chế Độ Nghiêm Ngặt (Chỉ Chat Chữ)", desc: "Khóa toàn bộ media, link, file — chỉ cho phép chữ" },
];

const BUILTIN_PRESETS = [
  {
    id: "max_security",
    name: "🔒 An Ninh Tối Đa",
    description: "Bật toàn bộ khiên chống Spam, Link, File độc hại, Tag All và Anti-Kick",
    builtin: true,
    settings: {
      activeBot: true,
      enableBot: true,
      onlyAdminBox: true,
      antiSpam: true,
      filterBadWords: true,
      removeLinks: true,
      antiLink: true,
      antiMention: true,
      antiUndo: true,
      antiNude: true,
      antiForward: true,
      antiFile: true,
      antiCard: true,
      antiBot: true,
      antiKickBlock: true,
      antiPoll: true,
    },
  },
  {
    id: "community_fun",
    name: "🎉 Cộng Đồng Giải Trí",
    description: "Mở tương tác tự do, bật SendTask 24h, chào mừng thành viên & chống link độc",
    builtin: true,
    settings: {
      activeBot: true,
      enableBot: true,
      onlyAdminBox: false,
      sendTask: true,
      enableSetup: true,
      learnEnabled: true,
      replyEnabled: true,
      antiSpam: true,
      filterBadWords: true,
      removeLinks: false,
      antiNude: true,
      antiFile: true,
      antiKickBlock: true,
      onlyText: false,
    },
  },
  {
    id: "sales_group",
    name: "🛍️ Nhóm Bán Hàng",
    description: "Chặn rải link đối thủ, chặn danh thiếp, forward và chỉ cho Admin dùng lệnh",
    builtin: true,
    settings: {
      activeBot: true,
      enableBot: true,
      onlyAdminBox: true,
      enableSetup: true,
      antiSpam: true,
      removeLinks: true,
      antiLink: true,
      antiCard: true,
      antiForward: true,
      antiMention: true,
      antiKickBlock: true,
      onlyText: false,
    },
  },
  {
    id: "night_mode_23_06",
    name: "🌙 Ngủ Đêm 23h-06h",
    description: "Chế độ yên tĩnh ban đêm: khóa Media/Voice/Sticker, chỉ giữ tin nhắn văn bản",
    builtin: true,
    settings: {
      activeBot: true,
      enableBot: true,
      onlyAdminBox: true,
      sendTask: false,
      antiMedia: true,
      antiSticker: true,
      antiVoice: true,
      antiMention: true,
      onlyText: true,
    },
    rules: {
      nightMode: { enabled: true, startHour: "23:00", endHour: "06:00" },
    },
  },
];

const DEFAULT_RULES = {
  badWords: [],
  whitelistedDomains: ["zalo.me", "youtube.com"],
  spamThreshold: {
    maxMessages: 6,
    windowSec: 10,
    action: "warn",
  },
  welcomeTemplate: "Chào mừng {memberName} đã gia nhập {groupName} ({memberCount} thành viên)! 🎉",
  goodbyeTemplate: "Tạm biệt {memberName} đã rời khỏi nhóm {groupName}.",
  nightMode: {
    enabled: false,
    startHour: "23:00",
    endHour: "06:00",
  },
};

export default function GroupsShieldProPage() {
  const {
    bots = [],
    enrichedFleet = [],
    selectedBotId,
    setSelectedBotId,
    notify,
    v5Fetch,
  } = useV5();

  const botList = enrichedFleet?.length ? enrichedFleet : bots;
  const activeBot = useMemo(
    () => botList.find((b) => b.id === selectedBotId) || botList[0] || null,
    [botList, selectedBotId]
  );

  const [tab, setTab] = useState("matrix");

  // Groups & Multi-select state
  const [groups, setGroups] = useState([]);
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [checkedGroupIds, setCheckedGroupIds] = useState([]);
  const [search, setSearch] = useState("");
  const [settings, setSettings] = useState({});
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [saving, setSaving] = useState(false);

  // Presets state
  const [customPresets, setCustomPresets] = useState([]);
  const [newPresetName, setNewPresetName] = useState("");
  const [showSavePresetModal, setShowSavePresetModal] = useState(false);

  // Deep Rules Drawer state
  const [showRulesDrawer, setShowRulesDrawer] = useState(false);
  const [rules, setRules] = useState(DEFAULT_RULES);
  const [badWordsInput, setBadWordsInput] = useState("");
  const [domainsInput, setDomainsInput] = useState("");
  const [savingRules, setSavingRules] = useState(false);

  // Tab 2: Violations & Anti-Undo Vault state
  const [violations, setViolations] = useState([]);
  const [violationShieldFilter, setViolationShieldFilter] = useState("ALL");
  const [violationGroupFilter, setViolationGroupFilter] = useState("ALL");
  const [loadingViolations, setLoadingViolations] = useState(false);

  // Tab 3: Global UID Blacklist state
  const [blacklist, setBlacklist] = useState([]);
  const [blUid, setBlUid] = useState("");
  const [blName, setBlName] = useState("");
  const [blReason, setBlReason] = useState("");
  const [blScope, setBlScope] = useState("global");
  const [blSearch, setBlSearch] = useState("");
  const [loadingBlacklist, setLoadingBlacklist] = useState(false);

  // Load groups
  const loadGroups = useCallback(
    async (botId) => {
      if (!botId) return;
      setLoadingGroups(true);
      try {
        const res = await v4Fetch(`/api/bots/${encodeURIComponent(botId)}/groups`);
        const list = Array.isArray(res) ? res : Array.isArray(res?.groups) ? res.groups : [];
        setGroups(list);
        if (list.length > 0) {
          const firstId = String(list[0].threadId || list[0].id);
          setSelectedThreadId((curr) =>
            curr && list.some((g) => String(g.threadId || g.id) === curr) ? curr : firstId
          );
        } else {
          setSelectedThreadId("");
        }
      } catch (err) {
        notify(err.message || "Không thể tải danh sách nhóm", "error");
      } finally {
        setLoadingGroups(false);
      }
    },
    [notify]
  );

  // Load Presets
  const loadPresets = useCallback(async () => {
    try {
      const res = await callV5(v5Fetch, "/shields/presets");
      const list = Array.isArray(res)
        ? res
        : Array.isArray(res?.presets)
          ? res.presets
          : Array.isArray(res?.items)
            ? res.items
            : [];
      setCustomPresets(list);
    } catch {
      setCustomPresets([]);
    }
  }, [v5Fetch]);

  // Load Group Deep Rules
  const loadGroupRules = useCallback(
    async (botId, threadId) => {
      if (!botId || !threadId) return;
      try {
        const res = await callV5(
          v5Fetch,
          `/bots/${encodeURIComponent(botId)}/groups/${encodeURIComponent(threadId)}/rules`
        );
        const r = res?.rules || res || {};
        const merged = {
          badWords: Array.isArray(r.badWords) ? r.badWords : [],
          whitelistedDomains: Array.isArray(r.whitelistedDomains)
            ? r.whitelistedDomains
            : ["zalo.me", "youtube.com"],
          spamThreshold: {
            maxMessages: Number(r.spamThreshold?.maxMessages ?? 6),
            windowSec: Number(r.spamThreshold?.windowSec ?? 10),
            action: r.spamThreshold?.action || "warn",
          },
          welcomeTemplate: r.welcomeTemplate ?? DEFAULT_RULES.welcomeTemplate,
          goodbyeTemplate: r.goodbyeTemplate ?? DEFAULT_RULES.goodbyeTemplate,
          nightMode: {
            enabled: Boolean(r.nightMode?.enabled),
            startHour: r.nightMode?.startHour || "23:00",
            endHour: r.nightMode?.endHour || "06:00",
          },
        };
        setRules(merged);
        setBadWordsInput(merged.badWords.join(", "));
        setDomainsInput(merged.whitelistedDomains.join(", "));
      } catch {
        setRules(DEFAULT_RULES);
        setBadWordsInput("");
        setDomainsInput("zalo.me, youtube.com");
      }
    },
    [v5Fetch]
  );

  // Load Violations
  const loadViolations = useCallback(async () => {
    setLoadingViolations(true);
    try {
      const qs = new URLSearchParams();
      if (activeBot?.id) qs.set("botId", activeBot.id);
      if (violationShieldFilter !== "ALL") qs.set("shieldType", violationShieldFilter);
      if (violationGroupFilter !== "ALL") qs.set("threadId", violationGroupFilter);
      const res = await callV5(v5Fetch, `/moderation/violations?${qs.toString()}`);
      const list = Array.isArray(res)
        ? res
        : Array.isArray(res?.violations)
          ? res.violations
          : Array.isArray(res?.items)
            ? res.items
            : [];
      setViolations(list);
    } catch {
      setViolations([]);
    } finally {
      setLoadingViolations(false);
    }
  }, [v5Fetch, activeBot?.id, violationShieldFilter, violationGroupFilter]);

  // Load Blacklist
  const loadBlacklist = useCallback(async () => {
    setLoadingBlacklist(true);
    try {
      const res = await callV5(v5Fetch, "/moderation/blacklist");
      const list = Array.isArray(res)
        ? res
        : Array.isArray(res?.blacklist)
          ? res.blacklist
          : Array.isArray(res?.items)
            ? res.items
            : [];
      setBlacklist(list);
    } catch {
      setBlacklist([]);
    } finally {
      setLoadingBlacklist(false);
    }
  }, [v5Fetch]);

  useEffect(() => {
    loadPresets();
    loadBlacklist();
  }, [loadPresets, loadBlacklist]);

  useEffect(() => {
    if (activeBot?.id) {
      loadGroups(activeBot.id);
      setCheckedGroupIds([]);
    }
  }, [activeBot?.id, loadGroups]);

  useEffect(() => {
    if (tab === "violations") {
      loadViolations();
    } else if (tab === "blacklist") {
      loadBlacklist();
    }
  }, [tab, loadViolations, loadBlacklist]);

  const currentGroup = useMemo(
    () => groups.find((g) => String(g.threadId || g.id) === selectedThreadId) || null,
    [groups, selectedThreadId]
  );

  useEffect(() => {
    if (!currentGroup) {
      setSettings({});
      return;
    }
    const raw = currentGroup.settings || {};
    const next = {};
    for (const item of [...CORE_SWITCHES, ...ANTI_SHIELDS]) {
      if (item.key === "activeBot") {
        next.activeBot = Boolean(
          raw.activeBot ?? raw.enableBot ?? currentGroup.activeBot ?? currentGroup.enableBot
        );
      } else {
        next[item.key] = Boolean(currentGroup[item.key] !== undefined ? currentGroup[item.key] : raw[item.key]);
      }
    }
    setSettings(next);
    if (activeBot?.id && selectedThreadId) {
      loadGroupRules(activeBot.id, selectedThreadId);
    }
  }, [currentGroup, activeBot?.id, selectedThreadId, loadGroupRules]);

  const allPresets = useMemo(() => {
    const map = new Map();
    for (const p of BUILTIN_PRESETS) map.set(p.id, p);
    for (const p of customPresets) {
      const pid = String(p.id || p.name);
      map.set(pid, p);
    }
    return Array.from(map.values());
  }, [customPresets]);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        String(g.name || "").toLowerCase().includes(q) ||
        String(g.threadId || g.id || "").toLowerCase().includes(q)
    );
  }, [groups, search]);

  // 1-Click Enable / Disable All Groups
  const handleEnableAllGroups = async (enabled) => {
    if (!activeBot) return;
    setSaving(true);
    try {
      const res = await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/groups/enable-all`, {
        method: "POST",
        body: { enabled },
      });
      if (Array.isArray(res?.groups)) {
        setGroups(res.groups);
      } else {
        await loadGroups(activeBot.id);
      }
      notify(
        enabled
          ? `Đã bật hoạt động Bot trên toàn bộ nhóm của ${activeBot.displayName}!`
          : `Đã tắt Bot trên toàn bộ nhóm của ${activeBot.displayName}!`,
        "success"
      );
    } catch (err) {
      notify(err.message || "Cập nhật hàng loạt thất bại", "error");
    } finally {
      setSaving(false);
    }
  };

  // Save single group settings
  const saveGroupSettings = async (nextSettings) => {
    if (!activeBot || !selectedThreadId) return;
    const payload = {
      ...nextSettings,
      enableBot: Boolean(nextSettings.activeBot),
      activeBot: Boolean(nextSettings.activeBot),
    };
    setSaving(true);
    try {
      await v4Fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/groups/${encodeURIComponent(selectedThreadId)}/settings`,
        {
          method: "PUT",
          body: { settings: payload, ...payload },
        }
      );
      setGroups((prev) =>
        prev.map((g) =>
          String(g.threadId || g.id) === selectedThreadId
            ? { ...g, settings: { ...(g.settings || {}), ...payload }, ...payload }
            : g
        )
      );
      notify(`Đã cập nhật khiên bảo vệ cho "${currentGroup?.name || selectedThreadId}"!`, "success");
    } catch (err) {
      notify(err.message || "Lưu khiên bảo vệ thất bại", "error");
    } finally {
      setSaving(false);
    }
  };

  const toggleShieldKey = (key) => {
    const updated = { ...settings, [key]: !settings[key] };
    setSettings(updated);
    saveGroupSettings(updated);
  };

  const bulkToggle17Shields = (val) => {
    const updated = { ...settings };
    for (const item of ANTI_SHIELDS) updated[item.key] = val;
    setSettings(updated);
    saveGroupSettings(updated);
  };

  // Apply Preset to Current Group or Multi-Selected Groups
  const handleApplyPreset = async (preset) => {
    if (!activeBot) return;
    const targetIds =
      checkedGroupIds.length > 0
        ? checkedGroupIds
        : selectedThreadId
          ? [selectedThreadId]
          : [];
    if (targetIds.length === 0) {
      notify("Hãy chọn một nhóm hoặc tích chọn nhiều nhóm ở cột bên trái trước.", "warning");
      return;
    }

    setSaving(true);
    try {
      await callV5(
        v5Fetch,
        `/bots/${encodeURIComponent(activeBot.id)}/groups/apply-preset`,
        {
          method: "POST",
          body: {
            presetId: preset.id,
            presetName: preset.name,
            threadIds: targetIds,
            settings: preset.settings || {},
            rules: preset.rules || undefined,
          },
        }
      );
      notify(
        `Đã áp dụng bộ mẫu "${preset.name}" cho ${targetIds.length} nhóm!`,
        "success"
      );
      await loadGroups(activeBot.id);
    } catch {
      // Fallback: apply per-group via standard settings endpoint
      try {
        for (const tid of targetIds) {
          await v4Fetch(
            `/api/bots/${encodeURIComponent(activeBot.id)}/groups/${encodeURIComponent(tid)}/settings`,
            {
              method: "PUT",
              body: { settings: preset.settings || {}, ...(preset.settings || {}) },
            }
          );
        }
        notify(`Đã áp dụng bộ mẫu "${preset.name}" cho ${targetIds.length} nhóm!`, "success");
        await loadGroups(activeBot.id);
      } catch (fbErr) {
        notify(fbErr.message || "Áp dụng bộ mẫu thất bại", "error");
      }
    } finally {
      setSaving(false);
    }
  };

  // Save Current Configuration as a New Custom Preset
  const handleCreateCustomPreset = async (e) => {
    e.preventDefault();
    if (!newPresetName.trim()) {
      notify("Vui lòng đặt tên cho Bộ mẫu mới.", "error");
      return;
    }
    try {
      await callV5(v5Fetch, "/shields/presets", {
        method: "POST",
        body: {
          name: newPresetName.trim(),
          description: `Tạo từ cấu hình nhóm ${currentGroup?.name || selectedThreadId || "hiện tại"}`,
          settings,
          rules,
        },
      });
      setNewPresetName("");
      setShowSavePresetModal(false);
      notify("Đã lưu cấu hình hiện tại thành Bộ mẫu Khiên mới!", "success");
      await loadPresets();
    } catch (err) {
      notify(err.message || "Lưu bộ mẫu thất bại", "error");
    }
  };

  // Save Deep Rules for Group
  const handleSaveRules = async (e) => {
    e.preventDefault();
    if (!activeBot || !selectedThreadId) return;
    const parsedBadWords = badWordsInput
      .split(/[,;\n]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    const parsedDomains = domainsInput
      .split(/[,;\n]+/)
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    const nextRules = {
      ...rules,
      badWords: parsedBadWords,
      whitelistedDomains: parsedDomains,
    };

    setSavingRules(true);
    try {
      await callV5(
        v5Fetch,
        `/bots/${encodeURIComponent(activeBot.id)}/groups/${encodeURIComponent(selectedThreadId)}/rules`,
        {
          method: "PUT",
          body: nextRules,
        }
      );
      setRules(nextRules);
      notify(`Đã lưu Luật Chuyên Sâu cho nhóm "${currentGroup?.name || selectedThreadId}"!`, "success");
    } catch (err) {
      notify(err.message || "Lưu luật chuyên sâu thất bại", "error");
    } finally {
      setSavingRules(false);
    }
  };

  // Leave Group
  const handleLeaveGroup = async () => {
    if (!activeBot || !selectedThreadId) return;
    if (
      !window.confirm(
        `Bạn chắc chắn muốn cho Bot "${activeBot.displayName}" rời khỏi nhóm "${currentGroup?.name || selectedThreadId}"?`
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      await v4Fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/groups/${encodeURIComponent(selectedThreadId)}/leave`,
        { method: "POST", body: {} }
      );
      notify("Bot đã rời khỏi nhóm thành công!", "success");
      await loadGroups(activeBot.id);
    } catch (err) {
      notify(err.message || "Rời nhóm thất bại", "error");
    } finally {
      setSaving(false);
    }
  };

  // Clear Violations History
  const handleClearViolations = async () => {
    if (!window.confirm("Xóa toàn bộ lịch sử vi phạm & tin nhắn thu hồi đã lưu?")) return;
    try {
      await callV5(v5Fetch, "/moderation/violations", { method: "DELETE" });
      setViolations([]);
      notify("Đã dọn sạch hộp thư kiểm duyệt.", "info");
    } catch (err) {
      notify(err.message || "Không thể xóa lịch sử vi phạm", "error");
    }
  };

  // Add / Remove Global Blacklist UID
  const handleAddBlacklist = async (e, quickPayload = null) => {
    if (e) e.preventDefault();
    const uid = quickPayload ? String(quickPayload.uid) : blUid.trim();
    const reason = quickPayload ? quickPayload.reason : blReason.trim() || "Vi phạm nội quy hệ thống";
    const scope = quickPayload ? quickPayload.scope || "global" : blScope;
    const name = quickPayload ? quickPayload.name || "" : blName.trim();

    if (!uid) {
      notify("Vui lòng nhập Zalo UID cần chặn.", "error");
      return;
    }
    try {
      await callV5(v5Fetch, "/moderation/blacklist", {
        method: "POST",
        body: {
          uid,
          displayName: name || undefined,
          reason,
          scope,
          botId: scope === "bot" ? activeBot?.id : undefined,
        },
      });
      if (!quickPayload) {
        setBlUid("");
        setBlName("");
        setBlReason("");
      }
      notify(`Đã đưa UID ${uid} vào Danh sách đen (${scope === "global" ? "Toàn cục" : activeBot?.id})!`, "success");
      await loadBlacklist();
    } catch (err) {
      notify(err.message || "Thêm vào danh sách đen thất bại", "error");
    }
  };

  const handleRemoveBlacklist = async (entry) => {
    const uid = String(entry.uid || entry.id);
    const qs = new URLSearchParams();
    if (entry.scope) qs.set("scope", entry.scope);
    if (entry.botId) qs.set("botId", entry.botId);
    try {
      await callV5(
        v5Fetch,
        `/moderation/blacklist/${encodeURIComponent(uid)}${qs.toString() ? `?${qs.toString()}` : ""}`,
        { method: "DELETE" }
      );
      notify(`Đã gỡ UID ${uid} khỏi Danh sách đen.`, "info");
      await loadBlacklist();
    } catch (err) {
      notify(err.message || "Gỡ UID thất bại", "error");
    }
  };

  const filteredBlacklist = useMemo(() => {
    const q = blSearch.trim().toLowerCase();
    if (!q) return blacklist;
    return blacklist.filter(
      (b) =>
        String(b.uid || "").toLowerCase().includes(q) ||
        String(b.displayName || b.name || "").toLowerCase().includes(q) ||
        String(b.reason || "").toLowerCase().includes(q)
    );
  }, [blacklist, blSearch]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top Header & Global Group Controls */}
      <div className="v4-card">
        <div className="v4-card-header" style={{ marginBottom: 12 }}>
          <div>
            <h2>🛡️ Quản Trị An Ninh Nhóm Zalo & 17+ Khiên Bảo Vệ Pro</h2>
            <div className="v4-muted">
              Áp dụng Bộ mẫu (Presets) hàng loạt, tùy chỉnh Luật chuyên sâu từng nhóm, soi tin nhắn thu hồi (Anti-Undo) và chặn UID toàn cục.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              className="v4-select"
              style={{ minWidth: 230 }}
              value={activeBot?.id || ""}
              onChange={(e) => setSelectedBotId(e.target.value)}
            >
              {botList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.isMain ? "★ [ADMIN] " : ""}
                  {b.displayName}
                </option>
              ))}
            </select>

            <button
              type="button"
              className="v4-btn success"
              disabled={loadingGroups || saving || !activeBot}
              onClick={() => handleEnableAllGroups(true)}
            >
              ⚡ Bật Tất Cả Nhóm
            </button>
            <button
              type="button"
              className="v4-btn"
              disabled={loadingGroups || saving || !activeBot}
              onClick={() => handleEnableAllGroups(false)}
            >
              ⏸ Tắt Tất Cả Nhóm
            </button>
            <button
              type="button"
              className="v4-btn"
              disabled={loadingGroups || !activeBot}
              onClick={() => activeBot && loadGroups(activeBot.id)}
            >
              {loadingGroups ? "Đang đồng bộ..." : `↻ Đồng bộ (${groups.length})`}
            </button>
          </div>
        </div>

        <div className="v4-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`v4-tab ${tab === "matrix" ? "active" : ""}`}
            onClick={() => setTab("matrix")}
          >
            🛡️ Ma Trận 17+ Khiên & Bộ Mẫu (Presets)
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "violations" ? "active" : ""}`}
            onClick={() => setTab("violations")}
          >
            🚨 Hộp Thư Kiểm Duyệt & Anti-Undo Vault ({violations.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "blacklist" ? "active" : ""}`}
            onClick={() => setTab("blacklist")}
          >
            🚫 Danh Sách Đen Toàn Cục ({blacklist.length})
          </button>
        </div>
      </div>

      {/* =====================================================================
          SUB-TAB 1: 17+ SHIELDS MATRIX, PRESETS & DEEP GROUP RULES
         ===================================================================== */}
      {tab === "matrix" && (
        <div className="v4-card">
          {/* Preset Toolbar */}
          <div
            className="v4-card"
            style={{
              padding: "12px 14px",
              marginBottom: 16,
              background: "var(--bg-elevated)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700 }}>
                ⚡ Áp dụng nhanh Preset{" "}
                {checkedGroupIds.length > 0 ? (
                  <span className="v4-badge warning">Hàng loạt {checkedGroupIds.length} nhóm đã tích</span>
                ) : (
                  <span className="v4-badge info">Cho nhóm đang chọn</span>
                )}
                :
              </span>

              {allPresets.map((pr) => (
                <button
                  key={pr.id || pr.name}
                  type="button"
                  className="v4-btn sm"
                  disabled={saving}
                  title={pr.description || pr.name}
                  onClick={() => handleApplyPreset(pr)}
                >
                  {pr.name}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="v4-btn sm primary"
              onClick={() => setShowSavePresetModal(true)}
            >
              💾 Lưu Cấu Hình Hiện Tại Thành Preset Mới
            </button>
          </div>

          <div className="v4-grid-2" style={{ gridTemplateColumns: "340px minmax(0, 1fr)" }}>
            {/* Left Sidebar: Searchable Multi-Select Group List */}
            <div style={{ borderRight: "1px solid var(--border)", paddingRight: 14 }}>
              <input
                className="v4-input"
                style={{ marginBottom: 8 }}
                placeholder="Tìm tên nhóm hoặc Thread ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span className="v4-muted" style={{ fontSize: 12 }}>
                  Đã tích chọn: <strong>{checkedGroupIds.length}</strong>/{groups.length}
                </span>
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="v4-btn sm"
                    onClick={() =>
                      setCheckedGroupIds(filteredGroups.map((g) => String(g.threadId || g.id)))
                    }
                  >
                    Tích hết
                  </button>
                  <button
                    type="button"
                    className="v4-btn sm"
                    onClick={() => setCheckedGroupIds([])}
                  >
                    Bỏ tích
                  </button>
                </div>
              </div>

              <div style={{ maxHeight: 640, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {filteredGroups.length === 0 ? (
                  <div className="v4-muted" style={{ padding: 14 }}>
                    Chưa có nhóm nào được ghi nhận cho Bot này.
                  </div>
                ) : (
                  filteredGroups.map((g) => {
                    const gid = String(g.threadId || g.id);
                    const isSelected = gid === selectedThreadId;
                    const isChecked = checkedGroupIds.includes(gid);
                    const botOn = Boolean(
                      g.activeBot ?? g.enableBot ?? g.settings?.activeBot ?? g.settings?.enableBot
                    );

                    return (
                      <div
                        key={gid}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "8px 10px",
                          borderRadius: 10,
                          background: isSelected ? "var(--primary-soft)" : "var(--bg-input)",
                          border: isSelected ? "1px solid var(--border-strong)" : "1px solid var(--border)",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() =>
                            setCheckedGroupIds((prev) =>
                              prev.includes(gid) ? prev.filter((x) => x !== gid) : [...prev, gid]
                            )
                          }
                          title="Tích chọn để áp dụng Preset hàng loạt"
                        />
                        <button
                          type="button"
                          onClick={() => setSelectedThreadId(gid)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            background: "transparent",
                            border: "none",
                            textAlign: "left",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                            <span
                              style={{
                                fontWeight: 700,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {g.name || `Nhóm ${gid}`}
                            </span>
                            <span className={`v4-badge ${botOn ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                              {botOn ? "BẬT" : "TẮT"}
                            </span>
                          </div>
                          <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                            ID: {gid} • {g.memberCount || 0} TV
                          </div>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right Panel: Switches + Deep Rules Drawer */}
            <div>
              {!selectedThreadId ? (
                <div className="v4-muted" style={{ padding: 32, textAlign: "center" }}>
                  Hãy chọn một nhóm ở cột bên trái để thiết lập 17+ khiên chống phá và luật chuyên sâu.
                </div>
              ) : (
                <>
                  <div className="v4-card-header" style={{ marginBottom: 12 }}>
                    <div>
                      <h3 style={{ fontSize: 17 }}>{currentGroup?.name || `Nhóm ${selectedThreadId}`}</h3>
                      <div className="v4-muted v4-mono">
                        Thread ID: {selectedThreadId} • {currentGroup?.memberCount || 0} thành viên
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className={`v4-btn sm ${showRulesDrawer ? "primary" : "accent"}`}
                        onClick={() => setShowRulesDrawer((v) => !v)}
                      >
                        ⚙️ Luật Chuyên Sâu Của Nhóm
                      </button>
                      <button
                        type="button"
                        className="v4-btn sm success"
                        disabled={saving}
                        onClick={() => bulkToggle17Shields(true)}
                      >
                        Bật Tất Cả Khiên
                      </button>
                      <button
                        type="button"
                        className="v4-btn sm"
                        disabled={saving}
                        onClick={() => bulkToggle17Shields(false)}
                      >
                        Tắt Tất Cả Khiên
                      </button>
                      <button
                        type="button"
                        className="v4-btn sm danger"
                        disabled={saving}
                        onClick={handleLeaveGroup}
                      >
                        🚪 Cho Bot Rời Nhóm
                      </button>
                    </div>
                  </div>

                  {/* Deep Group Rules Expandable Drawer */}
                  {showRulesDrawer && (
                    <form
                      onSubmit={handleSaveRules}
                      className="v4-card highlight-admin"
                      style={{ marginBottom: 16, padding: 16 }}
                    >
                      <div className="v4-card-header" style={{ marginBottom: 10 }}>
                        <div>
                          <h3>⚙️ Luật Kiểm Duyệt Chuyên Sâu: {currentGroup?.name}</h3>
                          <div className="v4-muted">
                            Tùy chỉnh danh sách từ cấm, tên miền hợp lệ, ngưỡng chống spam, lời chào và giờ ngủ đêm riêng cho nhóm này.
                          </div>
                        </div>
                        <button type="button" className="v4-btn sm" onClick={() => setShowRulesDrawer(false)}>
                          Thu gọn
                        </button>
                      </div>

                      <div className="v4-grid-2">
                        <div className="v4-field">
                          <label>Danh sách Từ Cấm riêng (ngăn cách bởi dấu phẩy)</label>
                          <textarea
                            className="v4-textarea"
                            rows={2}
                            placeholder="cờ bạc, lừa đảo, tuyển ctv..."
                            value={badWordsInput}
                            onChange={(e) => setBadWordsInput(e.target.value)}
                          />
                        </div>
                        <div className="v4-field">
                          <label>Tên Miền Hợp Lệ / Whitelist Domains (không bị xóa khi bật Anti-Link)</label>
                          <textarea
                            className="v4-textarea v4-mono"
                            rows={2}
                            placeholder="zalo.me, youtube.com, docs.google.com..."
                            value={domainsInput}
                            onChange={(e) => setDomainsInput(e.target.value)}
                          />
                        </div>
                      </div>

                      <div className="v4-grid-3">
                        <div className="v4-field">
                          <label>Ngưỡng Spam: Số tin tối đa</label>
                          <input
                            type="number"
                            min={2}
                            max={50}
                            className="v4-input v4-mono"
                            value={rules.spamThreshold.maxMessages}
                            onChange={(e) =>
                              setRules((r) => ({
                                ...r,
                                spamThreshold: { ...r.spamThreshold, maxMessages: Number(e.target.value) },
                              }))
                            }
                          />
                        </div>
                        <div className="v4-field">
                          <label>Trong khoảng thời gian (giây)</label>
                          <input
                            type="number"
                            min={2}
                            max={120}
                            className="v4-input v4-mono"
                            value={rules.spamThreshold.windowSec}
                            onChange={(e) =>
                              setRules((r) => ({
                                ...r,
                                spamThreshold: { ...r.spamThreshold, windowSec: Number(e.target.value) },
                              }))
                            }
                          />
                        </div>
                        <div className="v4-field">
                          <label>Hình thức xử phạt khi vượt ngưỡng</label>
                          <select
                            className="v4-select"
                            value={rules.spamThreshold.action}
                            onChange={(e) =>
                              setRules((r) => ({
                                ...r,
                                spamThreshold: { ...r.spamThreshold, action: e.target.value },
                              }))
                            }
                          >
                            <option value="warn">⚠️ Nhắc nhở & xóa tin</option>
                            <option value="mute">🔇 Khóa mõm tạm thời (Mute)</option>
                            <option value="kick">🚫 Mời khỏi nhóm (Kick)</option>
                          </select>
                        </div>
                      </div>

                      <div className="v4-grid-2">
                        <div className="v4-field">
                          <label>Mẫu tin Chào mừng thành viên mới (`&#123;memberName&#125;`, `&#123;groupName&#125;`)</label>
                          <input
                            className="v4-input"
                            value={rules.welcomeTemplate}
                            onChange={(e) => setRules((r) => ({ ...r, welcomeTemplate: e.target.value }))}
                          />
                        </div>
                        <div className="v4-field">
                          <label>Mẫu tin Tạm biệt khi rời nhóm</label>
                          <input
                            className="v4-input"
                            value={rules.goodbyeTemplate}
                            onChange={(e) => setRules((r) => ({ ...r, goodbyeTemplate: e.target.value }))}
                          />
                        </div>
                      </div>

                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          flexWrap: "wrap",
                          gap: 12,
                          paddingTop: 6,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className={`v4-switch ${rules.nightMode.enabled ? "on" : ""}`}
                            onClick={() =>
                              setRules((r) => ({
                                ...r,
                                nightMode: { ...r.nightMode, enabled: !r.nightMode.enabled },
                              }))
                            }
                          >
                            <span className="v4-switch-knob" />
                          </button>
                          <span style={{ fontWeight: 600 }}>🌙 Chế độ Ngủ Đêm tự động:</span>
                          <input
                            type="time"
                            className="v4-input v4-mono"
                            style={{ width: 115 }}
                            value={rules.nightMode.startHour}
                            onChange={(e) =>
                              setRules((r) => ({
                                ...r,
                                nightMode: { ...r.nightMode, startHour: e.target.value },
                              }))
                            }
                          />
                          <span>đến</span>
                          <input
                            type="time"
                            className="v4-input v4-mono"
                            style={{ width: 115 }}
                            value={rules.nightMode.endHour}
                            onChange={(e) =>
                              setRules((r) => ({
                                ...r,
                                nightMode: { ...r.nightMode, endHour: e.target.value },
                              }))
                            }
                          />
                        </div>

                        <button type="submit" className="v4-btn success" disabled={savingRules}>
                          {savingRules ? "Đang lưu luật..." : "💾 Lưu Luật Chuyên Sâu"}
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Core Operational Switches */}
                  <div className="v4-nav-group-label" style={{ paddingLeft: 0, marginBottom: 8 }}>
                    Chế Độ Vận Hành Cốt Lõi (6 Công Tắc)
                  </div>
                  <div className="v4-grid-3" style={{ marginBottom: 18 }}>
                    {CORE_SWITCHES.map((sw) => (
                      <div key={sw.key} className="v4-switch-card">
                        <div>
                          <div style={{ fontWeight: 700 }}>{sw.title}</div>
                          <div className="v4-muted" style={{ fontSize: 11.5 }}>
                            {sw.desc}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`v4-switch ${settings[sw.key] ? "on" : ""}`}
                          onClick={() => toggleShieldKey(sw.key)}
                        >
                          <span className="v4-switch-knob" />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* 17+ Anti-Moderation Switches */}
                  <div className="v4-nav-group-label" style={{ paddingLeft: 0, marginBottom: 8 }}>
                    Ma Trận Khiên Chống Phá Hoại & Kiểm Duyệt Tự Động
                  </div>
                  <div className="v4-grid-2">
                    {ANTI_SHIELDS.map((sw) => (
                      <div key={sw.key} className="v4-switch-card">
                        <div>
                          <div style={{ fontWeight: 600 }}>{sw.title}</div>
                          <div className="v4-muted" style={{ fontSize: 11.5 }}>
                            {sw.desc}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`v4-switch ${settings[sw.key] ? "on" : ""}`}
                          onClick={() => toggleShieldKey(sw.key)}
                        >
                          <span className="v4-switch-knob" />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 2: MODERATION INBOX & ANTI-UNDO VAULT
         ===================================================================== */}
      {tab === "violations" && (
        <div className="v4-card">
          <div className="v4-card-header">
            <div>
              <h3>🚨 Hộp Thư Kiểm Duyệt & Kho Lưu Vết Chống Thu Hồi (Anti-Undo Vault)</h3>
              <div className="v4-muted">
                Lưu trữ các tin nhắn bị thu hồi, link quảng cáo bị chặn và hành vi vi phạm để Quản trị viên đối chiếu bằng chứng.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" className="v4-btn sm" onClick={loadViolations} disabled={loadingViolations}>
                {loadingViolations ? "Đang tải..." : "↻ Làm mới"}
              </button>
              <button
                type="button"
                className="v4-btn sm danger"
                disabled={violations.length === 0}
                onClick={handleClearViolations}
              >
                🧹 Xóa Lịch Sử
              </button>
            </div>
          </div>

          <div className="v4-toolbar">
            <select
              className="v4-select"
              style={{ width: 220 }}
              value={violationShieldFilter}
              onChange={(e) => setViolationShieldFilter(e.target.value)}
            >
              <option value="ALL">Mọi loại khiên vi phạm</option>
              <option value="antiUndo">🕵️ Thu hồi tin nhắn (Anti-Undo)</option>
              <option value="antiSpam">⚡ Spam tin nhắn liên tục</option>
              <option value="removeLinks">🔗 Rải Link lạ / Quảng cáo</option>
              <option value="filterBadWords">🤬 Từ ngữ thô tục</option>
              <option value="antiNude">🔞 Hình ảnh nhạy cảm</option>
              <option value="antiFile">📁 Tệp đính kèm nguy hiểm</option>
            </select>

            <select
              className="v4-select"
              style={{ width: 240 }}
              value={violationGroupFilter}
              onChange={(e) => setViolationGroupFilter(e.target.value)}
            >
              <option value="ALL">Tất cả nhóm của Bot</option>
              {groups.map((g) => {
                const gid = String(g.threadId || g.id);
                return (
                  <option key={gid} value={gid}>
                    {g.name || `Nhóm ${gid}`}
                  </option>
                );
              })}
            </select>
          </div>

          {violations.length === 0 ? (
            <div className="v4-muted" style={{ padding: 28, textAlign: "center" }}>
              Hiện chưa có bản ghi vi phạm hoặc tin nhắn thu hồi nào khớp bộ lọc.
            </div>
          ) : (
            <div className="v4-table-wrap">
              <table className="v4-table">
                <thead>
                  <tr>
                    <th>Thời gian</th>
                    <th>Nhóm</th>
                    <th>Người vi phạm</th>
                    <th>Loại Khiên</th>
                    <th>Nội dung chụp lại (Snapshot)</th>
                    <th>Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {violations.map((v, idx) => {
                    const senderUid = v.senderUid || v.uid || v.userId || "";
                    return (
                      <tr key={v.id || idx}>
                        <td className="v4-mono" style={{ whiteSpace: "nowrap" }}>
                          {formatDateVi(v.timestamp || v.createdAt)}
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{v.groupName || v.threadId || "--"}</div>
                          <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                            {v.threadId}
                          </div>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600 }}>{v.senderName || "Thành viên"}</div>
                          <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                            UID: {senderUid || "--"}
                          </div>
                        </td>
                        <td>
                          <span className={`v4-badge ${v.shieldType === "antiUndo" ? "warning" : "danger"}`}>
                            {v.shieldType || v.type || "shield"}
                          </span>
                        </td>
                        <td style={{ maxWidth: 380, wordBreak: "break-word" }}>
                          <div>{v.content || v.message || v.snapshot || "(Đính kèm Media / Thu hồi)"}</div>
                          {v.mediaUrl && (
                            <a
                              href={v.mediaUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: "var(--primary)", fontSize: 12 }}
                            >
                              🔗 Mở Media chụp lại
                            </a>
                          )}
                        </td>
                        <td>
                          {senderUid && (
                            <button
                              type="button"
                              className="v4-btn sm danger"
                              onClick={() =>
                                handleAddBlacklist(null, {
                                  uid: senderUid,
                                  name: v.senderName,
                                  reason: `Vi phạm ${v.shieldType || "khiên"} tại nhóm ${v.groupName || v.threadId}`,
                                  scope: "global",
                                })
                              }
                            >
                              🚫 Chặn UID
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          SUB-TAB 3: GLOBAL UID BLACKLIST
         ===================================================================== */}
      {tab === "blacklist" && (
        <div className="v4-grid-2" style={{ gridTemplateColumns: "380px minmax(0, 1fr)" }}>
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>🚫 Thêm Zalo UID Vào Danh Sách Đen</h3>
                <div className="v4-muted">
                  Tự động từ chối lệnh hoặc kick ngay khi đối tượng phá hoại xuất hiện trong các nhóm được bảo vệ.
                </div>
              </div>
            </div>

            <form onSubmit={handleAddBlacklist}>
              <div className="v4-field">
                <label>Zalo UID đối tượng cần chặn</label>
                <input
                  className="v4-input v4-mono"
                  placeholder="VD: 100029384756..."
                  value={blUid}
                  onChange={(e) => setBlUid(e.target.value)}
                />
              </div>

              <div className="v4-field">
                <label>Tên gợi nhớ / Tên Zalo (Tùy chọn)</label>
                <input
                  className="v4-input"
                  placeholder="Tên tài khoản spam..."
                  value={blName}
                  onChange={(e) => setBlName(e.target.value)}
                />
              </div>

              <div className="v4-field">
                <label>Phạm vi áp dụng</label>
                <select
                  className="v4-select"
                  value={blScope}
                  onChange={(e) => setBlScope(e.target.value)}
                >
                  <option value="global">🌐 Toàn hệ thống (Mọi Bot đều chặn)</option>
                  <option value="bot">🤖 Chỉ riêng Bot đang chọn ({activeBot?.displayName || "admin"})</option>
                </select>
              </div>

              <div className="v4-field">
                <label>Lý do đưa vào danh sách đen</label>
                <textarea
                  className="v4-textarea"
                  rows={3}
                  placeholder="VD: Rải link lừa đảo hàng loạt, bot clone phá nhóm..."
                  value={blReason}
                  onChange={(e) => setBlReason(e.target.value)}
                />
              </div>

              <button type="submit" className="v4-btn danger" style={{ width: "100%" }}>
                🚫 Đưa Vào Danh Sách Đen Ngay
              </button>
            </form>
          </div>

          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>Danh Sách UID Đang Bị Chặn ({filteredBlacklist.length})</h3>
                <div className="v4-muted">Đồng bộ tức thì tới bộ lọc an ninh của toàn đội hình Bot</div>
              </div>
              <input
                className="v4-input"
                style={{ maxWidth: 240 }}
                placeholder="Tìm UID hoặc lý do..."
                value={blSearch}
                onChange={(e) => setBlSearch(e.target.value)}
              />
            </div>

            {loadingBlacklist ? (
              <div className="v4-muted" style={{ padding: 20 }}>Đang tải danh sách đen...</div>
            ) : filteredBlacklist.length === 0 ? (
              <div className="v4-muted" style={{ padding: 28, textAlign: "center" }}>
                Danh sách đen đang trống.
              </div>
            ) : (
              <div className="v4-table-wrap">
                <table className="v4-table">
                  <thead>
                    <tr>
                      <th>Zalo UID</th>
                      <th>Tên / Ghi chú</th>
                      <th>Phạm vi</th>
                      <th>Lý do chặn</th>
                      <th>Thời gian</th>
                      <th>Gỡ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBlacklist.map((item, idx) => (
                      <tr key={`${item.uid}_${idx}`}>
                        <td className="v4-mono" style={{ fontWeight: 700 }}>{item.uid}</td>
                        <td>{item.displayName || item.name || "--"}</td>
                        <td>
                          <span className={`v4-badge ${item.scope === "global" || !item.scope ? "danger" : "warning"}`}>
                            {item.scope === "global" || !item.scope ? "Toàn cục" : `Bot: ${item.botId}`}
                          </span>
                        </td>
                        <td>{item.reason || "--"}</td>
                        <td className="v4-mono">{formatDateVi(item.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="v4-btn sm"
                            onClick={() => handleRemoveBlacklist(item)}
                          >
                            Gỡ chặn
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Save Custom Shield Preset */}
      {showSavePresetModal && (
        <div className="v4-modal-backdrop" onClick={() => setShowSavePresetModal(false)}>
          <div className="v4-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>💾 Lưu Cấu Hình Thành Preset Mới</h3>
                <div className="v4-muted">
                  Lưu toàn bộ 17+ công tắc và luật hiện tại để tái sử dụng 1-Click cho các nhóm khác.
                </div>
              </div>
              <button type="button" className="v4-btn sm" onClick={() => setShowSavePresetModal(false)}>
                ✕
              </button>
            </div>
            <form onSubmit={handleCreateCustomPreset}>
              <div className="v4-field">
                <label>Tên Bộ Mẫu (Preset)</label>
                <input
                  className="v4-input"
                  placeholder="VD: Nhóm VIP Khách Hàng Thân Thiết"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  autoFocus
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="v4-btn" onClick={() => setShowSavePresetModal(false)}>
                  Hủy
                </button>
                <button type="submit" className="v4-btn primary">
                  💾 Lưu Preset
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
