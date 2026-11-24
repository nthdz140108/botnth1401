const COLOR_ALIASES = {
  rainbow: "rainbow",
  do: "red",
  "đỏ": "red",
  red: "red",
  xanh: "blue",
  blue: "blue",
  vang: "yellow",
  "vàng": "yellow",
  yellow: "yellow",
  hong: "pink",
  "hồng": "pink",
  pink: "pink",
  cam: "orange",
  orange: "orange",
  tim: "purple",
  "tím": "purple",
  purple: "purple",
  trang: "white",
  "trắng": "white",
  white: "white",
};

export const STICKER_USAGE_GUIDE = `📖 Hướng dẫn dùng lệnh sticker:
• Reply ảnh/video: stk [hiệu ứng] (VD: stk xp -r(20) cat)
• Dán link media: stk [hiệu ứng] <url> (VD: stk -r(20) https://...)
• Tạo chữ tĩnh: stk [hiệu ứng] text <nội dung> (VD: stk -r(20) text Xin chào)
• Tạo chữ động: stk [hiệu ứng] textvd <màu> <nội dung> (VD: stk sp(2) textvd đỏ Xin chào)
• Tạo bằng AI: stk [hiệu ứng] ai <mô tả> (hoặc reply ảnh: stk ai [mô tả])

🎨 Danh sách hiệu ứng:
- xp: Xóa phông nền (chỉ ảnh tĩnh hoặc AI)
- -r(0..50): Bo góc hình chữ nhật theo % (VD: -r(20))
- z(0.25..4): Thu phóng (VD: z(1.5) phóng to, z(0.5) thu nhỏ)
- rot(-180..180): Xoay góc độ (VD: rot(90))
- fh, fv: Lật ngang, lật dọc
- pixel(2..64): Hiệu ứng điểm ảnh (VD: pixel(8))
- cat: Cắt vuông căn giữa 512×512
- spin: Xoay tròn 360° tạo hoạt ảnh
- sp(0.25..4): Tốc độ hoạt ảnh (VD: sp(2))

🌈 Màu chữ textvd: đỏ, xanh, vàng, hồng, cam, tím, trắng, rainbow`;

const SOURCE_MODES = new Set(["text", "textvd", "ai"]);
const KNOWN_EFFECTS = new Set([
  "xp",
  "-r",
  "z",
  "sp",
  "pixel",
  "spin",
  "cat",
  "rot",
  "fh",
  "fv",
]);

const DEFAULT_AI_PROMPT =
  "Biến chủ thể thành sticker dễ thương, bố cục trung tâm, viền rõ và nền trong suốt.";

export class StickerParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "StickerParseError";
  }
}

function escapeRegex(str) {
  return String(str ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractStickerArgument(rawContent, aliasCommand = null, prefix = "!") {
  if (typeof rawContent !== "string") return "";
  const text = rawContent.trim();
  const effectivePrefix = prefix || "";

  if (aliasCommand) {
    const escapedAlias = escapeRegex(aliasCommand).replace(/\\ /g, "\\s+");
    const escapedPrefix = effectivePrefix ? `(?:${escapeRegex(effectivePrefix)})?` : "";
    const regex = new RegExp(`^${escapedPrefix}\\s*${escapedAlias}(?:\\s+([\\s\\S]*)|$)`, "i");
    const match = text.match(regex);
    if (match) return match[1] ?? "";
  }

  const escapedPrefix = effectivePrefix ? `(?:${escapeRegex(effectivePrefix)})?` : "";
  const genericRegex = new RegExp(
    `^${escapedPrefix}\\s*(?:stickerai|stkai|sticker\\s+ai|stk\\s+ai|sticker|stk)(?:\\s+([\\s\\S]*)|$)`,
    "i",
  );
  const match = text.match(genericRegex);
  if (match) return match[1] ?? "";

  const symbolRegex = /^[^\s\w]?\s*(?:stickerai|stkai|sticker\s+ai|stk\s+ai|sticker|stk)(?:\s+([\s\S]*)|$)/i;
  const symbolMatch = text.match(symbolRegex);
  if (symbolMatch) return symbolMatch[1] ?? "";

  return text;
}

function tokenize(input) {
  if (Array.isArray(input)) return input.map((token) => String(token)).filter(Boolean);
  return String(input ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function normalizeAliasKey(input) {
  return String(input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function clampFiniteNumber(value, min, max, label) {
  if (!Number.isFinite(value)) {
    throw new StickerParseError(`${label} phải là số hữu hạn`);
  }
  if (value < min || value > max) {
    throw new StickerParseError(`${label} phải nằm trong khoảng ${min}–${max}`);
  }
  return value;
}

function applyEffectEntry(effects, entry, inputTokens) {
  switch (entry.key) {
    case "xp":
    case "spin":
    case "cat": {
      if (effects[entry.key] !== undefined) {
        throw new StickerParseError(`Hiệu ứng ${entry.key} bị trùng`);
      }
      effects[entry.key] = true;
      break;
    }
    case "fh":
    case "fv": {
      const normalizedKey = entry.key === "fh" ? "flipHorizontal" : "flipVertical";
      if (effects[normalizedKey] !== undefined) {
        throw new StickerParseError(`Hiệu ứng ${entry.key} bị trùng`);
      }
      effects[normalizedKey] = true;
      break;
    }
    case "-r": {
      if (effects.round !== undefined) {
        throw new StickerParseError("Hiệu ứng -r bị trùng");
      }
      const raw = entry.value !== undefined ? entry.value : null;
      let value;
      if (raw === null) {
        const next = inputTokens[entry.index + 1];
        if (next && /^\d+(?:[.,]\d+)?$/.test(next)) {
          value = Number(next.replace(",", "."));
        } else {
          value = 50;
        }
      } else {
        value = Number(String(raw).replace(",", "."));
      }
      if (!Number.isFinite(value)) {
        throw new StickerParseError("-r phải là số");
      }
      effects.round = clampFiniteNumber(value, 0, 50, "-r");
      break;
    }
    case "z": {
      if (effects.zoom !== undefined) {
        throw new StickerParseError("Hiệu ứng zoom bị trùng");
      }
      const raw = entry.value !== undefined ? entry.value : null;
      let value;
      if (raw === null) {
        const next = inputTokens[entry.index + 1];
        if (next && /^-?\d+(?:[.,]\d+)?$/.test(next)) {
          value = Number(next.replace(",", "."));
        } else {
          throw new StickerParseError("zoom cần giá trị số");
        }
      } else {
        value = Number(String(raw).replace(",", "."));
      }
      effects.zoom = clampFiniteNumber(value, 0.25, 4, "zoom");
      break;
    }
    case "sp": {
      if (effects.speed !== undefined) {
        throw new StickerParseError("Hiệu ứng speed bị trùng");
      }
      const raw = entry.value !== undefined ? entry.value : null;
      let value;
      if (raw === null) {
        const next = inputTokens[entry.index + 1];
        if (next && /^-?\d+(?:[.,]\d+)?$/.test(next)) {
          value = Number(next.replace(",", "."));
        } else {
          throw new StickerParseError("speed cần giá trị số");
        }
      } else {
        value = Number(String(raw).replace(",", "."));
      }
      effects.speed = clampFiniteNumber(value, 0.25, 4, "speed");
      break;
    }
    case "pixel": {
      if (effects.pixel !== undefined) {
        throw new StickerParseError("Hiệu ứng pixel bị trùng");
      }
      const raw = entry.value !== undefined ? entry.value : null;
      let value;
      if (raw === null) {
        const next = inputTokens[entry.index + 1];
        if (next && /^-?\d+(?:[.,]\d+)?$/.test(next)) {
          value = Number(next);
        } else {
          value = 8;
        }
      } else {
        value = Number(raw);
      }
      effects.pixel = clampFiniteNumber(Math.round(value), 2, 64, "pixel");
      break;
    }
    case "rot": {
      if (effects.rotate !== undefined) {
        throw new StickerParseError("Hiệu ứng rotate bị trùng");
      }
      const raw = entry.value !== undefined ? entry.value : null;
      let value;
      if (raw === null) {
        const next = inputTokens[entry.index + 1];
        if (next && /^-?\d+(?:[.,]\d+)?$/.test(next)) {
          value = Number(next.replace(",", "."));
        } else {
          throw new StickerParseError("rotate cần giá trị số");
        }
      } else {
        value = Number(String(raw).replace(",", "."));
      }
      effects.rotate = parseRotationDegrees(clampFiniteNumber(value, -1e6, 1e6, "rotate"));
      break;
    }
    default:
      throw new StickerParseError(`Hiệu ứng không hợp lệ: ${entry.key}`);
  }
}

function collectEffectTokens(inputTokens, lowerTokens, limit) {
  const effects = {};
  for (let index = 0; index < limit; index += 1) {
    const rawToken = inputTokens[index];
    const lowerToken = lowerTokens[index];
    if (KNOWN_EFFECTS.has(lowerToken)) {
      applyEffectEntry(effects, { key: lowerToken, raw: rawToken, index }, inputTokens);
      continue;
    }
    const bracket = lowerToken.match(/^(-r|z|sp|pixel|rot|fh|fv|spin|cat|xp)(?:\(([^)]+)\))?$/);
    if (bracket) {
      applyEffectEntry(effects, { key: bracket[1], raw: rawToken, value: bracket[2], index }, inputTokens);
      continue;
    }
    const inline = lowerToken.match(/^(-r|z|sp|pixel|rot)(-?\d+(?:[.,]\d+)?)$/);
    if (inline) {
      applyEffectEntry(effects, { key: inline[1], raw: rawToken, value: inline[2], index }, inputTokens);
      continue;
    }
    if (/^-?\d+(?:[.,]\d+)?$/.test(lowerToken)) continue;
    if (/^https?:\/\//i.test(rawToken)) continue;
    throw new StickerParseError(`Hiệu ứng không hợp lệ: ${rawToken}`);
  }
  return effects;
}

function parseNumericToken(rawToken, prefixKey) {
  const match = String(rawToken).match(/^-?\d+(?:[.,]\d+)?$/);
  if (!match) return null;
  const numeric = Number(rawToken.replace(",", "."));
  if (!Number.isFinite(numeric)) return null;
  return numeric;
}

function parseRotationDegrees(value) {
  const normalized = ((value % 360) + 360) % 360;
  if (normalized > 180) return normalized - 360;
  return normalized;
}

function findLeadingEffectBoundary(inputTokens, lowerTokens) {
  let index = 0;
  while (index < inputTokens.length) {
    const lowerToken = lowerTokens[index];
    if (KNOWN_EFFECTS.has(lowerToken)) {
      if (
        (lowerToken === "-r" || lowerToken === "z" || lowerToken === "sp" || lowerToken === "pixel" || lowerToken === "rot") &&
        index + 1 < inputTokens.length &&
        /^-?\d+(?:[.,]\d+)?$/.test(lowerTokens[index + 1])
      ) {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (/^(-r|z|sp|pixel|rot|fh|fv|spin|cat|xp)(?:\(([^)]+)\))?$/.test(lowerToken)) {
      index += 1;
      continue;
    }
    if (/^(-r|z|sp|pixel|rot)(-?\d+(?:[.,]\d+)?)$/.test(lowerToken)) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

export function parseStickerArgs(tokens, options = {}) {
  const inputTokens = tokenize(tokens);
  const rawInputText = typeof tokens === "string" ? tokens : (Array.isArray(tokens) ? tokens.join(" ") : "");
  const hasMediaReference = Boolean(options.hasMediaReference);
  const forceAiMode = Boolean(options.forceAiMode);

  if (inputTokens.length === 0) {
    if (forceAiMode) {
      if (hasMediaReference) {
        return {
          source: "ai",
          payload: { kind: "ai", prompt: DEFAULT_AI_PROMPT, reference: "reply" },
          effects: {},
          animation: {},
        };
      }
      throw new StickerParseError("Cần prompt AI hoặc reply ảnh");
    }
    if (hasMediaReference) {
      return {
        source: "media",
        payload: { kind: "media", reference: "reply" },
        effects: {},
        animation: {},
      };
    }
    throw new StickerParseError(STICKER_USAGE_GUIDE);
  }

  const lowerTokens = inputTokens.map((token) => token.toLowerCase());

  let source = null;
  let sourceIndex = -1;
  for (let index = 0; index < lowerTokens.length; index += 1) {
    const lower = lowerTokens[index];
    if (SOURCE_MODES.has(lower)) {
      source = lower;
      sourceIndex = index;
      break;
    }
  }

  if (source !== null) {
    const nextToken = lowerTokens[sourceIndex + 1];
    if (nextToken && SOURCE_MODES.has(nextToken)) {
      throw new StickerParseError("Chỉ được dùng một trong text, textvd hoặc ai");
    }
  }

  if (source === null && forceAiMode) {
    const effectBoundary = findLeadingEffectBoundary(inputTokens, lowerTokens);
    const effects = collectEffectTokens(inputTokens, lowerTokens, effectBoundary);
    const prompt = inputTokens.slice(effectBoundary).join(" ").trim();
    const reference = hasMediaReference ? "reply" : null;
    if (!prompt && !reference) {
      throw new StickerParseError("Cần prompt AI hoặc reply ảnh");
    }
    if (prompt.length > 500) {
      throw new StickerParseError("Prompt AI tối đa 500 ký tự");
    }
    return {
      source: "ai",
      payload: {
        kind: "ai",
        prompt: prompt || DEFAULT_AI_PROMPT,
        reference,
      },
      effects,
      animation: {},
    };
  }

  if (source === null) {
    const urlIndex = inputTokens.findIndex((token) => /^https?:\/\//i.test(token));
    if (urlIndex >= 0) {
      const mediaEffects = collectEffectTokens(inputTokens, lowerTokens, inputTokens.length);
      return {
        source: "media",
        payload: { kind: "media", url: inputTokens[urlIndex] },
        effects: mediaEffects,
        animation: {},
      };
    }
    if (hasMediaReference) {
      const mediaEffects = collectEffectTokens(inputTokens, lowerTokens, inputTokens.length);
      return {
        source: "media",
        payload: { kind: "media", reference: "reply" },
        effects: mediaEffects,
        animation: {},
      };
    }
    throw new StickerParseError(`Không tìm thấy URL media hay nguồn text/textvd/ai!\n\n${STICKER_USAGE_GUIDE}`);
  }

  const effects = sourceIndex >= 0
    ? collectEffectTokens(inputTokens, lowerTokens, sourceIndex)
    : collectEffectTokens(inputTokens, lowerTokens, inputTokens.length);

  const restTokens = inputTokens.slice(sourceIndex + 1);
  let payload;
  if (source === "text") {
    let text = restTokens.join(" ").trim();
    if (rawInputText) {
      const match = rawInputText.match(/(?:^|\s)text(?:\s+([\s\S]*)|$)/i);
      if (match && match[1]) text = match[1].trim();
    }
    if (!text) throw new StickerParseError("Thiếu nội dung text");
    if (text.length > 200) {
      throw new StickerParseError("Nội dung text tối đa 200 ký tự");
    }
    payload = { kind: "text", text };
  } else if (source === "textvd") {
    const colorToken = restTokens[0];
    if (!colorToken) throw new StickerParseError("Thiếu màu cho textvd");
    const colorKey = COLOR_ALIASES[String(colorToken).toLowerCase()] ?? COLOR_ALIASES[normalizeAliasKey(colorToken)];
    if (!colorKey) {
      throw new StickerParseError(`Màu textvd không hợp lệ: ${colorToken}`);
    }
    let text = restTokens.slice(1).join(" ").trim();
    if (rawInputText) {
      const match = rawInputText.match(/(?:^|\s)textvd\s+\S+(?:\s+([\s\S]*)|$)/i);
      if (match && match[1]) text = match[1].trim();
    }
    if (!text) throw new StickerParseError("Thiếu nội dung textvd");
    if (text.length > 200) {
      throw new StickerParseError("Nội dung textvd tối đa 200 ký tự");
    }
    payload = { kind: "textvd", color: colorKey, text };
  } else if (source === "ai") {
    let prompt = restTokens.join(" ").trim();
    if (rawInputText) {
      const match = rawInputText.match(/(?:^|\s)ai(?:\s+([\s\S]*)|$)/i);
      if (match && match[1]) prompt = match[1].trim();
    }
    const reference = hasMediaReference ? "reply" : null;
    if (!prompt && !reference) {
      throw new StickerParseError("Cần prompt AI hoặc reply ảnh");
    }
    if (prompt.length > 500) {
      throw new StickerParseError("Prompt AI tối đa 500 ký tự");
    }
    payload = {
      kind: "ai",
      prompt: prompt || DEFAULT_AI_PROMPT,
      reference,
    };
  } else {
    throw new StickerParseError("Chế độ nguồn không hỗ trợ");
  }

  return {
    source,
    payload,
    effects,
    animation: {},
  };
}

export const __test = {
  COLOR_ALIASES,
  DEFAULT_AI_PROMPT,
  parseRotationDegrees,
};
