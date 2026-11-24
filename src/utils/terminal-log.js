import process from "node:process";
import chalk, { Chalk } from "chalk";

const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_RE, "");
}

function clean(value) {
  return stripAnsi(value).replace(/\r/g, "").replace(CONTROL_RE, "");
}

function wrap(value, width = 100) {
  const text = clean(value);
  const limit = Math.max(1, width);
  return text.split("\n").flatMap((line) => {
    if (!line || line.length <= limit) return [line];
    const result = [];
    let current = "";
    for (const token of line.split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) {
        if (current && !current.endsWith(" ")) current += " ";
        continue;
      }
      const candidate = current ? current + token : token;
      if (candidate.length <= limit || !current) {
        current = candidate;
      } else {
        result.push(current.trimEnd());
        current = token;
      }
    }
    if (current) result.push(current.trimEnd());
    return result;
  });
}

function resolveColorLevel(stream, requested) {
  if (process.env.NO_COLOR !== undefined) return 0;
  if (requested !== undefined) return Number(requested) || 0;
  if (process.env.MYBOT_FORCE_COLOR !== undefined) {
    return process.env.MYBOT_FORCE_COLOR === "true" ? 1 : Number(process.env.MYBOT_FORCE_COLOR) || 1;
  }
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR === "true" ? 1 : Number(process.env.FORCE_COLOR) || 1;
  return stream?.isTTY ? 1 : 0;
}

function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function colorByTone(colors, value, tone) {
  const text = clean(value);
  switch (tone) {
    case "cyan":
      return colors.cyan(text);
    case "yellow":
      return colors.yellow(text);
    case "magenta":
      return colors.magenta(text);
    case "red":
      return colors.red(text);
    case "green":
      return colors.green(text);
    case "blue":
      return colors.blue(text);
    case "gray":
      return colors.gray(text);
    case "white":
    default:
      return colors.white(text);
  }
}

function colorUrls(colors, value) {
  return clean(value).replace(/https?:\/\/\S+/g, (url) => colors.blue(url));
}

function colorContent(colors, value, tone) {
  const text = clean(value);
  return text.split(/(https?:\/\/\S+)/g).map((part) => {
    if (/^https?:\/\//.test(part)) return colors.blue(part);
    return colorByTone(colors, part, tone);
  }).join("");
}

function defaultToneForField(label, value) {
  if (label === "GROUP") return "cyan";
  if (label === "FROM") return "yellow";
  if (label === "TYPE") return "magenta";
  if (label === "MEMBERS") return "green";
  if (label === "CONTENT" && /^Sticker ID:/i.test(clean(value))) return "green";
  if (label === "CONTENT") return "green";
  return "white";
}

function defaultValueToneForField(label, value, tone) {
  if (label === "CONTENT" && !/^Sticker ID:/i.test(clean(value))) return "white";
  return tone;
}

export function createTerminalLogger(options = {}) {
  const stream = options.stream || process.stdout;
  const tty = options.tty ?? stream.isTTY === true;
  const colors = new Chalk({ level: resolveColorLevel(stream, options.colorLevel) });
  const getNow = typeof options.now === "function" ? options.now : () => new Date();
  const configuredWidth = options.width;
  let stats = { messages: 0, retries: 0 };
  let status = "OFFLINE";
  let statusWritten = false;

  const writeRaw = (value) => {
    try {
      stream.write(value);
    } catch {
      try {
        process.stdout.write(clean(value));
      } catch {}
    }
  };

  const statusRow = () => `${status} | messages: ${stats.messages} | retries: ${stats.retries}`;
  const clearStatus = () => {
    if (!tty) return;
    if (statusWritten) writeRaw("\u001b[1A\u001b[2K");
    statusWritten = false;
  };
  const redrawStatus = () => {
    if (!tty) return;
    writeRaw(colors.bold(statusRow()) + "\n");
    statusWritten = true;
  };

  const badge = {
    private: colors.yellow("[PRIVATE]"),
    group: colors.cyan("[GROUP]"),
    "group-event": colors.magenta("[GROUP EVENT]"),
    launcher: colors.gray("[LAUNCHER]"),
    listener: colors.green("[LISTENER]"),
    dashboard: colors.blue("[DASHBOARD]"),
    system: colors.gray("[SYSTEM]"),
  };
  const levelColor = { info: colors.blue, success: colors.green, warn: colors.yellow, error: colors.red };

  const renderFields = (fields = []) => {
    const maxLabel = Math.max(7, ...fields.map((field) => clean(field.label).length));
    const streamWidth = Number(configuredWidth || stream?.columns || 100);
    const width = Math.max(40, streamWidth || 100);
    return fields.flatMap((field, index) => {
      const label = clean(field.label).toUpperCase();
      const value = clean(field.value ?? "");
      const branch = index === fields.length - 1 ? "`--" : "+--";
      const labelPart = `${label.padEnd(maxLabel)} `;
      const prefix = `${branch} ${labelPart}`;
      const valueWidth = Math.max(1, width - stripAnsi(prefix).length);
      const meta = field.meta ? ` (${clean(field.meta)})` : "";
      const lines = wrap(value + meta, valueWidth);
      const tone = field.tone || defaultToneForField(label, value);
      const valueTone = field.valueTone || defaultValueToneForField(label, value, tone);
      return lines.map((line, lineIndex) => {
        const linePrefix = lineIndex === 0 ? prefix : `${" ".repeat(prefix.length)}`;
        const coloredPrefix = colorByTone(colors, linePrefix, tone);
        const coloredValue = label === "CONTENT" ? colorContent(colors, line, valueTone) : colorByTone(colors, line, tone);
        return coloredPrefix + coloredValue;
      });
    });
  };

  const logger = {
    write(event = {}) {
      try {
        if (event.countAsMessage) stats.messages += 1;
        if (event.countAsRetry) stats.retries += 1;
        const streamWidth = Number(configuredWidth || stream?.columns || 100);
        const width = Math.max(40, streamWidth || 100);
        const lines = Array.isArray(event.fields)
          ? renderFields(event.fields)
          : Array.isArray(event.lines)
            ? event.lines.flatMap((line) => wrap(line, width))
            : wrap(event.lines || "", width);
        const title = clean(event.title || "");
        const renderedTitle = (levelColor[event.level] || colors.white)(title);
        const header = `${badge[event.scope] || badge.system} ${colors.gray(formatLocalTimestamp(getNow()))}`;
        const blockLines = [title ? `${header} ${renderedTitle}` : header, ...lines];
        const block = blockLines.join("\n") + "\n";
        if (tty) clearStatus();
        writeRaw(block);
        if (tty) redrawStatus();
        if (!tty) statusWritten = false;
      } catch (error) {
        try {
          process.stdout.write(`${clean(event.title || error.message)}\n`);
        } catch {}
      }
    },
    writeBanner({ name = "MYBOT", botName = "admin", status: nextStatus = "ONLINE" } = {}) {
      status = clean(nextStatus).toUpperCase();
      writeRaw(colors.bold(`${clean(name)} / ${clean(botName)}\n`));
      redrawStatus();
    },
    getStats() {
      return { ...stats };
    },
    reset() {
      stats = { messages: 0, retries: 0 };
      statusWritten = false;
    },
  };
  return logger;
}

export const terminalLogger = createTerminalLogger();
export function terminalLog(event) {
  return terminalLogger.write(event);
}
