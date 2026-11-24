export const VIETNAM_TIMEZONE = "Asia/Ho_Chi_Minh";
export const TIMEZONE = VIETNAM_TIMEZONE;

/**
 * Returns YYYY-MM-DD formatted date string in Asia/Ho_Chi_Minh timezone.
 * @param {Date|number} [date=new Date()]
 * @returns {string}
 */
export function getVietnamDateKey(date = new Date()) {
  const d = typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-CA", { timeZone: VIETNAM_TIMEZONE }).format(d);
}

/**
 * Returns YYYY-MM formatted month string in Asia/Ho_Chi_Minh timezone.
 * @param {Date|number} [date=new Date()]
 * @returns {string}
 */
export function getVietnamMonthKey(date = new Date()) {
  return getVietnamDateKey(date).slice(0, 7);
}

/**
 * Returns individual date/time parts in Asia/Ho_Chi_Minh timezone.
 * @param {Date|number} [date=new Date()]
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, dateKey: string, monthKey: string }}
 */
export function getVietnamParts(date = new Date()) {
  const d = typeof date === "number" ? new Date(date) : date;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: VIETNAM_TIMEZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(formatter.formatToParts(d).map((p) => [p.type, p.value]));
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const second = parseInt(parts.second, 10);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  const monthKey = `${parts.year}-${parts.month}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateKey,
    monthKey,
  };
}

/**
 * Returns array of exact `count` calendar date keys (YYYY-MM-DD)
 * immediately preceding the given dateKey or Date in Asia/Ho_Chi_Minh.
 * Returns days in descending order ([today-1, today-2, ...]).
 *
 * @param {Date|number|string} [reference=new Date()]
 * @param {number} [count=7]
 * @returns {string[]}
 */
export function getConsecutiveCalendarDays(reference = new Date(), count = 7) {
  let refDate;
  if (typeof reference === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reference)) {
    refDate = new Date(`${reference}T12:00:00+07:00`);
  } else if (typeof reference === "number") {
    refDate = new Date(reference);
  } else if (reference instanceof Date) {
    refDate = reference;
  } else {
    refDate = new Date();
  }

  const parts = getVietnamParts(refDate);
  const baseNoonUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 5, 0, 0);

  const days = [];
  const limit = Math.max(1, Number(count) || 7);
  for (let i = 1; i <= limit; i++) {
    const dayMs = baseNoonUtc - i * 24 * 60 * 60 * 1000;
    days.push(getVietnamDateKey(new Date(dayMs)));
  }
  return days;
}
