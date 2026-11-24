import { MessageStyle, MultiMsgStyle, MessageType } from "../../../api-zalo/models/Message.js";

export const SAFE_COLORS = Object.freeze([
  "db342e", // Red
  "15a85f", // Green
  "f7b503", // Yellow / Gold
  "0084ff", // Blue
  "ff69b4", // Pink
  "8a2be2", // Purple
  "00ffff", // Cyan
  "ffffff", // White
  "ff4500", // Orange Red
  "32cd32", // Lime Green
  "1e90ff", // Dodger Blue
  "9370db", // Medium Purple
  "ffa500", // Orange
  "00fa9a", // Spring Green
]);

export const COLOR_NAMES = Object.freeze({
  red: "db342e",
  green: "15a85f",
  yellow: "f7b503",
  gold: "f7b503",
  blue: "0084ff",
  pink: "ff69b4",
  purple: "8a2be2",
  cyan: "00ffff",
  white: "ffffff",
  orange: "ffa500",
  black: "000000",
  lime: "32cd32",
});

export const VALID_TYPES = Object.freeze(["bold", "italic", "underline", "strike", "none"]);
export const SIZE_MIN = 10;
export const SIZE_MAX = 24;

export const DEFAULT_STYLE = Object.freeze({
  icon: "🤖",
  color: "db342e",
  size: Object.freeze({
    nameServer: 18,
    text: 14,
  }),
  type: Object.freeze({
    nameServer: Object.freeze(["bold"]),
    text: Object.freeze(["none"]),
  }),
});

export function normalizeColor(color, defaultColor = DEFAULT_STYLE.color) {
  if (typeof color !== "string") return defaultColor;
  const lower = color.trim().toLowerCase();
  if (COLOR_NAMES[lower]) {
    return COLOR_NAMES[lower];
  }
  let clean = lower.replace(/^#/, "");
  if (clean.length === 3) {
    clean = clean.split("").map((c) => c + c).join("");
  }
  if (/^[0-9a-f]{6}$/.test(clean)) {
    return clean;
  }
  return defaultColor;
}

export function normalizeSize(size, defaultSize = 14) {
  const num = parseInt(size, 10);
  if (!Number.isInteger(num)) return defaultSize;
  return Math.max(SIZE_MIN, Math.min(SIZE_MAX, num));
}

export function normalizeType(typeInput, defaultType = ["none"]) {
  const list = Array.isArray(typeInput)
    ? typeInput
    : typeof typeInput === "string"
      ? typeInput.split(/[\s,]+/)
      : [];

  const valid = list
    .map((t) => String(t || "").trim().toLowerCase())
    .filter((t) => VALID_TYPES.includes(t));

  if (valid.length === 0) return Array.isArray(defaultType) ? defaultType : [defaultType];
  if (valid.includes("none")) {
    return ["none"];
  }
  return [...new Set(valid)];
}

export function validateStyle(style) {
  const errors = [];
  if (!style || typeof style !== "object") {
    errors.push("style must be an object");
    return { ok: false, errors };
  }

  if (style.icon !== undefined) {
    if (typeof style.icon !== "string" || style.icon.trim().length === 0 || style.icon.length > 10) {
      errors.push("style.icon must be a string of length 1-10");
    }
  }

  if (style.color !== undefined) {
    const raw = String(style.color).trim().toLowerCase();
    const isNamed = Boolean(COLOR_NAMES[raw]);
    const cleanHex = raw.replace(/^#/, "");
    const isHex = /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(cleanHex);
    if (!isNamed && !isHex) {
      errors.push(`style.color '${style.color}' is not a valid hex color code or color name`);
    }
  }

  if (style.size !== undefined) {
    if (typeof style.size !== "object" || style.size === null) {
      errors.push("style.size must be an object containing nameServer and/or text (10-24)");
    } else {
      if (style.size.nameServer !== undefined) {
        const s = parseInt(style.size.nameServer, 10);
        if (!Number.isInteger(s) || s < SIZE_MIN || s > SIZE_MAX) {
          errors.push(`style.size.nameServer must be an integer between ${SIZE_MIN} and ${SIZE_MAX}`);
        }
      }
      if (style.size.text !== undefined) {
        const s = parseInt(style.size.text, 10);
        if (!Number.isInteger(s) || s < SIZE_MIN || s > SIZE_MAX) {
          errors.push(`style.size.text must be an integer between ${SIZE_MIN} and ${SIZE_MAX}`);
        }
      }
    }
  }

  if (style.type !== undefined) {
    if (typeof style.type !== "object" || style.type === null) {
      errors.push("style.type must be an object containing nameServer and/or text");
    } else {
      for (const field of ["nameServer", "text"]) {
        if (style.type[field] !== undefined) {
          const arr = Array.isArray(style.type[field]) ? style.type[field] : [style.type[field]];
          for (const item of arr) {
            if (!VALID_TYPES.includes(String(item).toLowerCase())) {
              errors.push(`style.type.${field} contains invalid type '${item}'. Valid types: ${VALID_TYPES.join(", ")}`);
            }
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function normalizeStyle(inputStyle = {}) {
  const safe = inputStyle || {};
  return {
    icon: typeof safe.icon === "string" && safe.icon.trim() ? safe.icon.trim() : DEFAULT_STYLE.icon,
    color: normalizeColor(safe.color, DEFAULT_STYLE.color),
    size: {
      nameServer: normalizeSize(safe.size?.nameServer, DEFAULT_STYLE.size.nameServer),
      text: normalizeSize(safe.size?.text, DEFAULT_STYLE.size.text),
    },
    type: {
      nameServer: normalizeType(safe.type?.nameServer, DEFAULT_STYLE.type.nameServer),
      text: normalizeType(safe.type?.text, DEFAULT_STYLE.type.text),
    },
  };
}

/**
 * Creates styled message payload for Zalo
 */
export function buildStyledMessagePayload({
  style = DEFAULT_STYLE,
  nameServer = "Bot Zalo",
  senderName = "",
  isGroup = false,
  text = "",
  stateIcon = "",
  ttl = 60000,
  quote = null,
  mentions = [],
  skipStyle = false,
  skipQuote = false,
  plain = false,
} = {}) {
  const normStyle = normalizeStyle(style);
  const iconStr = normStyle.icon ? `${normStyle.icon} ` : "";
  const headerLine = `${iconStr}${nameServer}`.trim();
  const groupPrefix = isGroup && senderName ? `${senderName}\n` : "";
  const stateSuffix = stateIcon ? `\n${stateIcon}` : "";
  const fullMsg = `${groupPrefix}${headerLine}\n${text}${stateSuffix}`;

  if (plain || skipStyle) {
    return {
      msg: fullMsg,
      ttl,
      linkOn: false,
      ...(skipQuote || !quote ? {} : { quote }),
      ...(mentions && mentions.length > 0 ? { mentions } : {}),
    };
  }

  const headerOffset = groupPrefix.length;
  const headerLength = headerLine.length;

  const isNameBold = normStyle.type.nameServer.includes("bold");
  const isNameItalic = normStyle.type.nameServer.includes("italic");
  const isNameUnderline = normStyle.type.nameServer.includes("underline");
  const isNameStrike = normStyle.type.nameServer.includes("strike");

  const styles = [
    MessageStyle(
      headerOffset,
      headerLength,
      normStyle.color,
      String(normStyle.size.nameServer),
      isNameBold,
      isNameItalic,
      isNameUnderline,
      isNameStrike,
      false
    ),
  ];

  // If text has custom styling (not just none)
  const isTextBold = normStyle.type.text.includes("bold");
  const isTextItalic = normStyle.type.text.includes("italic");
  const isTextUnderline = normStyle.type.text.includes("underline");
  const isTextStrike = normStyle.type.text.includes("strike");
  const textOffset = headerOffset + headerLength + 1;
  const textLength = text.length;

  if (textLength > 0 && (isTextBold || isTextItalic || isTextUnderline || isTextStrike || normStyle.size.text !== 14)) {
    styles.push(
      MessageStyle(
        textOffset,
        textLength,
        normStyle.color,
        String(normStyle.size.text),
        isTextBold,
        isTextItalic,
        isTextUnderline,
        isTextStrike,
        false
      )
    );
  }

  const multiStyle = MultiMsgStyle(styles);

  return {
    msg: fullMsg,
    style: multiStyle,
    ttl,
    linkOn: false,
    ...(skipQuote || !quote ? {} : { quote }),
    ...(mentions && mentions.length > 0 ? { mentions } : {}),
  };
}
