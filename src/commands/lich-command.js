import LunarCalendar from "lunar-calendar";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(value) {
  return String(value).padStart(2, "0");
}

function getDateParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("Invalid date");
  }
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

export function formatCalendarDate(date = new Date()) {
  const { year, month, day } = getDateParts(date);
  const lunar = LunarCalendar.solarToLunar(year, month, day);
  if (!lunar) throw new RangeError("Date is outside the supported lunar calendar range");

  return {
    solar: `${pad(day)}/${pad(month)}/${year}`,
    lunar: `${lunar.lunarDayName || lunar.lunarDay}/${lunar.lunarMonth} (Am lich)`,
    details: `${WEEKDAYS[date.getDay()]} | ${lunar.GanZhiYear || ""} ${lunar.GanZhiDay || ""}`.trim(),
  };
}

function parseMonth(args) {
  if (args[0]?.toLowerCase() !== "month") return null;
  const value = args[1] ?? "";
  const match = value.match(/^(\d{4})-(\d{2})$/);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  if (!match || month < 1 || month > 12 || year < 1891 || year > 2100) return null;
  return { year, month };
}

function formatMonth(year, month) {
  const calendar = LunarCalendar.calendar(year, month);
  if (!calendar?.monthData) throw new RangeError("Month is not supported");
  const lines = calendar.monthData.map((entry) =>
    `${pad(entry.day)}/${pad(entry.month)}: ${entry.lunarDayName || entry.lunarDay}/${entry.lunarMonth}`,
  );
  return `Calendar ${pad(month)}/${year}\n${lines.join("\n")}`;
}

function send(api, message, msg) {
  return api.sendMessage({ msg, quote: message }, message.threadId, message.type);
}

export async function handleCalendarCommand(api, message, args = []) {
  try {
    const month = parseMonth(args);
    if (args[0]?.toLowerCase() === "month" && !month) {
      await send(api, message, "Invalid month. Use: lich month YYYY-MM.");
      return false;
    }
    if (month) {
      await send(api, message, formatMonth(month.year, month.month));
      return true;
    }

    const formatted = formatCalendarDate(new Date());
    await send(api, message, `Solar: ${formatted.solar}\nLunar: ${formatted.lunar}\n${formatted.details}`);
    return true;
  } catch (error) {
    await send(api, message, `Calendar unavailable: ${error.message}`);
    return false;
  }
}

export { parseMonth, formatMonth };
