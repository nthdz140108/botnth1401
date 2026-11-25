import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useV5 } from "../v5-store.jsx";
import { formatBytesVi, formatDateVi, v4Fetch } from "../../v4/http.js";

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

const SPINTAX_CHIPS = [
  { label: "{groupName}", insert: "{groupName}" },
  { label: "{memberCount}", insert: "{memberCount}" },
  { label: "{botName}", insert: "{botName}" },
  { label: "{time}", insert: "{time}" },
  { label: "{date}", insert: "{date}" },
  { label: "🎲 Chào hỏi ngẫu nhiên", insert: "{Chào cả nhà|Xin chào anh chị em|Chúc ngày mới tốt lành}" },
  { label: "🎲 Kêu gọi tương tác", insert: "{Mọi người thả tim nhé ❤️|Cả nhóm tương tác vui vẻ nha 🔥|Chúc cả nhà nhiều năng lượng ✨}" },
];

const QUICK_MACROS = [
  { label: "📋 Menu Tổng Hợp", cmd: "menu" },
  { label: "🟢 Bật Bot Trong Nhóm", cmd: "bot on" },
  { label: "📊 Chi Tiết Hệ Thống", cmd: "detail" },
  { label: "👥 Thông Tin Nhóm", cmd: "group" },
  { label: "🏆 Top Tương Tác", cmd: "topchat" },
  { label: "🌤 Thời Tiết Hà Nội", cmd: "thoitiet Hà Nội" },
  { label: "🛡️ Bật Khiên Tiêu Chuẩn", cmd: "antisetup on" },
  { label: "📅 Lịch Âm Hôm Nay", cmd: "lich" },
  { label: "🪪 Hồ Sơ Bot", cmd: "showinfo" },
];

const PERSONA_PRESETS = [
  {
    id: "pro",
    label: "💼 Trợ lý Chuyên nghiệp",
    icon: "💼",
    color: "0084ff",
    description: "Trợ lý quản trị nhóm lịch sự, ngắn gọn, chính xác, ưu tiên thông tin rõ ràng và chuyên nghiệp.",
    botInfo: "Hệ thống trợ lý điều hành nhóm tự động 24/7.",
  },
  {
    id: "genz",
    label: "🔥 GenZ Hài hước",
    icon: "🔥",
    color: "ff69b4",
    description: "Tính cách trẻ trung, năng động, dí dỏm kiểu GenZ, dùng từ ngữ thân thiện giúp khuấy động phong trào nhóm.",
    botInfo: "Bot giải trí & khuấy động tương tác siêu cấp vui nhộn!",
  },
  {
    id: "sales",
    label: "💎 CSKH Bán hàng",
    icon: "💎",
    color: "f7b503",
    description: "Chuyên viên chăm sóc khách hàng tận tâm, nhiệt tình tư vấn sản phẩm, chốt đơn khéo léo và chu đáo.",
    botInfo: "Trợ lý CSKH & Thông báo ưu đãi chính thức của cửa hàng.",
  },
  {
    id: "guard",
    label: "🛡️ Quản gia Nghiêm túc",
    icon: "🛡️",
    color: "15a85f",
    description: "Quản trị viên kỷ luật, giữ gìn nội quy nhóm nghiêm ngặt, nhắc nhở văn minh khi có vi phạm.",
    botInfo: "Khiên bảo vệ an ninh & kiểm duyệt nội quy tự động.",
  },
];

const STYLE_COLORS = [
  { hex: "db342e", label: "Đỏ nổi bật" },
  { hex: "15a85f", label: "Xanh ngọc" },
  { hex: "f7b503", label: "Vàng kim" },
  { hex: "0084ff", label: "Xanh Zalo" },
  { hex: "ff69b4", label: "Hồng phấn" },
  { hex: "8a2be2", label: "Tím hoàng gia" },
  { hex: "00ffff", label: "Xanh Cyan" },
  { hex: "ffa500", label: "Cam rực" },
];

const STYLE_TYPES = [
  { id: "bold", label: "In đậm (B)" },
  { id: "italic", label: "In nghiêng (I)" },
  { id: "underline", label: "Gạch chân (U)" },
  { id: "strike", label: "Gạch ngang (S)" },
  { id: "none", label: "Bình thường" },
];

function computeLocalSpintaxPreview(rawTemplate, sampleVars) {
  const tpl = String(rawTemplate || "");
  const regex = /\{([^{}]*\|[^{}]*)\}/g;
  let combinations = 1;
  let match;
  while ((match = regex.exec(tpl)) !== null) {
    const parts = match[1].split("|").filter(Boolean);
    if (parts.length > 1) combinations *= parts.length;
  }
  const renderOnce = () => {
    let out = tpl.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, group) => {
      const choices = group.split("|");
      return choices[Math.floor(Math.random() * choices.length)] || "";
    });
    const vars = {
      groupName: sampleVars?.groupName || "Cộng Đồng VIP",
      memberCount: String(sampleVars?.memberCount || 256),
      botName: sampleVars?.botName || "MyBot V5",
      time: new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }),
      date: new Date().toLocaleDateString("vi-VN"),
    };
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
    return out;
  };
  return {
    totalCombinations: combinations,
    samples: [renderOnce(), renderOnce(), renderOnce()],
  };
}

function formatFileSizeSmart(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return "0 KB";
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
  return formatBytesVi(b);
}

const CAMPAIGN_STATUS_META = {
  running: { label: "Đang chạy", badge: "info" },
  paused: { label: "Tạm dừng", badge: "warning" },
  scheduled: { label: "Đã hẹn giờ", badge: "accent" },
  completed: { label: "Hoàn tất", badge: "success" },
  cancelled: { label: "Đã hủy", badge: "neutral" },
  failed: { label: "Có lỗi", badge: "danger" },
};

export default function CampaignOmnichannelPage() {
  const {
    bots = [],
    enrichedFleet = [],
    selectedBotId,
    setSelectedBotId,
    broadcastProgress,
    notify,
    v5Fetch,
  } = useV5();

  const botList = enrichedFleet?.length ? enrichedFleet : bots;
  const activeBot = useMemo(
    () => botList.find((b) => b.id === selectedBotId) || botList[0] || null,
    [botList, selectedBotId]
  );

  const [tab, setTab] = useState("campaign");

  // Targets (Groups & Friends)
  const [groups, setGroups] = useState([]);
  const [friends, setFriends] = useState([]);
  const [loadingTargets, setLoadingTargets] = useState(false);

  // Tab 1: Campaign Studio state
  const [campaignName, setCampaignName] = useState("");
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedGroupIds, setSelectedGroupIds] = useState([]);
  const [campaignText, setCampaignText] = useState(
    "{Chào cả nhà|Xin chào|Chúc ngày mới} nhóm {groupName} ({memberCount} thành viên)!"
  );
  const [campaignMediaUrl, setCampaignMediaUrl] = useState("");
  const [minDelaySec, setMinDelaySec] = useState(4);
  const [maxDelaySec, setMaxDelaySec] = useState(10);
  const [restEveryNGroups, setRestEveryNGroups] = useState(15);
  const [restDurationSec, setRestDurationSec] = useState(20);
  const [scheduledAt, setScheduledAt] = useState("");
  const [spintaxPreview, setSpintaxPreview] = useState(null);
  const [previewingSpintax, setPreviewingSpintax] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [newTemplateTitle, setNewTemplateTitle] = useState("");
  const [campaigns, setCampaigns] = useState([]);
  const [launchingCampaign, setLaunchingCampaign] = useState(false);
  const [showMediaPickerTarget, setShowMediaPickerTarget] = useState(""); // "" | "campaign" | "direct"

  // Tab 2: Media Library state
  const [mediaItems, setMediaItems] = useState([]);
  const [mediaFilter, setMediaFilter] = useState("ALL");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Tab 3: Direct Send & Bot Persona / Style state
  const [targetType, setTargetType] = useState("group");
  const [directThreadId, setDirectThreadId] = useState("");
  const [directText, setDirectText] = useState("");
  const [directMediaUrl, setDirectMediaUrl] = useState("");
  const [directMediaType, setDirectMediaType] = useState("auto");
  const [directTtlSecs, setDirectTtlSecs] = useState(0);
  const [sendingDirect, setSendingDirect] = useState(false);

  const [profileLoading, setProfileLoading] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingStyle, setSavingStyle] = useState(false);
  const [profileRevision, setProfileRevision] = useState(null);
  const [personaForm, setPersonaForm] = useState({
    nameServer: "MyBot V5",
    ownerName: "Admin",
    description: "",
    botInfo: "",
  });
  const [styleForm, setStyleForm] = useState({
    icon: "🤖",
    color: "db342e",
    sizeNameServer: 18,
    sizeText: 14,
    typeNameServer: "bold",
    typeText: "none",
  });

  // Tab 4: Remote 218-Command Web Console state
  const [catalogCommands, setCatalogCommands] = useState([]);
  const [cmdInput, setCmdInput] = useState("menu");
  const [cmdThreadId, setCmdThreadId] = useState("web_remote_console");
  const [deliverToZalo, setDeliverToZalo] = useState(false);
  const [runningCmd, setRunningCmd] = useState(false);
  const [cmdOutput, setCmdOutput] = useState(null);
  const [cmdHistory, setCmdHistory] = useState([]);

  // Sync Groups & Friends for selected bot
  const loadTargets = useCallback(
    async (botId, showToast = false) => {
      if (!botId) return;
      setLoadingTargets(true);
      try {
        const [gRes, fRes] = await Promise.all([
          v4Fetch(`/api/bots/${encodeURIComponent(botId)}/groups`).catch(() => null),
          v4Fetch(`/api/bots/${encodeURIComponent(botId)}/friends`).catch(() => null),
        ]);
        const gList = Array.isArray(gRes) ? gRes : Array.isArray(gRes?.groups) ? gRes.groups : [];
        const fList = Array.isArray(fRes) ? fRes : Array.isArray(fRes?.friends) ? fRes.friends : [];
        setGroups(gList);
        setFriends(fList);
        if (gList.length > 0) {
          const firstGid = String(gList[0].threadId || gList[0].id || "");
          setDirectThreadId((curr) => curr || firstGid);
        }
        if (showToast) {
          notify(`Đã đồng bộ ${gList.length} nhóm và ${fList.length} bạn bè của ${botId}.`, "info");
        }
      } finally {
        setLoadingTargets(false);
      }
    },
    [notify]
  );

  // Load Campaigns & Saved Templates
  const loadCampaignsAndTemplates = useCallback(async () => {
    const [campRes, tplRes] = await Promise.all([
      callV5(v5Fetch, "/campaigns").catch(() => null),
      callV5(v5Fetch, "/campaigns/templates").catch(() => null),
    ]);
    if (campRes) {
      const list = Array.isArray(campRes)
        ? campRes
        : Array.isArray(campRes.campaigns)
          ? campRes.campaigns
          : Array.isArray(campRes.items)
            ? campRes.items
            : [];
      setCampaigns(list);
    }
    if (tplRes) {
      const tList = Array.isArray(tplRes)
        ? tplRes
        : Array.isArray(tplRes.templates)
          ? tplRes.templates
          : Array.isArray(tplRes.items)
            ? tplRes.items
            : [];
      setTemplates(tList);
    }
  }, [v5Fetch]);

  // Load Internal Media Library
  const loadMediaLibrary = useCallback(async () => {
    try {
      const res = await callV5(v5Fetch, "/media");
      const list = Array.isArray(res)
        ? res
        : Array.isArray(res?.assets)
          ? res.assets
          : Array.isArray(res?.items)
            ? res.items
            : Array.isArray(res?.media)
              ? res.media
              : Array.isArray(res?.files)
                ? res.files
                : [];
      setMediaItems(list);
    } catch {
      // ignore if empty or unavailable
    }
  }, [v5Fetch]);

  // Load Bot Profile & AI Style
  const loadBotProfile = useCallback(async (botId) => {
    if (!botId) return;
    setProfileLoading(true);
    try {
      const prof = await v4Fetch(`/api/bots/${encodeURIComponent(botId)}/profile`);
      if (prof && typeof prof === "object") {
        setProfileRevision(prof.revision ?? null);
        setPersonaForm({
          nameServer: prof.nameServer || "MyBot V5",
          ownerName: prof.ownerName || "Admin",
          description: prof.description || "",
          botInfo: prof.botInfo || "",
        });
        const st = prof.style || {};
        const nsType = Array.isArray(st.type?.nameServer) ? st.type.nameServer[0] : st.type?.nameServer;
        const txType = Array.isArray(st.type?.text) ? st.type.text[0] : st.type?.text;
        setStyleForm({
          icon: st.icon || "🤖",
          color: String(st.color || "db342e").replace(/^#/, ""),
          sizeNameServer: Number(st.size?.nameServer || 18),
          sizeText: Number(st.size?.text || 14),
          typeNameServer: nsType || "bold",
          typeText: txType || "none",
        });
      }
    } catch {
      // keep defaults if profile not initialized
    } finally {
      setProfileLoading(false);
    }
  }, []);

  // Load 218-Command Catalog from fixed endpoint `/api/command-studio/catalog`
  useEffect(() => {
    v4Fetch("/api/command-studio/catalog")
      .then((res) => {
        const list = Array.isArray(res?.commands) ? res.commands : Array.isArray(res) ? res : [];
        setCatalogCommands(list);
      })
      .catch(() => {});
    loadCampaignsAndTemplates();
    loadMediaLibrary();
  }, [loadCampaignsAndTemplates, loadMediaLibrary]);

  useEffect(() => {
    if (activeBot?.id) {
      loadTargets(activeBot.id, false);
      loadBotProfile(activeBot.id);
    }
  }, [activeBot?.id, loadTargets, loadBotProfile]);

  // Auto-poll active campaigns while any campaign is running/scheduled
  const hasActiveCampaign = useMemo(
    () => campaigns.some((c) => c.status === "running" || c.status === "scheduled"),
    [campaigns]
  );

  useEffect(() => {
    if (!hasActiveCampaign && tab !== "campaign") return undefined;
    const timer = setInterval(() => {
      loadCampaignsAndTemplates();
    }, 3500);
    return () => clearInterval(timer);
  }, [hasActiveCampaign, tab, loadCampaignsAndTemplates]);

  const filteredGroups = useMemo(() => {
    const q = groupSearch.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        String(g.name || "").toLowerCase().includes(q) ||
        String(g.threadId || g.id || "").toLowerCase().includes(q)
    );
  }, [groups, groupSearch]);

  const toggleGroupSelection = (gid) => {
    setSelectedGroupIds((prev) =>
      prev.includes(gid) ? prev.filter((x) => x !== gid) : [...prev, gid]
    );
  };

  // Preview Spintax
  const handlePreviewSpintax = async () => {
    if (!campaignText.trim()) {
      notify("Vui lòng nhập nội dung Spintax trước khi xem biến thể.", "warning");
      return;
    }
    setPreviewingSpintax(true);
    const sampleGroup = groups.find((g) => selectedGroupIds.includes(String(g.threadId || g.id))) || groups[0];
    const sampleVars = {
      groupName: sampleGroup?.name || "Cộng Đồng Zalo VIP",
      memberCount: sampleGroup?.memberCount || 188,
      botName: activeBot?.displayName || "MyBot V5",
    };
    try {
      const res = await callV5(v5Fetch, "/campaigns/preview-spintax", {
        method: "POST",
        body: {
          template: campaignText,
          text: campaignText,
          vars: sampleVars,
          sampleGroup: sampleVars,
          count: 3,
        },
      });
      const fallback = computeLocalSpintaxPreview(campaignText, sampleVars);
      setSpintaxPreview({
        totalCombinations:
          res?.totalCombinations ?? res?.combinations ?? res?.total ?? fallback.totalCombinations,
        samples:
          Array.isArray(res?.samples) && res.samples.length > 0
            ? res.samples.slice(0, 3)
            : fallback.samples,
      });
    } catch {
      setSpintaxPreview(computeLocalSpintaxPreview(campaignText, sampleVars));
    } finally {
      setPreviewingSpintax(false);
    }
  };

  // Save Campaign Template
  const handleSaveTemplate = async () => {
    const name = newTemplateTitle.trim() || campaignName.trim() || `Mẫu chiến dịch ${templates.length + 1}`;
    if (!campaignText.trim()) {
      notify("Nội dung mẫu không được để trống.", "error");
      return;
    }
    try {
      await callV5(v5Fetch, "/campaigns/templates", {
        method: "POST",
        body: {
          name,
          title: name,
          template: campaignText,
          text: campaignText,
          mediaUrl: campaignMediaUrl.trim() || "",
        },
      });
      setNewTemplateTitle("");
      notify(`Đã lưu mẫu chiến dịch "${name}"!`, "success");
      await loadCampaignsAndTemplates();
    } catch (err) {
      notify(err.message || "Không thể lưu mẫu chiến dịch", "error");
    }
  };

  const handleApplyTemplate = (tplId) => {
    setSelectedTemplateId(tplId);
    const found = templates.find((t) => String(t.id || t.name) === String(tplId));
    if (found) {
      setCampaignText(found.template || found.text || "");
      if (found.mediaUrl !== undefined) setCampaignMediaUrl(found.mediaUrl || "");
      notify(`Đã nạp mẫu "${found.name || found.title}"`, "info");
    }
  };

  const handleDeleteTemplate = async (tplId) => {
    if (!tplId) return;
    try {
      await callV5(v5Fetch, `/campaigns/templates/${encodeURIComponent(tplId)}`, {
        method: "DELETE",
      });
      setSelectedTemplateId("");
      notify("Đã xóa mẫu chiến dịch.", "info");
      await loadCampaignsAndTemplates();
    } catch (err) {
      notify(err.message || "Xóa mẫu thất bại", "error");
    }
  };

  // Launch Anti-Ban Campaign
  const handleLaunchCampaign = async (e) => {
    e.preventDefault();
    if (!activeBot) return;
    if (selectedGroupIds.length === 0) {
      notify("Vui lòng tích chọn ít nhất 1 nhóm nhận chiến dịch.", "error");
      return;
    }
    if (!campaignText.trim() && !campaignMediaUrl.trim()) {
      notify("Vui lòng nhập nội dung Spintax hoặc đính kèm Media.", "error");
      return;
    }
    const minD = Math.max(1, Number(minDelaySec) || 4);
    const maxD = Math.max(minD, Number(maxDelaySec) || 10);
    setLaunchingCampaign(true);
    try {
      const selectedGroupsMeta = groups
        .filter((g) => selectedGroupIds.includes(String(g.threadId || g.id)))
        .map((g) => ({
          threadId: String(g.threadId || g.id),
          name: g.name || `Nhóm ${g.threadId || g.id}`,
          memberCount: Number(g.memberCount || 0),
        }));
      const groupNamesMap = Object.fromEntries(
        selectedGroupsMeta.map((g) => [g.threadId, g.name])
      );
      const restSec = Math.max(0, Number(restDurationSec) || 0);

      await callV5(v5Fetch, "/campaigns", {
        method: "POST",
        body: {
          name: campaignName.trim() || `Chiến dịch ${new Date().toLocaleTimeString("vi-VN")}`,
          botId: activeBot.id,
          threadIds: selectedGroupIds,
          groupNamesMap,
          targets: selectedGroupsMeta,
          groups: selectedGroupsMeta,
          textSpintax: campaignText,
          template: campaignText,
          text: campaignText,
          mediaUrl: campaignMediaUrl.trim() || undefined,
          minDelaySec: minD,
          maxDelaySec: maxD,
          minDelayMs: minD * 1000,
          maxDelayMs: maxD * 1000,
          restEveryNGroups: Math.max(1, Number(restEveryNGroups) || 15),
          restDurationSec: restSec,
          restDurationMs: restSec * 1000,
          pacing: {
            minDelaySec: minD,
            maxDelaySec: maxD,
            restEveryNGroups: Math.max(1, Number(restEveryNGroups) || 15),
            restDurationSec: restSec,
          },
          scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : undefined,
        },
      });

      notify(
        scheduledAt
          ? `Đã lên lịch chiến dịch cho ${selectedGroupIds.length} nhóm!`
          : `Đã khởi chạy chiến dịch chống khóa tới ${selectedGroupIds.length} nhóm!`,
        "success"
      );
      setCampaignName("");
      await loadCampaignsAndTemplates();
    } catch (err) {
      // Fallback to V4 broadcast if V5 campaign engine returns 404
      if (err.status === 404) {
        try {
          await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/remote/broadcast`, {
            method: "POST",
            body: {
              threadIds: selectedGroupIds,
              text: campaignText,
              mediaUrl: campaignMediaUrl.trim() || undefined,
              delayMs: minD * 1000,
            },
          });
          notify(`Đã phát Broadcast giãn cách tới ${selectedGroupIds.length} nhóm!`, "success");
          return;
        } catch (fbErr) {
          notify(fbErr.message || "Khởi chạy Broadcast thất bại", "error");
          return;
        }
      }
      notify(err.message || "Không thể khởi chạy chiến dịch", "error");
    } finally {
      setLaunchingCampaign(false);
    }
  };

  // Campaign lifecycle actions: pause, resume, retry-failed, cancel
  const handleCampaignAction = async (campaignId, action) => {
    try {
      await callV5(
        v5Fetch,
        `/campaigns/${encodeURIComponent(campaignId)}/${encodeURIComponent(action)}`,
        { method: "POST", body: {} }
      );
      const actionLabels = {
        pause: "Tạm dừng chiến dịch",
        resume: "Tiếp tục chạy chiến dịch",
        "retry-failed": "Gửi lại các nhóm lỗi",
        cancel: "Hủy chiến dịch",
      };
      notify(`Đã thực hiện: ${actionLabels[action] || action}!`, "success");
      await loadCampaignsAndTemplates();
    } catch (err) {
      notify(err.message || `Thao tác ${action} thất bại`, "error");
    }
  };

  // Media Upload (Drag & Drop + FileReader.readAsDataURL)
  const uploadFilesToMediaVault = async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;
    setUploadingMedia(true);
    let uploadedCount = 0;
    try {
      for (const file of files) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error(`Không đọc được tệp ${file.name}`));
          reader.readAsDataURL(file);
        });
        await callV5(v5Fetch, "/media", {
          method: "POST",
          body: {
            filename: file.name,
            name: file.name,
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            sizeBytes: file.size,
            dataBase64: dataUrl,
            dataUrl,
            content: dataUrl,
          },
        });
        uploadedCount += 1;
      }
      notify(`Đã tải lên thành công ${uploadedCount} tệp vào Kho Media Nội Bộ!`, "success");
      await loadMediaLibrary();
    } catch (err) {
      notify(err.message || "Tải tệp lên Kho Media thất bại", "error");
    } finally {
      setUploadingMedia(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDeleteMedia = async (mediaId) => {
    if (!window.confirm("Bạn chắc chắn muốn xóa tệp media này khỏi kho nội bộ?")) return;
    try {
      await callV5(v5Fetch, `/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" });
      notify("Đã xóa tệp khỏi Kho Media.", "info");
      await loadMediaLibrary();
    } catch (err) {
      notify(err.message || "Xóa tệp media thất bại", "error");
    }
  };

  const resolveMediaUrl = (item) => {
    const raw =
      item?.url ||
      item?.publicUrl ||
      item?.path ||
      item?.dataUrl ||
      (item?.id ? `/api/v5/media/${encodeURIComponent(item.id)}/raw` : "");
    if (!raw) return "";
    if (raw.startsWith("http") || raw.startsWith("data:") || raw.startsWith("/")) {
      return raw.startsWith("/") && typeof window !== "undefined"
        ? `${window.location.origin}${raw}`
        : raw;
    }
    return raw;
  };

  const filteredMedia = useMemo(() => {
    if (mediaFilter === "ALL") return mediaItems;
    return mediaItems.filter((item) => {
      const mime = String(item.mimeType || item.type || "").toLowerCase();
      return mime.includes(mediaFilter.toLowerCase());
    });
  }, [mediaItems, mediaFilter]);

  // Direct Single Message Send
  const handleSendDirect = async (e) => {
    e.preventDefault();
    if (!activeBot) return;
    if (!directThreadId.trim()) {
      notify("Vui lòng chọn Nhóm / Bạn bè hoặc nhập Thread ID / UID.", "error");
      return;
    }
    if (!directText.trim() && !directMediaUrl.trim()) {
      notify("Vui lòng nhập nội dung tin nhắn hoặc đính kèm Media.", "error");
      return;
    }
    setSendingDirect(true);
    try {
      await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/remote/send-message`, {
        method: "POST",
        body: {
          threadId: directThreadId.trim(),
          threadType: targetType,
          targetType,
          text: directText,
          mediaUrl: directMediaUrl.trim() || undefined,
          mediaType: directMediaType,
          ttlMs: Number(directTtlSecs) > 0 ? Number(directTtlSecs) * 1000 : undefined,
        },
      });
      notify("Đã gửi tin nhắn trực tiếp thành công!", "success");
      setDirectText("");
    } catch (err) {
      notify(err.message || "Gửi tin nhắn đơn lẻ thất bại", "error");
    } finally {
      setSendingDirect(false);
    }
  };

  // Save Bot Profile & Persona
  const handleSaveProfile = async (e) => {
    e.preventDefault();
    if (!activeBot) return;
    if (!personaForm.nameServer.trim()) {
      notify("Tên thương hiệu / máy chủ Bot (nameServer) không được để trống.", "error");
      return;
    }
    setSavingProfile(true);
    try {
      const updated = await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/profile`, {
        method: "PUT",
        body: {
          nameServer: personaForm.nameServer.trim(),
          ownerName: personaForm.ownerName.trim() || "Admin",
          description: personaForm.description.trim(),
          botInfo: personaForm.botInfo.trim(),
          ...(profileRevision !== null ? { expectedRevision: profileRevision } : {}),
        },
      });
      if (updated?.revision !== undefined) setProfileRevision(updated.revision);
      notify(`Đã cập nhật Hồ sơ & Tính cách AI cho ${activeBot.displayName}!`, "success");
    } catch (err) {
      if (err.code === "REVISION_CONFLICT") {
        await loadBotProfile(activeBot.id);
      }
      notify(err.message || "Lưu hồ sơ tính cách Bot thất bại", "error");
    } finally {
      setSavingProfile(false);
    }
  };

  // Save Bot Style
  const handleSaveStyle = async (e) => {
    if (e) e.preventDefault();
    if (!activeBot) return;
    setSavingStyle(true);
    try {
      const updated = await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/style`, {
        method: "PUT",
        body: {
          style: {
            icon: styleForm.icon.trim() || "🤖",
            color: styleForm.color.replace(/^#/, "") || "db342e",
            size: {
              nameServer: Math.min(24, Math.max(10, Number(styleForm.sizeNameServer) || 18)),
              text: Math.min(24, Math.max(10, Number(styleForm.sizeText) || 14)),
            },
            type: {
              nameServer: [styleForm.typeNameServer || "bold"],
              text: [styleForm.typeText || "none"],
            },
          },
          ...(profileRevision !== null ? { expectedRevision: profileRevision } : {}),
        },
      });
      if (updated?.revision !== undefined) setProfileRevision(updated.revision);
      notify("Đã lưu phong cách chữ & màu sắc phản hồi của Bot!", "success");
    } catch (err) {
      if (err.code === "REVISION_CONFLICT") await loadBotProfile(activeBot.id);
      notify(err.message || "Lưu phong cách chữ thất bại", "error");
    } finally {
      setSavingStyle(false);
    }
  };

  const handleResetStyle = async () => {
    if (!activeBot) return;
    setSavingStyle(true);
    try {
      const updated = await v4Fetch(`/api/bots/${encodeURIComponent(activeBot.id)}/style/reset`, {
        method: "POST",
        body: profileRevision !== null ? { expectedRevision: profileRevision } : {},
      });
      if (updated?.revision !== undefined) setProfileRevision(updated.revision);
      await loadBotProfile(activeBot.id);
      notify("Đã khôi phục phong cách chữ mặc định!", "info");
    } catch (err) {
      notify(err.message || "Khôi phục phong cách chữ thất bại", "error");
    } finally {
      setSavingStyle(false);
    }
  };

  // Execute Remote Command
  const handleExecuteRemoteCommand = async (e) => {
    if (e) e.preventDefault();
    if (!activeBot) return;
    if (!cmdInput.trim()) {
      notify("Vui lòng nhập lệnh cần thực thi.", "error");
      return;
    }
    setRunningCmd(true);
    try {
      const res = await v4Fetch(
        `/api/bots/${encodeURIComponent(activeBot.id)}/remote/execute-command`,
        {
          method: "POST",
          body: {
            commandLine: cmdInput.trim(),
            threadId: cmdThreadId.trim() || "web_remote_console",
            deliverToZalo: deliverToZalo && cmdThreadId !== "web_remote_console",
          },
        }
      );
      setCmdOutput(res);
      setCmdHistory((prev) => [
        {
          id: `${Date.now()}`,
          cmd: cmdInput.trim(),
          threadId: cmdThreadId,
          at: new Date().toISOString(),
          ok: res?.executed !== false,
        },
        ...prev.slice(0, 14),
      ]);
      notify(`Đã chạy lệnh "${cmdInput.trim()}" trên ${activeBot.displayName}!`, "success");
    } catch (err) {
      notify(err.message || "Thực thi lệnh từ xa thất bại", "error");
    } finally {
      setRunningCmd(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Top Workspace Header */}
      <div className="v4-card">
        <div className="v4-card-header" style={{ marginBottom: 12 }}>
          <div>
            <h2>📢 Trung Tâm Chiến Dịch Đa Kênh & Điều Khiển AI Từ Xa</h2>
            <div className="v4-muted">
              Chiến dịch Broadcast Spintax chống khóa tài khoản, Kho Media nội bộ, Hồ sơ tính cách AI và Console 218 lệnh trực tiếp.
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              className="v4-select"
              style={{ minWidth: 250 }}
              value={activeBot?.id || ""}
              onChange={(e) => setSelectedBotId(e.target.value)}
            >
              {botList.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.isMain ? "★ [ADMIN] " : ""}
                  {b.displayName} ({b.cookieDead ? "Hết hạn Cookie" : b.wsConnected ? "Online" : b.status})
                </option>
              ))}
            </select>

            <button
              type="button"
              className="v4-btn"
              disabled={!activeBot || loadingTargets}
              onClick={() => activeBot && loadTargets(activeBot.id, true)}
            >
              {loadingTargets
                ? "Đang đồng bộ..."
                : `↻ Tải Nhóm (${groups.length}) & Bạn bè (${friends.length})`}
            </button>
          </div>
        </div>

        {/* 4 Rich Sub-Tabs */}
        <div className="v4-tabs" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className={`v4-tab ${tab === "campaign" ? "active" : ""}`}
            onClick={() => setTab("campaign")}
          >
            📢 Chiến Dịch Broadcast Chống Khóa ({campaigns.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "media" ? "active" : ""}`}
            onClick={() => setTab("media")}
          >
            🖼️ Kho Media Nội Bộ ({mediaItems.length})
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "persona" ? "active" : ""}`}
            onClick={() => setTab("persona")}
          >
            💬 Gửi Tin Đơn Lẻ & Tính Cách AI Của Bot
          </button>
          <button
            type="button"
            className={`v4-tab ${tab === "console" ? "active" : ""}`}
            onClick={() => setTab("console")}
          >
            ⚡ Bảng Chạy {catalogCommands.length || 218} Lệnh Từ Xa
          </button>
        </div>
      </div>

      {/* =====================================================================
          TAB 1: CAMPAIGN STUDIO & ACTIVE/PAST CAMPAIGNS MANAGER
         ===================================================================== */}
      {tab === "campaign" && (
        <>
          <form onSubmit={handleLaunchCampaign} className="v4-card">
            <div className="v4-grid-2" style={{ gridTemplateColumns: "360px minmax(0, 1fr)" }}>
              {/* Left Column: Multi-Group Picker */}
              <div style={{ borderRight: "1px solid var(--border)", paddingRight: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <strong>Danh Sách Nhóm Đích ({selectedGroupIds.length}/{groups.length})</strong>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="v4-btn sm"
                      onClick={() =>
                        setSelectedGroupIds(
                          filteredGroups.map((g) => String(g.threadId || g.id))
                        )
                      }
                    >
                      Chọn tất cả
                    </button>
                    <button
                      type="button"
                      className="v4-btn sm"
                      onClick={() => setSelectedGroupIds([])}
                    >
                      Xóa chọn
                    </button>
                  </div>
                </div>

                <input
                  className="v4-input"
                  style={{ marginBottom: 10 }}
                  placeholder="Tìm tên nhóm hoặc Thread ID..."
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                />

                <div
                  style={{
                    maxHeight: 450,
                    overflowY: "auto",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {filteredGroups.length === 0 ? (
                    <div className="v4-muted" style={{ padding: 14 }}>
                      Chưa có nhóm nào khớp bộ lọc. Hãy đảm bảo Bot đang Online rồi bấm “Tải Nhóm”.
                    </div>
                  ) : (
                    filteredGroups.map((g) => {
                      const gid = String(g.threadId || g.id);
                      const checked = selectedGroupIds.includes(gid);
                      return (
                        <label
                          key={gid}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "8px 10px",
                            borderRadius: 8,
                            cursor: "pointer",
                            background: checked ? "var(--primary-soft)" : "transparent",
                            border: checked ? "1px solid var(--border-strong)" : "1px solid transparent",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleGroupSelection(gid)}
                          />
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {g.name || `Nhóm ${gid}`}
                            </div>
                            <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                              ID: {gid} • {g.memberCount || 0} thành viên
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Right Column: Spintax Composer + Anti-Ban Pacing */}
              <div>
                <div className="v4-grid-2">
                  <div className="v4-field">
                    <label>Tên chiến dịch (Để theo dõi lịch sử)</label>
                    <input
                      className="v4-input"
                      placeholder="VD: Chúc buổi sáng thứ Hai / Thông báo khuyến mãi..."
                      value={campaignName}
                      onChange={(e) => setCampaignName(e.target.value)}
                    />
                  </div>

                  <div className="v4-field">
                    <label>Bộ mẫu chiến dịch đã lưu ({templates.length})</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <select
                        className="v4-select"
                        value={selectedTemplateId}
                        onChange={(e) => handleApplyTemplate(e.target.value)}
                      >
                        <option value="">-- Chọn mẫu soạn sẵn --</option>
                        {templates.map((t) => {
                          const tid = String(t.id || t.name);
                          return (
                            <option key={tid} value={tid}>
                              {t.name || t.title}
                            </option>
                          );
                        })}
                      </select>
                      {selectedTemplateId && (
                        <button
                          type="button"
                          className="v4-btn sm danger"
                          onClick={() => handleDeleteTemplate(selectedTemplateId)}
                          title="Xóa mẫu đang chọn"
                        >
                          🗑
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* Spintax Composer */}
                <div className="v4-field">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <label style={{ marginBottom: 0 }}>
                      Soạn thảo Spintax thông minh (Mỗi nhóm nhận 1 biến thể ngẫu nhiên chống quét Spam)
                    </label>
                    <button
                      type="button"
                      className="v4-btn sm primary"
                      disabled={previewingSpintax}
                      onClick={handlePreviewSpintax}
                    >
                      {previewingSpintax ? "Đang trộn..." : "🎲 Xem Trước Biến Thể"}
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0" }}>
                    {SPINTAX_CHIPS.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        className="v4-chip"
                        onClick={() => setCampaignText((prev) => `${prev}${prev.endsWith(" ") || !prev ? "" : " "}${chip.insert}`)}
                      >
                        + {chip.label}
                      </button>
                    ))}
                  </div>

                  <textarea
                    className="v4-textarea"
                    rows={4}
                    value={campaignText}
                    onChange={(e) => setCampaignText(e.target.value)}
                    placeholder="{Chào cả nhà|Xin chào|Chúc ngày mới} nhóm {groupName} ({memberCount} thành viên)!"
                  />
                </div>

                {/* Spintax Live Preview Panel */}
                {spintaxPreview && (
                  <div className="v4-card highlight-admin" style={{ padding: 12, marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <strong>
                        🎲 Kết quả trộn Spintax: <span className="v4-badge success">{spintaxPreview.totalCombinations} biến thể độc lập</span>
                      </strong>
                      <button type="button" className="v4-btn sm" onClick={() => setSpintaxPreview(null)}>
                        Ẩn
                      </button>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(spintaxPreview.samples || []).map((sample, idx) => (
                        <div
                          key={idx}
                          style={{
                            padding: "7px 10px",
                            borderRadius: 8,
                            background: "var(--bg-input)",
                            border: "1px solid var(--border)",
                            fontSize: 12.5,
                          }}
                        >
                          <span className="v4-badge neutral" style={{ marginRight: 8 }}>Mẫu #{idx + 1}</span>
                          {sample}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Save current as template bar */}
                <div className="v4-toolbar" style={{ marginBottom: 12 }}>
                  <input
                    className="v4-input"
                    style={{ maxWidth: 260 }}
                    placeholder="Đặt tên để lưu thành mẫu..."
                    value={newTemplateTitle}
                    onChange={(e) => setNewTemplateTitle(e.target.value)}
                  />
                  <button type="button" className="v4-btn sm" onClick={handleSaveTemplate}>
                    💾 Lưu Vào Bộ Mẫu
                  </button>
                </div>

                {/* Media Attachment + Picker from Internal Vault */}
                <div className="v4-field">
                  <label>Đính kèm Ảnh / Video / MP3 (URL trực tiếp hoặc chọn từ Kho Media Nội Bộ)</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      className="v4-input"
                      placeholder="https://... hoặc chọn từ Kho Media Nội Bộ bên phải"
                      value={campaignMediaUrl}
                      onChange={(e) => setCampaignMediaUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      className="v4-btn"
                      onClick={() => {
                        loadMediaLibrary();
                        setShowMediaPickerTarget("campaign");
                      }}
                    >
                      🖼️ Chọn Từ Kho Media ({mediaItems.length})
                    </button>
                  </div>
                </div>

                {/* Anti-Ban Pacing Controls */}
                <div className="v4-card" style={{ padding: 12, marginBottom: 14, background: "var(--bg-input)" }}>
                  <div style={{ fontWeight: 700, marginBottom: 8 }}>
                    🛡️ Nhịp Giãn Cách Chống Khóa Zalo (Anti-Ban Pacing) & Hẹn Giờ
                  </div>
                  <div className="v4-grid-4">
                    <div className="v4-field" style={{ marginBottom: 0 }}>
                      <label>Trễ tối thiểu (giây)</label>
                      <input
                        type="number"
                        min={1}
                        max={300}
                        className="v4-input v4-mono"
                        value={minDelaySec}
                        onChange={(e) => setMinDelaySec(Number(e.target.value))}
                      />
                    </div>
                    <div className="v4-field" style={{ marginBottom: 0 }}>
                      <label>Trễ tối đa (giây)</label>
                      <input
                        type="number"
                        min={1}
                        max={600}
                        className="v4-input v4-mono"
                        value={maxDelaySec}
                        onChange={(e) => setMaxDelaySec(Number(e.target.value))}
                      />
                    </div>
                    <div className="v4-field" style={{ marginBottom: 0 }}>
                      <label>Nghỉ giữa chừng sau (nhóm)</label>
                      <input
                        type="number"
                        min={0}
                        max={500}
                        className="v4-input v4-mono"
                        value={restEveryNGroups}
                        onChange={(e) => setRestEveryNGroups(Number(e.target.value))}
                      />
                    </div>
                    <div className="v4-field" style={{ marginBottom: 0 }}>
                      <label>Thời gian nghỉ (giây)</label>
                      <input
                        type="number"
                        min={0}
                        max={1800}
                        className="v4-input v4-mono"
                        value={restDurationSec}
                        onChange={(e) => setRestDurationSec(Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="v4-field" style={{ marginTop: 10, marginBottom: 0 }}>
                    <label>Hẹn giờ phát tự động (Tùy chọn — bỏ trống để phát ngay lập tức)</label>
                    <input
                      type="datetime-local"
                      className="v4-input v4-mono"
                      style={{ maxWidth: 280 }}
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                    />
                  </div>
                </div>

                {broadcastProgress && (
                  <div className="v4-card" style={{ padding: 10, marginBottom: 12 }}>
                    <span className="v4-badge info">Socket Live</span>{" "}
                    Đã gửi <strong>{broadcastProgress.sent || 0}</strong> / {broadcastProgress.total || 0} nhóm (Lỗi:{" "}
                    {broadcastProgress.failed || 0})
                  </div>
                )}

                <button
                  type="submit"
                  className="v4-btn success"
                  style={{ width: "100%", padding: "11px 16px" }}
                  disabled={launchingCampaign || !activeBot}
                >
                  {launchingCampaign
                    ? "Đang khởi tạo chiến dịch..."
                    : scheduledAt
                      ? `⏰ Hẹn Giờ Phát Chiến Dịch Tới ${selectedGroupIds.length} Nhóm`
                      : `🚀 Phát Chiến Dịch Chống Khóa Tới ${selectedGroupIds.length} Nhóm Ngay`}
                </button>
              </div>
            </div>
          </form>

          {/* Active & Past Campaigns Manager */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>📊 Quản Lý Tiến Độ Chiến Dịch Đang Chạy & Lịch Sử ({campaigns.length})</h3>
                <div className="v4-muted">
                  Tạm dừng, tiếp tục, hủy hoặc gửi lại riêng những nhóm gặp lỗi chỉ với 1 cú nhấp chuột.
                </div>
              </div>
              <button type="button" className="v4-btn sm" onClick={loadCampaignsAndTemplates}>
                ↻ Làm mới danh sách
              </button>
            </div>

            {campaigns.length === 0 ? (
              <div className="v4-muted" style={{ padding: 18, textAlign: "center" }}>
                Chưa có chiến dịch nào được ghi nhận. Hãy tạo chiến dịch đầu tiên ở khung phía trên!
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {campaigns.map((camp) => {
                  const cid = String(camp.id || camp.campaignId);
                  const stKey = String(camp.status || "completed").toLowerCase();
                  const meta = CAMPAIGN_STATUS_META[stKey] || { label: stKey, badge: "neutral" };
                  const rawTotal = camp.stats?.total ?? camp.total ?? camp.totalGroups ?? camp.targets?.length ?? camp.threadIds?.length ?? 0;
                  const total = Math.max(1, Number(rawTotal));
                  const sent = Number(camp.stats?.sent ?? camp.sent ?? camp.sentCount ?? 0);
                  const failed = Number(camp.stats?.failed ?? camp.failed ?? camp.failedCount ?? 0);
                  const doneCount = Math.min(total, sent + failed);
                  const pct = Math.min(100, Math.round((doneCount / total) * 100));

                  return (
                    <div
                      key={cid}
                      className="v4-card"
                      style={{ padding: 14, background: "var(--bg-elevated)" }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <strong style={{ fontSize: 15 }}>{camp.name || `Chiến dịch #${cid}`}</strong>
                            <span className={`v4-badge ${meta.badge}`}>{meta.label}</span>
                            <span className="v4-badge neutral v4-mono">Bot: {camp.botId || "admin"}</span>
                          </div>
                          <div className="v4-muted" style={{ fontSize: 12, marginTop: 3 }}>
                            Tạo lúc: {formatDateVi(camp.createdAt)}
                            {camp.scheduledAt ? ` • Hẹn phát: ${formatDateVi(camp.scheduledAt)}` : ""}
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {stKey === "running" && (
                            <button
                              type="button"
                              className="v4-btn sm warning"
                              onClick={() => handleCampaignAction(cid, "pause")}
                            >
                              ⏸ Tạm Dừng
                            </button>
                          )}
                          {(stKey === "paused" || stKey === "scheduled") && (
                            <button
                              type="button"
                              className="v4-btn sm success"
                              onClick={() => handleCampaignAction(cid, "resume")}
                            >
                              ▶ Tiếp Tục
                            </button>
                          )}
                          {failed > 0 && (
                            <button
                              type="button"
                              className="v4-btn sm primary"
                              onClick={() => handleCampaignAction(cid, "retry-failed")}
                            >
                              🔁 Gửi Lại Nhóm Lỗi ({failed})
                            </button>
                          )}
                          {(stKey === "running" || stKey === "paused" || stKey === "scheduled") && (
                            <button
                              type="button"
                              className="v4-btn sm danger"
                              onClick={() => handleCampaignAction(cid, "cancel")}
                            >
                              ✕ Hủy
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Progress Bar */}
                      <div style={{ marginTop: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                          <span className="v4-mono">
                            Thành công: <strong style={{ color: "var(--success)" }}>{sent}</strong> /{" "}
                            {camp.total ?? camp.threadIds?.length ?? 0} nhóm • Lỗi:{" "}
                            <strong style={{ color: failed > 0 ? "var(--danger)" : "inherit" }}>{failed}</strong>
                          </span>
                          <span className="v4-mono">{pct}%</span>
                        </div>
                        <div
                          style={{
                            width: "100%",
                            height: 8,
                            borderRadius: 999,
                            background: "rgba(148, 163, 184, 0.2)",
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${pct}%`,
                              height: "100%",
                              background: failed > 0 && sent === 0 ? "var(--danger)" : "var(--success)",
                              transition: "width 0.3s ease",
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* =====================================================================
          TAB 2: INTERNAL MEDIA LIBRARY (DRAG & DROP + GALLERY)
         ===================================================================== */}
      {tab === "media" && (
        <div className="v4-card">
          <div className="v4-card-header">
            <div>
              <h3>🖼️ Kho Media Nội Bộ (Ảnh / Video MP4 / Âm Thanh MP3)</h3>
              <div className="v4-muted">
                Tải tệp lên máy chủ một lần và tái sử dụng cho mọi chiến dịch Broadcast hoặc tin nhắn tự động.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {["ALL", "image", "video", "audio"].map((flt) => (
                <button
                  key={flt}
                  type="button"
                  className={`v4-chip ${mediaFilter === flt ? "active" : ""}`}
                  onClick={() => setMediaFilter(flt)}
                >
                  {flt === "ALL"
                    ? `Tất cả (${mediaItems.length})`
                    : flt === "image"
                      ? "🖼️ Ảnh"
                      : flt === "video"
                        ? "🎬 Video"
                        : "🎵 Âm thanh"}
                </button>
              ))}
            </div>
          </div>

          {/* Drag-and-Drop Upload Zone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              uploadFilesToMediaVault(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            style={{
              border: `2px dashed ${dragOver ? "var(--primary)" : "var(--border-strong)"}`,
              borderRadius: 14,
              padding: "26px 20px",
              textAlign: "center",
              background: dragOver ? "var(--primary-soft)" : "var(--bg-input)",
              cursor: "pointer",
              marginBottom: 18,
              transition: "all 0.15s ease",
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,video/mp4,video/*,audio/mpeg,audio/mp3,audio/*"
              style={{ display: "none" }}
              onChange={(e) => uploadFilesToMediaVault(e.target.files)}
            />
            <div style={{ fontSize: 30, marginBottom: 6 }}>📤</div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>
              {uploadingMedia
                ? "Đang mã hóa và tải tệp lên Kho Media Nội Bộ..."
                : "Kéo thả Ảnh, Video MP4 hoặc Nhạc MP3 vào đây (hoặc bấm để chọn tệp)"}
            </div>
            <div className="v4-muted" style={{ marginTop: 4 }}>
              Hỗ trợ JPG, PNG, GIF, WEBP, MP4, MP3 — Tự động sinh URL nội bộ cho Bot gửi trực tiếp.
            </div>
          </div>

          {/* Media Gallery Grid */}
          {filteredMedia.length === 0 ? (
            <div className="v4-muted" style={{ textAlign: "center", padding: 28 }}>
              Kho Media đang trống. Hãy tải lên tệp đầu tiên ở khung phía trên!
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))",
                gap: 14,
              }}
            >
              {filteredMedia.map((item) => {
                const mid = String(item.id || item.fileName || item.name);
                const url = resolveMediaUrl(item);
                const mime = String(item.mimeType || item.type || "").toLowerCase();
                const isVideo = mime.includes("video") || url.endsWith(".mp4");
                const isAudio = mime.includes("audio") || url.endsWith(".mp3");

                return (
                  <div
                    key={mid}
                    className="v4-card"
                    style={{
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "space-between",
                      gap: 10,
                      background: "var(--bg-elevated)",
                    }}
                  >
                    <div
                      style={{
                        height: 150,
                        borderRadius: 10,
                        background: "#050811",
                        overflow: "hidden",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {isVideo ? (
                        <video
                          src={url}
                          controls
                          preload="metadata"
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : isAudio ? (
                        <audio src={url} controls style={{ width: "90%" }} />
                      ) : url ? (
                        <img
                          src={url}
                          alt={item.name || "media"}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        />
                      ) : (
                        <span className="v4-muted">Không có ảnh xem trước</span>
                      )}
                    </div>

                    <div>
                      <div
                        style={{
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={item.filename || item.name || item.fileName}
                      >
                        {item.filename || item.name || item.fileName || mid}
                      </div>
                      <div className="v4-muted v4-mono" style={{ fontSize: 11 }}>
                        {formatFileSizeSmart(item.sizeBytes ?? item.size)} • {formatDateVi(item.createdAt)}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        type="button"
                        className="v4-btn sm primary"
                        style={{ flex: 1 }}
                        onClick={() => {
                          setCampaignMediaUrl(url);
                          setTab("campaign");
                          notify("Đã đính kèm Media vào Chiến dịch Broadcast!", "success");
                        }}
                      >
                        📢 Dùng cho Chiến dịch
                      </button>
                      <button
                        type="button"
                        className="v4-btn sm"
                        onClick={() => {
                          navigator.clipboard?.writeText?.(url);
                          notify("Đã sao chép URL Media!", "info");
                        }}
                        title="Sao chép URL"
                      >
                        📋
                      </button>
                      <button
                        type="button"
                        className="v4-btn sm danger"
                        onClick={() => handleDeleteMedia(mid)}
                        title="Xóa tệp"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          TAB 3: DIRECT MESSAGE & BOT PERSONA / AI STYLE EDITOR
         ===================================================================== */}
      {tab === "persona" && (
        <div className="v4-grid-2">
          {/* Left Column: Direct Single Send */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>💬 Gửi Tin Nhắn / Media Đơn Lẻ Tức Thì</h3>
                <div className="v4-muted">
                  Gửi trực tiếp tới một Nhóm Zalo hoặc Bạn bè cá nhân kèm thời gian tự hủy (TTL).
                </div>
              </div>
            </div>

            <form onSubmit={handleSendDirect}>
              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Loại đích nhận</label>
                  <select
                    className="v4-select"
                    value={targetType}
                    onChange={(e) => {
                      const next = e.target.value;
                      setTargetType(next);
                      if (next === "group" && groups[0]) {
                        setDirectThreadId(String(groups[0].threadId || groups[0].id));
                      } else if (next === "user" && friends[0]) {
                        setDirectThreadId(String(friends[0].uid || friends[0].userId || friends[0].id));
                      }
                    }}
                  >
                    <option value="group">Nhóm Zalo ({groups.length})</option>
                    <option value="user">Bạn bè / Cá nhân ({friends.length})</option>
                  </select>
                </div>

                <div className="v4-field">
                  <label>Chọn nhanh từ danh sách</label>
                  <select
                    className="v4-select"
                    value={directThreadId}
                    onChange={(e) => setDirectThreadId(e.target.value)}
                  >
                    <option value="">-- Chọn người/nhóm nhận --</option>
                    {targetType === "group"
                      ? groups.map((g) => {
                          const gid = String(g.threadId || g.id);
                          return (
                            <option key={gid} value={gid}>
                              {g.name || `Nhóm ${gid}`} ({g.memberCount || 0} TV)
                            </option>
                          );
                        })
                      : friends.map((f) => {
                          const uid = String(f.uid || f.userId || f.id);
                          return (
                            <option key={uid} value={uid}>
                              {f.displayName || f.zaloName || uid} ({uid})
                            </option>
                          );
                        })}
                  </select>
                </div>
              </div>

              <div className="v4-field">
                <label>Thread ID / Zalo UID nhận</label>
                <input
                  className="v4-input v4-mono"
                  value={directThreadId}
                  onChange={(e) => setDirectThreadId(e.target.value)}
                  placeholder="Nhập mã nhóm hoặc UID..."
                />
              </div>

              <div className="v4-field">
                <label>Nội dung tin nhắn</label>
                <textarea
                  className="v4-textarea"
                  rows={4}
                  placeholder="Nhập nội dung tin nhắn muốn Bot gửi..."
                  value={directText}
                  onChange={(e) => setDirectText(e.target.value)}
                />
              </div>

              <div className="v4-field">
                <label>Đính kèm Media (URL hoặc Kho Media Nội Bộ)</label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    className="v4-input"
                    placeholder="https://..."
                    value={directMediaUrl}
                    onChange={(e) => setDirectMediaUrl(e.target.value)}
                  />
                  <button
                    type="button"
                    className="v4-btn sm"
                    onClick={() => {
                      loadMediaLibrary();
                      setShowMediaPickerTarget("direct");
                    }}
                  >
                    🖼️ Kho Media
                  </button>
                </div>
              </div>

              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Định dạng Media</label>
                  <select
                    className="v4-select"
                    value={directMediaType}
                    onChange={(e) => setDirectMediaType(e.target.value)}
                  >
                    <option value="auto">Tự động nhận diện</option>
                    <option value="image">Hình ảnh</option>
                    <option value="video">Video MP4</option>
                    <option value="audio">Âm thanh / Voice</option>
                  </select>
                </div>
                <div className="v4-field">
                  <label>Tự hủy tin nhắn sau (Giây — 0 là giữ vĩnh viễn)</label>
                  <input
                    type="number"
                    min={0}
                    className="v4-input v4-mono"
                    value={directTtlSecs}
                    onChange={(e) => setDirectTtlSecs(e.target.value)}
                  />
                </div>
              </div>

              <button
                type="submit"
                className="v4-btn primary"
                style={{ width: "100%" }}
                disabled={sendingDirect || !activeBot}
              >
                {sendingDirect ? "Đang gửi..." : "🚀 Gửi Tin Nhắn Trực Tiếp"}
              </button>
            </form>
          </div>

          {/* Right Column: Bot Persona & AI Style Editor */}
          <div className="v4-card">
            <div className="v4-card-header">
              <div>
                <h3>🎭 Tính Cách AI & Phong Cách Phản Hồi Của Bot</h3>
                <div className="v4-muted">
                  Đồng bộ trực tiếp với hồ sơ <code>profile.json</code> và định dạng chữ màu Zalo của Bot{" "}
                  <strong>{activeBot?.displayName}</strong>
                  {profileRevision !== null ? ` (rev #${profileRevision})` : ""}.
                </div>
              </div>
              {profileLoading && <span className="v4-badge info">Đang tải...</span>}
            </div>

            {/* Quick Persona Templates */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
              {PERSONA_PRESETS.map((pr) => (
                <button
                  key={pr.id}
                  type="button"
                  className="v4-chip"
                  onClick={() => {
                    setPersonaForm((prev) => ({
                      ...prev,
                      description: pr.description,
                      botInfo: pr.botInfo,
                    }));
                    setStyleForm((prev) => ({
                      ...prev,
                      icon: pr.icon,
                      color: pr.color,
                    }));
                  }}
                >
                  {pr.label}
                </button>
              ))}
            </div>

            <form onSubmit={handleSaveProfile} style={{ marginBottom: 16 }}>
              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Tên Thương Hiệu / Header Bot (nameServer)</label>
                  <input
                    className="v4-input"
                    maxLength={80}
                    value={personaForm.nameServer}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, nameServer: e.target.value }))}
                  />
                </div>
                <div className="v4-field">
                  <label>Tên Chủ Sở Hữu Hiển Thị (ownerName)</label>
                  <input
                    className="v4-input"
                    maxLength={80}
                    value={personaForm.ownerName}
                    onChange={(e) => setPersonaForm((p) => ({ ...p, ownerName: e.target.value }))}
                  />
                </div>
              </div>

              <div className="v4-field">
                <label>Mô tả tính cách & giọng điệu AI (System Persona — tối đa 500 ký tự)</label>
                <textarea
                  className="v4-textarea"
                  rows={3}
                  maxLength={500}
                  placeholder="Mô tả cách Bot xưng hô, phong cách trả lời AI..."
                  value={personaForm.description}
                  onChange={(e) => setPersonaForm((p) => ({ ...p, description: e.target.value }))}
                />
              </div>

              <div className="v4-field">
                <label>Giới thiệu ngắn về Bot (botInfo)</label>
                <input
                  className="v4-input"
                  maxLength={500}
                  placeholder="Thông tin hiển thị khi thành viên gõ !showinfo..."
                  value={personaForm.botInfo}
                  onChange={(e) => setPersonaForm((p) => ({ ...p, botInfo: e.target.value }))}
                />
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="submit" className="v4-btn primary" disabled={savingProfile || !activeBot}>
                  {savingProfile ? "Đang lưu..." : "💾 Lưu Hồ Sơ & Tính Cách AI"}
                </button>
              </div>
            </form>

            {/* AI Message Style Editor */}
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14 }}>
              <div style={{ fontWeight: 700, marginBottom: 10 }}>
                🎨 Định Dạng Màu Chữ & Biểu Tượng Phản Hồi Zalo (`/style`)
              </div>

              <div className="v4-grid-3">
                <div className="v4-field">
                  <label>Icon đầu tin</label>
                  <input
                    className="v4-input"
                    maxLength={10}
                    value={styleForm.icon}
                    onChange={(e) => setStyleForm((s) => ({ ...s, icon: e.target.value }))}
                  />
                </div>
                <div className="v4-field">
                  <label>Cỡ chữ Tiêu đề (10-24)</label>
                  <input
                    type="number"
                    min={10}
                    max={24}
                    className="v4-input v4-mono"
                    value={styleForm.sizeNameServer}
                    onChange={(e) => setStyleForm((s) => ({ ...s, sizeNameServer: e.target.value }))}
                  />
                </div>
                <div className="v4-field">
                  <label>Cỡ chữ Nội dung (10-24)</label>
                  <input
                    type="number"
                    min={10}
                    max={24}
                    className="v4-input v4-mono"
                    value={styleForm.sizeText}
                    onChange={(e) => setStyleForm((s) => ({ ...s, sizeText: e.target.value }))}
                  />
                </div>
              </div>

              <div className="v4-grid-2">
                <div className="v4-field">
                  <label>Kiểu chữ Tiêu đề</label>
                  <select
                    className="v4-select"
                    value={styleForm.typeNameServer}
                    onChange={(e) => setStyleForm((s) => ({ ...s, typeNameServer: e.target.value }))}
                  >
                    {STYLE_TYPES.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="v4-field">
                  <label>Kiểu chữ Nội dung</label>
                  <select
                    className="v4-select"
                    value={styleForm.typeText}
                    onChange={(e) => setStyleForm((s) => ({ ...s, typeText: e.target.value }))}
                  >
                    {STYLE_TYPES.map((st) => (
                      <option key={st.id} value={st.id}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="v4-field">
                <label>Bảng màu thương hiệu (Hex)</label>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {STYLE_COLORS.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      onClick={() => setStyleForm((s) => ({ ...s, color: c.hex }))}
                      title={c.label}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        background: `#${c.hex}`,
                        border:
                          styleForm.color.toLowerCase() === c.hex
                            ? "3px solid #fff"
                            : "1px solid var(--border)",
                        cursor: "pointer",
                        boxShadow:
                          styleForm.color.toLowerCase() === c.hex
                            ? "0 0 0 2px var(--primary)"
                            : "none",
                      }}
                    />
                  ))}
                  <input
                    className="v4-input v4-mono"
                    style={{ width: 110 }}
                    maxLength={7}
                    value={`#${styleForm.color.replace(/^#/, "")}`}
                    onChange={(e) =>
                      setStyleForm((s) => ({ ...s, color: e.target.value.replace(/^#/, "") }))
                    }
                  />
                </div>
              </div>

              {/* Live Styled Zalo Bubble Preview */}
              <div
                style={{
                  padding: "12px 14px",
                  borderRadius: 12,
                  background: "var(--bg-input)",
                  border: "1px solid var(--border)",
                  marginBottom: 12,
                }}
              >
                <div className="v4-muted" style={{ fontSize: 11, marginBottom: 4 }}>
                  Xem trước tin nhắn Zalo thực tế:
                </div>
                <div
                  style={{
                    color: `#${styleForm.color.replace(/^#/, "") || "db342e"}`,
                    fontSize: `${Math.min(22, Math.max(12, Number(styleForm.sizeNameServer) || 18))}px`,
                    fontWeight: styleForm.typeNameServer === "bold" ? 800 : 500,
                    fontStyle: styleForm.typeNameServer === "italic" ? "italic" : "normal",
                    textDecoration:
                      styleForm.typeNameServer === "underline"
                        ? "underline"
                        : styleForm.typeNameServer === "strike"
                          ? "line-through"
                          : "none",
                  }}
                >
                  {styleForm.icon} {personaForm.nameServer || "MyBot V5"}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: `${Math.min(20, Math.max(11, Number(styleForm.sizeText) || 14))}px`,
                    fontWeight: styleForm.typeText === "bold" ? 700 : 400,
                    fontStyle: styleForm.typeText === "italic" ? "italic" : "normal",
                  }}
                >
                  {personaForm.description || "Xin chào! Tôi sẵn sàng hỗ trợ quản trị nhóm 24/7."}
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <button
                  type="button"
                  className="v4-btn"
                  disabled={savingStyle || !activeBot}
                  onClick={handleResetStyle}
                >
                  ↺ Khôi Phục Mặc Định
                </button>
                <button
                  type="button"
                  className="v4-btn success"
                  disabled={savingStyle || !activeBot}
                  onClick={handleSaveStyle}
                >
                  {savingStyle ? "Đang áp dụng..." : "🎨 Lưu Phong Cách Chữ"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          TAB 4: REMOTE 218-COMMAND WEB CONSOLE
         ===================================================================== */}
      {tab === "console" && (
        <div className="v4-card">
          <div className="v4-card-header">
            <div>
              <h3>⚡ Bảng Điều Khiển & Thực Thi 218 Lệnh Từ Xa</h3>
              <div className="v4-muted">
                Kết nối trực tiếp danh mục chuẩn <code>/api/command-studio/catalog</code> ({catalogCommands.length || 218} lệnh) — chạy thử nội bộ trên Web hoặc bắn kết quả thẳng ra nhóm Zalo.
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {QUICK_MACROS.map((m) => (
              <button
                key={m.cmd}
                type="button"
                className="v4-btn sm"
                onClick={() => setCmdInput(m.cmd)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <form onSubmit={handleExecuteRemoteCommand}>
            <div className="v4-grid-2">
              <div className="v4-field">
                <label>Lệnh cần chạy (Tự động gợi ý {catalogCommands.length || 218} lệnh)</label>
                <input
                  className="v4-input v4-mono"
                  list="v5-studio-catalog-datalist"
                  value={cmdInput}
                  onChange={(e) => setCmdInput(e.target.value)}
                  placeholder="Nhập lệnh: menu, bot on, detail, group, thoitiet Hà Nội..."
                />
                <datalist id="v5-studio-catalog-datalist">
                  {catalogCommands.map((c) => {
                    const name = c.commandName || c.name;
                    return (
                      <option key={name} value={name}>
                        {name} ({c.permission || "all"} • {c.scope || "both"})
                      </option>
                    );
                  })}
                </datalist>
              </div>

              <div className="v4-field">
                <label>Ngữ cảnh Nhóm thực thi (Thread ID)</label>
                <select
                  className="v4-select"
                  value={cmdThreadId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCmdThreadId(val);
                    setDeliverToZalo(val !== "web_remote_console");
                  }}
                >
                  <option value="web_remote_console">🖥️ Chạy nội bộ trên Web Console (Không gửi ra Zalo)</option>
                  {groups.map((g) => {
                    const gid = String(g.threadId || g.id);
                    return (
                      <option key={gid} value={gid}>
                        💬 {g.name || `Nhóm ${gid}`} ({gid})
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                marginBottom: 14,
              }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={deliverToZalo && cmdThreadId !== "web_remote_console"}
                  disabled={cmdThreadId === "web_remote_console"}
                  onChange={(e) => setDeliverToZalo(e.target.checked)}
                />
                <span>Đồng thời gửi câu trả lời của lệnh này ra nhóm Zalo đã chọn</span>
              </label>

              <button type="submit" className="v4-btn primary" disabled={runningCmd || !activeBot}>
                {runningCmd ? "Đang thực thi..." : "▶ Thực Thi Lệnh Ngay"}
              </button>
            </div>
          </form>

          <div className="v4-grid-2" style={{ gridTemplateColumns: "minmax(0, 2fr) minmax(260px, 1fr)" }}>
            <div className="v4-log-box" style={{ height: 300 }}>
              {cmdOutput ? (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ color: "#38bdf8", fontWeight: 700 }}>
                      $ {cmdOutput.commandLine || cmdInput}
                    </span>
                    <span className={`v4-badge ${cmdOutput.executed !== false ? "success" : "danger"}`}>
                      {cmdOutput.deliveredToZalo
                        ? "Đã gửi ra Zalo"
                        : cmdOutput.executed !== false
                          ? "Đã chạy trên Web"
                          : "Lỗi thực thi"}
                    </span>
                  </div>
                  <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit" }}>
                    {cmdOutput.replyText || cmdOutput.output || JSON.stringify(cmdOutput, null, 2)}
                  </pre>
                </>
              ) : (
                <div className="v4-muted">
                  Chọn một Macro nhanh hoặc gõ lệnh bất kỳ rồi bấm “Thực Thi Lệnh Ngay” để xem kết quả phản hồi tại đây.
                </div>
              )}
            </div>

            <div className="v4-card" style={{ padding: 12, background: "var(--bg-elevated)" }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Lịch sử lệnh gần đây</div>
              {cmdHistory.length === 0 ? (
                <div className="v4-muted">Chưa có lệnh nào được chạy trong phiên này.</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 245, overflowY: "auto" }}>
                  {cmdHistory.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="v4-nav-btn"
                      style={{ padding: "6px 10px" }}
                      onClick={() => setCmdInput(item.cmd)}
                    >
                      <span className="v4-mono">{item.cmd}</span>
                      <span className={`v4-badge ${item.ok ? "success" : "danger"}`}>
                        {item.ok ? "OK" : "ERR"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Picker for Internal Media Vault */}
      {showMediaPickerTarget && (
        <div className="v4-modal-backdrop" onClick={() => setShowMediaPickerTarget("")}>
          <div className="v4-modal wide" onClick={(e) => e.stopPropagation()}>
            <div className="v4-card-header">
              <div>
                <h3>🖼️ Chọn Tệp Từ Kho Media Nội Bộ</h3>
                <div className="v4-muted">Nhấp vào tệp bất kỳ để đính kèm ngay lập tức</div>
              </div>
              <button type="button" className="v4-btn sm" onClick={() => setShowMediaPickerTarget("")}>
                ✕ Đóng
              </button>
            </div>

            {mediaItems.length === 0 ? (
              <div className="v4-muted" style={{ padding: 24, textAlign: "center" }}>
                Kho Media chưa có tệp nào. Hãy chuyển sang tab <strong>Kho Media Nội Bộ</strong> để tải tệp lên trước!
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                  gap: 10,
                }}
              >
                {mediaItems.map((item) => {
                  const mid = String(item.id || item.name);
                  const url = resolveMediaUrl(item);
                  return (
                    <div key={mid} className="v4-card" style={{ padding: 10 }}>
                      <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 6 }}>
                        {item.name || item.fileName || mid}
                      </div>
                      <button
                        type="button"
                        className="v4-btn sm primary"
                        style={{ width: "100%" }}
                        onClick={() => {
                          if (showMediaPickerTarget === "campaign") {
                            setCampaignMediaUrl(url);
                          } else {
                            setDirectMediaUrl(url);
                          }
                          setShowMediaPickerTarget("");
                          notify("Đã chọn tệp từ Kho Media Nội Bộ!", "success");
                        }}
                      >
                        ✓ Chọn tệp này
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
