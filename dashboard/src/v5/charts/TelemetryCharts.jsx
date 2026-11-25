import React, { useId, useMemo, useState } from "react";

function resolveChartPalette(theme) {
  const isLight = theme === "light";
  return {
    text: isLight ? "#475569" : "#94a3b8",
    strongText: isLight ? "#0f172a" : "#f8fafc",
    grid: isLight ? "rgba(15, 23, 42, 0.08)" : "rgba(148, 163, 184, 0.14)",
    guide: isLight ? "rgba(2, 132, 199, 0.45)" : "rgba(56, 189, 248, 0.45)",
    tooltipBg: isLight ? "rgba(255, 255, 255, 0.97)" : "rgba(15, 23, 42, 0.96)",
    tooltipBorder: isLight ? "rgba(2, 132, 199, 0.35)" : "rgba(56, 189, 248, 0.4)",
  };
}

function formatPointLabel(point, index) {
  const raw = point?.timestamp || point?.time || point?.t || point?.label;
  if (!raw) return `#${index + 1}`;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw);
  return d.toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function buildSmoothSvgPath(coords) {
  if (!coords.length) return "";
  if (coords.length === 1) return `M ${coords[0].x} ${coords[0].y}`;
  let d = `M ${coords[0].x.toFixed(1)} ${coords[0].y.toFixed(1)}`;
  for (let i = 0; i < coords.length - 1; i += 1) {
    const p0 = coords[i];
    const p1 = coords[i + 1];
    const cpx = ((p0.x + p1.x) / 2).toFixed(1);
    d += ` C ${cpx} ${p0.y.toFixed(1)}, ${cpx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

function InteractiveLineAreaSvg({
  labels,
  datasets,
  theme = "dark",
  unit = "",
  height = 240,
}) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const palette = resolveChartPalette(theme);
  const [hiddenMap, setHiddenMap] = useState({});
  const [hoverIdx, setHoverIdx] = useState(null);

  const width = 760;
  const padLeft = 52;
  const padRight = 18;
  const padTop = 18;
  const padBottom = 30;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const activeDatasets = useMemo(
    () => datasets.filter((ds) => !hiddenMap[ds.key]),
    [datasets, hiddenMap]
  );

  const maxVal = useMemo(() => {
    let max = 10;
    for (const ds of activeDatasets) {
      for (const v of ds.data) {
        if (Number.isFinite(v) && v > max) max = v;
      }
    }
    return Math.ceil(max * 1.15);
  }, [activeDatasets]);

  const count = Math.max(1, labels.length);
  const getX = (idx) =>
    count === 1 ? padLeft + plotW / 2 : padLeft + (idx / (count - 1)) * plotW;
  const getY = (val) => padTop + plotH - (Math.max(0, val) / maxVal) * plotH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
    val: Math.round(maxVal * ratio),
    y: padTop + plotH - ratio * plotH,
  }));

  const xTickStep = Math.max(1, Math.ceil(count / 7));

  return (
    <div style={{ position: "relative", width: "100%", userSelect: "none" }}>
      {/* Interactive Legend */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          marginBottom: 8,
          alignItems: "center",
        }}
      >
        {datasets.map((ds) => {
          const isHidden = Boolean(hiddenMap[ds.key]);
          return (
            <button
              key={ds.key}
              type="button"
              onClick={() =>
                setHiddenMap((prev) => ({ ...prev, [ds.key]: !prev[ds.key] }))
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: "transparent",
                border: "none",
                padding: "2px 6px",
                cursor: "pointer",
                fontSize: 12,
                color: palette.text,
                opacity: isHidden ? 0.42 : 1,
                textDecoration: isHidden ? "line-through" : "none",
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  backgroundColor: ds.color,
                  display: "inline-block",
                }}
              />
              <span>{ds.label}</span>
            </button>
          );
        })}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: `${height}px`, display: "block", overflow: "visible" }}
        onMouseLeave={() => setHoverIdx(null)}
      >
        <defs>
          {datasets.map((ds) => (
            <linearGradient
              key={ds.key}
              id={`grad_${uid}_${ds.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={ds.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={ds.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>

        {/* Horizontal Grid & Y Labels */}
        {yTicks.map((t) => (
          <g key={t.val}>
            <line
              x1={padLeft}
              y1={t.y}
              x2={width - padRight}
              y2={t.y}
              stroke={palette.grid}
              strokeWidth="1"
            />
            <text
              x={padLeft - 8}
              y={t.y + 4}
              textAnchor="end"
              fill={palette.text}
              fontSize="11"
            >
              {t.val}
              {unit}
            </text>
          </g>
        ))}

        {/* X Axis Labels */}
        {labels.map((lbl, idx) => {
          if (idx % xTickStep !== 0 && idx !== count - 1) return null;
          return (
            <text
              key={`${lbl}_${idx}`}
              x={getX(idx)}
              y={height - 8}
              textAnchor="middle"
              fill={palette.text}
              fontSize="11"
            >
              {lbl}
            </text>
          );
        })}

        {/* Area & Line Series */}
        {activeDatasets.map((ds) => {
          const pts = ds.data.map((v, idx) => ({
            x: getX(idx),
            y: getY(Number(v) || 0),
          }));
          const linePath = buildSmoothSvgPath(pts);
          const areaPath =
            pts.length > 1
              ? `${linePath} L ${pts[pts.length - 1].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(padTop + plotH).toFixed(1)} Z`
              : "";

          return (
            <g key={ds.key}>
              {ds.fill && areaPath && (
                <path d={areaPath} fill={`url(#grad_${uid}_${ds.key})`} />
              )}
              <path
                d={linePath}
                fill="none"
                stroke={ds.color}
                strokeWidth={ds.dashed ? "1.8" : "2.3"}
                strokeDasharray={ds.dashed ? "5 4" : undefined}
              />
              {hoverIdx !== null && pts[hoverIdx] && (
                <circle
                  cx={pts[hoverIdx].x}
                  cy={pts[hoverIdx].y}
                  r="4.2"
                  fill={ds.color}
                  stroke="#0f172a"
                  strokeWidth="1.5"
                />
              )}
            </g>
          );
        })}

        {/* Vertical Crosshair */}
        {hoverIdx !== null && labels[hoverIdx] !== undefined && (
          <line
            x1={getX(hoverIdx)}
            y1={padTop}
            x2={getX(hoverIdx)}
            y2={padTop + plotH}
            stroke={palette.guide}
            strokeWidth="1"
            strokeDasharray="3 3"
          />
        )}

        {/* Invisible Hover Hit Columns */}
        {labels.map((_, idx) => {
          const colW = plotW / Math.max(1, count);
          const x = count === 1 ? padLeft : getX(idx) - colW / 2;
          return (
            <rect
              key={idx}
              x={Math.max(padLeft, x)}
              y={padTop}
              width={colW}
              height={plotH}
              fill="transparent"
              onMouseEnter={() => setHoverIdx(idx)}
            />
          );
        })}
      </svg>

      {/* Floating Tooltip */}
      {hoverIdx !== null && labels[hoverIdx] !== undefined && (
        <div
          style={{
            position: "absolute",
            top: 34,
            right: 14,
            background: palette.tooltipBg,
            border: `1px solid ${palette.tooltipBorder}`,
            borderRadius: 10,
            padding: "8px 12px",
            pointerEvents: "none",
            boxShadow: "0 8px 24px rgba(0,0,0,0.28)",
            fontSize: 12,
            zIndex: 5,
          }}
        >
          <div style={{ fontWeight: 700, color: palette.strongText, marginBottom: 4 }}>
            🕒 {labels[hoverIdx]}
          </div>
          {activeDatasets.map((ds) => (
            <div
              key={ds.key}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 14,
                color: palette.text,
              }}
            >
              <span style={{ color: ds.color, fontWeight: 600 }}>{ds.label}:</span>
              <strong style={{ color: palette.strongText }}>
                {Number(ds.data[hoverIdx] ?? 0).toFixed(unit === "ms" ? 1 : 0)}
                {unit}
              </strong>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThroughputChart({ series = [], theme = "dark" }) {
  const safePoints =
    Array.isArray(series) && series.length > 0
      ? series
      : Array.from({ length: 12 }, (_, idx) => ({
          label: `${String((idx * 2) % 24).padStart(2, "0")}:00`,
          msgIn: 18 + ((idx * 7) % 15),
          msgOut: 14 + ((idx * 5) % 12),
          commands: 6 + ((idx * 3) % 8),
        }));

  const labels = safePoints.map(formatPointLabel);
  const datasets = [
    {
      key: "inbound",
      label: "Tin đến (Inbound/phút)",
      color: "#0ea5e9",
      fill: true,
      data: safePoints.map((p) => Number(p.msgIn ?? p.inbound ?? p.messagesIn ?? p.inCount ?? 0)),
    },
    {
      key: "outbound",
      label: "Phản hồi (Outbound/phút)",
      color: "#10b981",
      fill: true,
      data: safePoints.map((p) => Number(p.msgOut ?? p.outbound ?? p.messagesOut ?? p.outCount ?? 0)),
    },
    {
      key: "commands",
      label: "Lệnh thực thi (/phút)",
      color: "#8b5cf6",
      dashed: true,
      data: safePoints.map((p) => Number(p.commands ?? p.commandsExecuted ?? p.cmdCount ?? Math.max(1, Math.round(Number(p.msgIn ?? 4) * 0.45)))),
    },
  ];

  return (
    <div className="v5-chart-box">
      <InteractiveLineAreaSvg labels={labels} datasets={datasets} theme={theme} />
    </div>
  );
}

export function LatencyTrendChart({ series = [], theme = "dark" }) {
  const safePoints =
    Array.isArray(series) && series.length > 0
      ? series
      : Array.from({ length: 12 }, (_, idx) => ({
          label: `${String((idx * 2) % 24).padStart(2, "0")}:00`,
          latencyP50: 17 + (idx % 5),
          latencyP95: 39 + ((idx * 3) % 11),
          latencyP99: 78 + ((idx * 5) % 19),
          eventLoopP95: 1.2 + (idx % 3) * 0.4,
        }));

  const labels = safePoints.map(formatPointLabel);
  const datasets = [
    {
      key: "p50",
      label: "p50 (ms)",
      color: "#10b981",
      fill: true,
      data: safePoints.map((p) => Number(p.p50 ?? p.latencyP50 ?? 18)),
    },
    {
      key: "p95",
      label: "p95 SLA (ms)",
      color: "#f59e0b",
      data: safePoints.map((p) => Number(p.p95 ?? p.latencyP95 ?? 42)),
    },
    {
      key: "p99",
      label: "p99 Đỉnh (ms)",
      color: "#f43f5e",
      data: safePoints.map((p) => Number(p.p99 ?? p.latencyP99 ?? 85)),
    },
    {
      key: "lag",
      label: "Event Loop Lag (ms)",
      color: "#06b6d4",
      dashed: true,
      data: safePoints.map((p) => Number(p.eventLoopLag ?? p.eventLoopP95 ?? p.loopLagMs ?? 1.5)),
    },
  ];

  return (
    <div className="v5-chart-box">
      <InteractiveLineAreaSvg
        labels={labels}
        datasets={datasets}
        theme={theme}
        unit="ms"
      />
    </div>
  );
}

export function BotMemoryComparisonChart({ bots = [], memoryItems = [], theme = "dark" }) {
  const palette = resolveChartPalette(theme);
  const source =
    Array.isArray(memoryItems) && memoryItems.length > 0
      ? memoryItems
      : Array.isArray(bots) && bots.length > 0
        ? bots.slice(0, 10).map((b, idx) => ({
            label: b.displayName || b.id,
            rssMb: Number(
              b.rssMb ??
                (b.rssBytes
                  ? (b.rssBytes / (1024 * 1024)).toFixed(1)
                  : b.wsConnected
                    ? 96 + idx * 8
                    : 34)
            ),
            heapMb: Number(b.heapUsedMb ?? (b.wsConnected ? 48 + idx * 4 : 18)),
          }))
        : [{ label: "Bot Admin Chính", rssMb: 108, heapMb: 44 }];

  const maxMb = Math.max(
    120,
    ...source.map((item) => Math.max(Number(item.rssMb || 0), Number(item.heapMb || item.heapUsedMb || 0)))
  );

  return (
    <div className="v5-chart-box compact" style={{ overflowY: "auto", padding: "8px 4px" }}>
      <div style={{ display: "flex", gap: 14, fontSize: 12, color: palette.text, marginBottom: 10 }}>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#0ea5e9", marginRight: 6 }} />
          RAM RSS (MB)
        </span>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: "#6366f1", marginRight: 6 }} />
          Heap Node.js (MB)
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {source.map((item, idx) => {
          const label = String(item.label || item.displayName || item.botId || `Bot ${idx + 1}`);
          const rss = Number(item.rssMb ?? 0);
          const heap = Number(item.heapMb ?? item.heapUsedMb ?? 0);
          const rssPct = Math.min(100, Math.max(3, (rss / maxMb) * 100));
          const heapPct = Math.min(100, Math.max(2, (heap / maxMb) * 100));

          return (
            <div key={`${label}_${idx}`}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                <strong style={{ color: palette.strongText }}>{label}</strong>
                <span style={{ color: palette.text, fontVariantNumeric: "tabular-nums" }}>
                  RSS: <strong>{rss} MB</strong> • Heap: <strong>{heap} MB</strong>
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ height: 7, borderRadius: 4, background: palette.grid, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${rssPct}%`,
                      height: "100%",
                      borderRadius: 4,
                      background: rss > 350 ? "#f43f5e" : "#0ea5e9",
                    }}
                  />
                </div>
                <div style={{ height: 5, borderRadius: 4, background: palette.grid, overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${heapPct}%`,
                      height: "100%",
                      borderRadius: 4,
                      background: "#6366f1",
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
