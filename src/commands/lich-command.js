import LunarCalendar from "lunar-calendar";
import { safeThreadType } from "./shared/command-input-utils.js";

const WEEKDAYS_VI = [
  "Chủ Nhật",
  "Thứ Hai",
  "Thứ Ba",
  "Thứ Tư",
  "Thứ Năm",
  "Thứ Sáu",
  "Thứ Bảy",
];

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

  const ganZhiParts = [
    lunar.GanZhiYear ? `Năm ${lunar.GanZhiYear}` : "",
    lunar.GanZhiMonth ? `Tháng ${lunar.GanZhiMonth}` : "",
    lunar.GanZhiDay ? `Ngày ${lunar.GanZhiDay}` : "",
  ].filter(Boolean);

  return {
    solar: `${pad(day)}/${pad(month)}/${year}`,
    lunar: `${lunar.lunarDayName || pad(lunar.lunarDay)}/${pad(lunar.lunarMonth)}${lunar.lunarYear ? `/${lunar.lunarYear}` : ""} (Am lich)`,
    details: `${WEEKDAYS_VI[date.getDay()]}${ganZhiParts.length ? ` | ${ganZhiParts.join(" - ")}` : ""}`.trim(),
  };
}

function parseMonth(args = []) {
  if (args[0]?.toLowerCase() !== "month") return null;
  const first = String(args[1] ?? "").trim();
  const second = String(args[2] ?? "").trim();

  let year = NaN;
  let month = NaN;

  if (second && /^\d{1,2}$/.test(first) && /^\d{4}$/.test(second)) {
    month = Number(first);
    year = Number(second);
  } else if (second && /^\d{4}$/.test(first) && /^\d{1,2}$/.test(second)) {
    year = Number(first);
    month = Number(second);
  } else if (!second) {
    const ymMatch = first.match(/^(\d{4})[-/](\d{1,2})$/);
    const myMatch = first.match(/^(\d{1,2})[-/](\d{4})$/);
    if (ymMatch) {
      year = Number(ymMatch[1]);
      month = Number(ymMatch[2]);
    } else if (myMatch) {
      month = Number(myMatch[1]);
      year = Number(myMatch[2]);
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (!Number.isInteger(month) || !Number.isInteger(year) || month < 1 || month > 12 || year < 1891 || year > 2100) {
    return null;
  }
  return { year, month };
}

function parseSpecificSolarDate(arg) {
  const raw = String(arg ?? "").trim();
  if (!raw) return null;
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const ymd = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  let day = NaN;
  let month = NaN;
  let year = NaN;
  if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else if (ymd) {
    year = Number(ymd[1]);
    month = Number(ymd[2]);
    day = Number(ymd[3]);
  } else {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1891 || year > 2100) {
    return null;
  }
  const constructed = new Date(year, month - 1, day);
  if (
    constructed.getFullYear() !== year ||
    constructed.getMonth() !== month - 1 ||
    constructed.getDate() !== day
  ) {
    return null;
  }
  return constructed;
}

function formatMonth(year, month) {
  const calendar = LunarCalendar.calendar(year, month);
  if (!calendar?.monthData) throw new RangeError("Month is not supported");
  const lines = calendar.monthData.map((entry) =>
    `${pad(entry.day)}/${pad(entry.month)}: ${entry.lunarDayName || pad(entry.lunarDay)}/${pad(entry.lunarMonth)} (Âm lịch)`,
  );
  return `📅 Lịch tháng ${pad(month)}/${year} — Calendar ${pad(month)}/${year}\n${lines.join("\n")}`;
}

function send(api, message, msg) {
  return api.sendMessage({ msg, quote: message }, message.threadId, safeThreadType(message));
}

export async function handleCalendarCommand(api, message, args = []) {
  try {
    if (args[0]?.toLowerCase() === "month") {
      const month = parseMonth(args);
      if (!month) {
        await send(
          api,
          message,
          "❌ Tháng không hợp lệ (Invalid month). Cú pháp: lich month <MM> <YYYY> hoặc lich month <YYYY-MM>.",
        );
        return false;
      }
      await send(api, message, formatMonth(month.year, month.month));
      return true;
    }

    let targetDate = new Date();
    if (args[0]) {
      const parsedDate = parseSpecificSolarDate(args[0]);
      if (!parsedDate) {
        await send(
          api,
          message,
          "❌ Ngày không hợp lệ (Invalid date). Cú pháp: lich [dd/mm/yyyy | month <MM> <YYYY> | month <YYYY-MM>].",
        );
        return false;
      }
      targetDate = parsedDate;
    }

    const formatted = formatCalendarDate(targetDate);
    await send(
      api,
      message,
      `📅 Dương lịch: ${formatted.solar}\n🌙 Âm lịch: ${formatted.lunar}\n📌 Chi tiết: ${formatted.details}`,
    );
    return true;
  } catch (error) {
    await send(api, message, `❌ Không thể tra cứu lịch: ${error.message}`);
    return false;
  }
}

export { parseMonth, formatMonth };
