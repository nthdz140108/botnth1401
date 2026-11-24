export function parseDuration(timeStr) {
  if (timeStr === undefined || timeStr === null || typeof timeStr !== "string") return null;
  const trimmed = timeStr.trim();
  if (trimmed === "-1") return -1;
  if (!trimmed) return null;

  const regex = /^(\d+)(s|m|min|h|d|w|mon|y)$/i;
  const match = trimmed.match(regex);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = {
    s: 1000,
    m: 1000 * 60,
    min: 1000 * 60,
    h: 1000 * 60 * 60,
    d: 1000 * 60 * 60 * 24,
    w: 1000 * 60 * 60 * 24 * 7,
    mon: 1000 * 60 * 60 * 24 * 30,
    y: 1000 * 60 * 60 * 24 * 365,
  };

  return value * (multipliers[unit] || 0);
}

export function parseSelector(token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    return { type: "self" };
  }

  const trimmed = token.trim();
  if (trimmed.toLowerCase() === "all") {
    return { type: "all" };
  }

  if (trimmed.toLowerCase() === "self") {
    return { type: "self" };
  }

  if (trimmed.includes(",")) {
    const items = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
    return { type: "multiple", raw: trimmed, items };
  }

  if (/^\d+$/.test(trimmed)) {
    if (trimmed.length >= 10) {
      return { type: "uid", value: trimmed };
    }
    return { type: "index", value: parseInt(trimmed, 10) };
  }

  return { type: "uid", value: trimmed };
}

export function parseMyBotCommand(input = {}, options = {}) {
  let content = "";
  let aliasCommand = "mybot";
  let prefix = "";

  if (typeof input === "string") {
    content = input;
    if (typeof options === "object" && options !== null) {
      aliasCommand = options.aliasCommand || "mybot";
      prefix = options.prefix || "";
    }
  } else if (typeof input === "object" && input !== null) {
    content = input.content || "";
    aliasCommand = input.aliasCommand || "mybot";
    prefix = input.prefix || "";
  }

  let rawText = String(content || "").trim();
  if ((rawText.startsWith("(") && rawText.endsWith(")")) ||
      (rawText.startsWith("<") && rawText.endsWith(">")) ||
      (rawText.startsWith("[") && rawText.endsWith("]"))) {
    rawText = rawText.slice(1, -1).trim();
  }
  const tokens = rawText.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return {
      action: "help",
      valid: true,
      rawAction: "",
      selector: { type: "self" },
      args: [],
    };
  }

  const isCleanShortcut = aliasCommand === "clean" || (tokens[0] && tokens[0].replace(prefix, "").toLowerCase() === "clean");

  let subCommand = "";
  let paramTokens = [];

  if (isCleanShortcut) {
    // If it's `!clean` or alias clean
    const firstWord = tokens[0].replace(prefix, "").toLowerCase();
    if (firstWord === "clean") {
      subCommand = "clean";
      paramTokens = tokens.slice(1);
    } else {
      subCommand = (tokens[1] || "clean").toLowerCase();
      paramTokens = tokens.slice(2);
    }
  } else {
    // Standard `!mybot <subCommand>` or `!mebot <subCommand>`
    if (tokens.length < 2) {
      return {
        action: "help",
        valid: true,
        rawAction: "",
        selector: { type: "self" },
        args: [],
      };
    }
    subCommand = (tokens[1] || "").toLowerCase();
    paramTokens = tokens.slice(2);
  }

  // Canonicalize action
  let canonicalAction = subCommand;
  switch (subCommand) {
    case "mebot":
    case "mybot":
      canonicalAction = paramTokens.length > 0 ? paramTokens[0].toLowerCase() : "help";
      paramTokens = paramTokens.slice(1);
      break;
    case "remove":
      canonicalAction = "delete";
      break;
    case "shutdown":
      canonicalAction = "stop";
      break;
    case "getlogin":
      canonicalAction = "qrlogin";
      break;
    case "create":
      canonicalAction = "create";
      break;
    case "login":
      canonicalAction = "create";
      break;
    case "active":
      canonicalAction = "active";
      break;
    case "giahan":
      canonicalAction = "extend";
      break;
    case "info":
    case "showinfo":
      canonicalAction = "showinfo";
      break;
    default:
      break;
  }

  const knownActions = new Set([
    "help",
    "qtv",
    "manager",
    "list",
    "detail",
    "start",
    "restart",
    "stop",
    "delete",
    "qrlogin",
    "create",
    "active",
    "set",
    "style",
    "showinfo",
    "extend",
    "minus",
    "clean",
    "reject",
    "approve",
    "nameserver",
    "update",
    "getupdate",
    "notify",
    "cmd",
  ]);

  if (!knownActions.has(canonicalAction)) {
    return {
      action: "unknown",
      rawAction: subCommand,
      valid: false,
      selector: { type: "self" },
      args: paramTokens,
    };
  }

  const result = {
    action: canonicalAction,
    rawAction: subCommand,
    valid: true,
    selector: { type: "self" },
    args: paramTokens,
  };

  switch (canonicalAction) {
    case "cmd": {
      // Syntax: !mybot cmd <index|uid> (command) or legacy <command>
      if (paramTokens.length === 0) {
        result.valid = false;
        result.errorReason = "missing_selector_and_payload";
        break;
      }

      const firstToken = paramTokens[0];
      if (firstToken.startsWith("(") || firstToken.startsWith("<")) {
        result.valid = false;
        result.errorReason = "missing_selector";
        break;
      }

      const parsedSelector = parseSelector(firstToken);
      if (parsedSelector.type !== "index" && parsedSelector.type !== "uid") {
        result.valid = false;
        result.errorReason = "invalid_selector";
        break;
      }
      result.selector = parsedSelector;

      const subCmdIdx = rawText.toLowerCase().indexOf(subCommand);
      let afterSubCmd = subCmdIdx !== -1 ? rawText.slice(subCmdIdx + subCommand.length).trim() : "";
      
      if (afterSubCmd.startsWith(firstToken)) {
        afterSubCmd = afterSubCmd.slice(firstToken.length).trim();
      }

      const isRoundBracket = afterSubCmd.startsWith("(") && afterSubCmd.endsWith(")");
      const isAngleBracket = afterSubCmd.startsWith("<") && afterSubCmd.endsWith(">");

      if (!isRoundBracket && !isAngleBracket) {
        result.valid = false;
        result.errorReason = "missing_or_invalid_brackets";
        break;
      }

      const innerContent = afterSubCmd.slice(1, -1);
      if (!innerContent.trim()) {
        result.valid = false;
        result.errorReason = "empty_payload";
        break;
      }

      result.commandText = innerContent.trim();
      result.rawCommandText = afterSubCmd;
      break;
    }

    case "set": {
      // Syntax: !mybot set <field> <value> [selector]
      if (paramTokens.length < 2) {
        result.valid = false;
        result.errorReason = "missing_set_field_or_value";
        break;
      }
      const rawField = paramTokens[0].toLowerCase();
      let fieldKey = null;
      if (["name", "ownername", "owner"].includes(rawField)) fieldKey = "ownerName";
      else if (["nameserver", "displayname"].includes(rawField)) fieldKey = "nameServer";
      else if (["description", "desc"].includes(rawField)) fieldKey = "description";
      else if (["botinfo", "info"].includes(rawField)) fieldKey = "botInfo";
      else if (["typeplatform", "platform"].includes(rawField)) fieldKey = "typePlatform";
      else {
        result.valid = false;
        result.errorReason = "disallowed_or_invalid_field";
        break;
      }

      result.setField = fieldKey;
      result.setValue = paramTokens.slice(1).join(" ");
      break;
    }

    case "style": {
      // Syntax: !mybot style <size|color|type|icon|reset> [args]
      if (paramTokens.length === 0) {
        result.styleSubAction = "show";
        break;
      }
      const styleType = paramTokens[0].toLowerCase();
      result.styleSubAction = styleType;

      if (styleType === "reset") {
        // !mybot style reset
      } else if (styleType === "color") {
        // !mybot style color <hex|colorName> [target]
        result.styleColor = paramTokens[1] || "";
        result.styleTarget = (paramTokens[2] || "all").toLowerCase();
      } else if (styleType === "icon") {
        // !mybot style icon <icon>
        result.styleIcon = paramTokens.slice(1).join(" ");
      } else if (styleType === "size") {
        // Target-first syntax: !mybot style size [nameServer|text|all] [10->24]
        // Legacy syntax: !mybot style size 18 14 OR !mybot style size 16 all
        const token1 = paramTokens[1] ? paramTokens[1].toLowerCase() : "";
        const token2 = paramTokens[2] ? paramTokens[2].toLowerCase() : "";

        if (["nameserver", "text", "all"].includes(token1)) {
          const target = token1 === "nameserver" ? "nameServer" : token1;
          const sizeVal = paramTokens[2] || "";
          result.styleTarget = target;
          result.styleSize = sizeVal;
          if (target === "nameServer") {
            result.styleSizeNameServer = sizeVal;
          } else if (target === "text") {
            result.styleSizeText = sizeVal;
          } else {
            result.styleSizeNameServer = sizeVal;
            result.styleSizeText = sizeVal;
          }
        } else if (/^\d+$/.test(token1)) {
          // Legacy syntax
          if (["nameserver", "text", "all"].includes(token2)) {
            const target = token2 === "nameserver" ? "nameServer" : token2;
            result.styleTarget = target;
            result.styleSize = paramTokens[1];
            if (target === "nameServer") {
              result.styleSizeNameServer = paramTokens[1];
            } else if (target === "text") {
              result.styleSizeText = paramTokens[1];
            } else {
              result.styleSizeNameServer = paramTokens[1];
              result.styleSizeText = paramTokens[1];
            }
          } else {
            result.styleTarget = token2 ? "both" : "all";
            result.styleSizeNameServer = paramTokens[1];
            result.styleSizeText = paramTokens[2] || paramTokens[1];
            result.styleSize = paramTokens[1];
          }
        } else {
          result.styleSizeNameServer = paramTokens[1] || "";
          result.styleSizeText = paramTokens[2] || "";
          result.styleTarget = "all";
        }
      } else if (styleType === "type") {
        // Target-first syntax: !mybot style type [nameServer|text|all] [bold,italic,underline,strike|none]
        // Legacy syntax: !mybot style type bold nameserver OR !mybot style type bold,italic all
        const token1 = paramTokens[1] ? paramTokens[1].toLowerCase() : "";
        if (["nameserver", "text", "all"].includes(token1)) {
          const target = token1 === "nameserver" ? "nameServer" : token1;
          result.styleTarget = target;
          result.styleType = paramTokens.slice(2).join(" ");
        } else {
          // Legacy syntax
          result.styleType = paramTokens[1] || "";
          const targetToken = (paramTokens[2] || "all").toLowerCase();
          result.styleTarget = targetToken === "nameserver" ? "nameServer" : targetToken;
        }
      }
      break;
    }

    case "active":
    case "showinfo":
    case "detail":
    case "start":
    case "restart":
    case "stop":
    case "delete":
    case "approve":
      if (paramTokens.length > 0) {
        result.selector = parseSelector(paramTokens[0]);
      }
      break;

    case "reject":
      if (paramTokens.length > 0) {
        result.selector = parseSelector(paramTokens[0]);
      }
      result.isPermanent = paramTokens.length > 1 && paramTokens[1] === "-1";
      break;

    case "extend":
    case "minus":
      if (paramTokens.length > 0) {
        result.selector = parseSelector(paramTokens[0]);
      }
      if (paramTokens.length > 1) {
        result.rawDuration = paramTokens[1];
        result.durationMs = parseDuration(paramTokens[1]);
      }
      break;

    case "nameserver":
      result.serverName = paramTokens.join(" ");
      break;

    case "notify":
      result.notifyMessage = paramTokens.join(" ");
      break;

    case "update":
      if (paramTokens.length > 0) {
        const firstParam = paramTokens[0].toLowerCase();
        if (firstParam === "name") {
          result.updateType = "name";
          result.updateValue = paramTokens.slice(1).join(" ");
        } else if (firstParam === "description") {
          result.updateType = "description";
          result.updateValue = paramTokens.slice(1).join(" ");
        } else {
          result.updateType = "credentials";
          result.imei = paramTokens[0];
          result.rawCookie = paramTokens[1] || "";
          result.userAgent = paramTokens.slice(2).join(" ") || "";
        }
      }
      break;

    case "create":
      if (paramTokens.length > 0) {
        result.imei = paramTokens[0];
        result.rawCookie = paramTokens[1] || "";
        result.userAgent = paramTokens.slice(2).join(" ") || "";
      }
      break;

    default:
      break;
  }

  return result;
}
