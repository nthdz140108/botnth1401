export const SENDTASK_TIMEZONE = "Asia/Ho_Chi_Minh";

const HOUR = 60;

function ttl(minutes) {
  return minutes;
}

export const SENDTASK_SOURCE_KINDS = Object.freeze(["girl-video", "tiktok-search", "zing-chart"]);
// "sex" là danh mục girl-video hợp lệ (pool local video/vdsex); các lịch mặc định vẫn chọn "sexy" (video/vdsexy)
export const SENDTASK_GIRL_CATEGORIES = Object.freeze(["default", "sexy", "cosplay", "anime", "sex"]);
// Fallback chỉ cho phép pool video nội bộ: nguồn ngoài lỗi/rỗng mới chuyển sang,
// tránh vòng lặp fallback giữa các nguồn phụ thuộc API bên thứ ba.
export const SENDTASK_FALLBACK_KINDS = Object.freeze(["girl-video"]);
export const SENDTASK_FALLBACK_DEFAULTS = Object.freeze({ kind: "girl-video", category: "default" });

function girl(category, caption, timeToLive) {
  return { kind: "girl-video", category, caption, ttlMinutes: ttl(timeToLive) };
}

function tiktok(queryTemplate, caption, timeToLive) {
  return { kind: "tiktok-search", queryTemplate, caption, ttlMinutes: ttl(timeToLive) };
}

function zing(caption, timeToLive) {
  return { kind: "zing-chart", queryTemplate: null, caption, ttlMinutes: ttl(timeToLive) };
}

export function buildDefaultSendtaskSchedules() {
  // Toàn bộ lịch bắn cố định ở phút :05 của từng giờ (cron "5 H * * *").
  return [
    { id: "hour-00", enabled: true, cron: "5 0 * * *", ...girl("sexy", `> SendTask 00:05 <\nĐêm rồi chúc bạn ngủ ngon!` + `\n\nCung cấp vitamin gái cực sexy cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-01", enabled: true, cron: "5 1 * * *", ...girl("cosplay", `> SendTask 01:05 <\nChào một ngày mới đầy năng lượng!` + `\n\nGiải trí với nữ cosplay cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-02", enabled: true, cron: "5 2 * * *", ...girl("sexy", `> SendTask 02:05 <\nChào bạn, một ngày tràn ngập năng lượng tích cực!` + `\n\nCung cấp vitamin gái cực sexy cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-03", enabled: true, cron: "5 3 * * *", ...zing(`> SendTask 03:05 <\nNgày mới chúc các bạn may mắn!\n\n`, HOUR * 3) },
    { id: "hour-04", enabled: true, cron: "5 4 * * *", ...tiktok(`nhạc chill cảnh đẹp {{timestamp}}`, `> SendTask 04:05 <\nChào buổi sáng\ncùng đón nắng ấm suơng mưa nhé!` + `\n\nGiải trí một chút để bớt căng thẳng thôi nào!!!`, HOUR * 3) },
    { id: "hour-05", enabled: true, cron: "5 5 * * *", ...girl("anime", `> SendTask 05:05 <\nBình minh rùi dậy đi thuiii!` + `\n\nGiải trí anime cho bớt căng não anh em nhé!!!`, HOUR * 1) },
    { id: "hour-06", enabled: true, cron: "5 6 * * *", ...tiktok(`ngắm bình minh chill {{timestamp}}`, `> SendTask 06:05 <\nThức dậy cho một ngày mới\ndầy năng lượng thôi nào!` + `\n\nĐón bình minh ngày mới cùng tớ nhé!!!`, HOUR * 3) },
    { id: "hour-07", enabled: true, cron: "5 7 * * *", ...girl("anime", `> SendTask 07:05 <\nChào một buổi sáng làm việc đầy năng lượng!` + `\n\nGiải trí anime cho bớt căng não anh em nhé!!!`, HOUR * 1) },
    { id: "hour-08", enabled: true, cron: "5 8 * * *", ...girl("cosplay", `> SendTask 08:05 <\nChào một buổi sáng cùng đón nắng ấm suơng mưa nhé!` + `\n\nGiải trí với nữ cosplay cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-09", enabled: true, cron: "5 9 * * *", ...tiktok(`nhạc chill cảnh đẹp {{timestamp}}`, `> SendTask 09:05 <\nChào bạn\nHãy làm việc vui vẻ!` + `\n\nGiải trí một chút để bớt căng thẳng thôi nào!!!`, HOUR * 3) },
    { id: "hour-10", enabled: true, cron: "5 10 * * *", ...girl("default", `> SendTask 10:05 <\nChào một buổi trưa đầy năng lượng!` + `\n\nCung cấp vitamin gái cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-11", enabled: true, cron: "5 11 * * *", ...girl("sexy", `> SendTask 11:05 <\nChào một buổi trưa đầy năng lượng!` + `\n\nCung cấp vitamin gái cực sexy cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-12", enabled: true, cron: "5 12 * * *", ...girl("cosplay", `> SendTask 12:05 <\nChào một buổi trưa đầy năng lượng!` + `\n\nGiải trí với nữ cosplay cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-13", enabled: true, cron: "5 13 * * *", ...girl("anime", `> SendTask 13:05 <\nChào một buổi chiều đầy năng lượng!` + `\n\nGiải trí anime cho bớt căng não anh em nhé!!!`, HOUR * 1) },
    { id: "hour-14", enabled: true, cron: "5 14 * * *", ...girl("default", `> SendTask 14:05 <\nChào một buổi chiều đầy năng lượng!` + `\n\nCung cấp vitamin gái cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-15", enabled: true, cron: "5 15 * * *", ...girl("sexy", `> SendTask 15:05 <\nChào một buổi xế chiều đầy năng lượng!` + `\n\nCung cấp vitamin gái cực sexy cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-16", enabled: true, cron: "5 16 * * *", ...girl("cosplay", `> SendTask 16:05 <\nChào một buổi xế chiều đầy năng lượng!` + `\n\nGiải trí với nữ cosplay cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-17", enabled: true, cron: "5 17 * * *", ...tiktok(`ngắm hoàng hôn chill {{timestamp}}`, `> SendTask 17:05 <\nChúc buổi chiều thật chill và vui vẻ nhé!` + `\n\nĐón hoàng hôn ánh chiều tà thôi nào!!!`, HOUR * 2) },
    { id: "hour-18", enabled: true, cron: "5 18 * * *", ...girl("sexy", `> SendTask 18:05 <\nChào một chiều đầy năng lượng!` + `\n\nCung cấp vitamin gái cực sexy cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-19", enabled: true, cron: "5 19 * * *", ...tiktok(`âm nhạc nhẹ nhàng`, `> SendTask 19:05 <\nChúc các bạn một buổi tối vui vẻ bên gia đình!` + `\n\nThư giãn cuối ngày thôi nào!!!`, HOUR * 1) },
    { id: "hour-20", enabled: true, cron: "5 20 * * *", ...zing(`> SendTask 20:05 <\nGiải trí bằng 1 bài nhạc` + `\ncho thời gian tỉnh táo nhất trong ngày!\n\n`, HOUR * 2) },
    { id: "hour-21", enabled: true, cron: "5 21 * * *", ...girl("sexy", `> SendTask 21:05 <\nChào một buổi tối đầy năng lượng!` + `\n\nCung cấp vitamin gái cực sexy cho anh em đây!!!`, HOUR * 1) },
    { id: "hour-22", enabled: true, cron: "5 22 * * *", ...zing(`> SendTask 22:05 <\nChúc các bạn ngủ ngon!\n\n`, HOUR * 5) },
    { id: "hour-23", enabled: true, cron: "5 23 * * *", ...girl("cosplay", `> SendTask 23:05 <\nChào một buổi tối, ngủ ngon nhaa moa <3!` + `\n\nGiải trí với nữ cosplay cho anh em đây!!!`, HOUR * 1) },
  ].map((entry) => ({
    timezone: SENDTASK_TIMEZONE,
    fallbackKind: SENDTASK_FALLBACK_DEFAULTS.kind,
    fallbackCategory: SENDTASK_FALLBACK_DEFAULTS.category,
    ...entry,
  }));
}

export const SENDTASK_RESPONSE_TEMPLATES = Object.freeze({
  on: "Đã bật chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!",
  off: "Đã tắt chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!",
  toggle: "Đã {state} chức năng gửi nội dung tự động sau mỗi giờ vào nhóm này!",
});

export const SENDTASK_RETRY = Object.freeze({
  maxRetries: 2,
  backoffMs: 1500,
  disableOnMissingGroup: true,
});

export function renderSendtaskQuery(template, vars = {}) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === "timestamp") return String(vars.timestamp ?? Date.now());
    return String(vars[key] ?? "");
  });
}
