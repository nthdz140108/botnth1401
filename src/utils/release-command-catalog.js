import defaults from "./release-command-defaults.js";

export const RELEASE_COMMAND_METADATA_PATCHES = Object.freeze({
  antilink: Object.freeze({
    syntax: "{p}antilink [on|off|add|remove|list|clearall]",
    description: "Chống gửi link trong nhóm kèm quản lý danh sách link cho phép",
  }),
  antisdt: Object.freeze({
    syntax: "{p}antisdt [on|off|add|remove|list|clearall]",
    description: "Chống gửi số điện thoại trong nhóm kèm quản lý whitelist SĐT",
  }),
  add: Object.freeze({
    syntax: "{p}add member <@tag|UID> | {p}admin add [box|qtv] <UID>",
    description: "Thêm thành viên vào nhóm hoặc hướng dẫn cấp quyền quản trị bot",
  }),
  remove: Object.freeze({
    syntax: "{p}remove member <@tag|UID> | {p}admin remove [box|qtv] <UID>",
    description: "Mời thành viên ra khỏi nhóm hoặc hướng dẫn gỡ quyền quản trị bot",
  }),
  keysilver: Object.freeze({
    syntax: "{p}keysilver [@người_tag | reply | UID]",
  }),
  keylist: Object.freeze({
    description: "Xem danh sách Trưởng nhóm (Key Vàng) và Phó nhóm (Key Bạc)",
  }),
  locmem: Object.freeze({
    syntax: "{p}locmem [số_ngày]",
    description: "Lọc thành viên không tương tác trong nhóm (mặc định 7 ngày, hỗ trợ 7-30 ngày)",
  }),
  getuser: Object.freeze({
    permission: "adminBox",
    scope: "group",
  }),
  spamgroup: Object.freeze({
    syntax: "{p}spamgroup <nội dung>|<delay_ms>|<số_lần> | {p}spamgroup stop",
  }),
  i4tiktok: Object.freeze({
    syntax: "{p}i4tiktok <username>",
  }),
  checklq: Object.freeze({
    scope: "private",
    description: "Kiểm tra thông tin tài khoản Liên Quân (chỉ hỗ trợ trong tin nhắn riêng tư)",
  }),
  autodownload: Object.freeze({
    syntax: "{p}autodownload [on|off]",
  }),
  simsimi: Object.freeze({
    scope: "private",
    syntax: "{p}simsimi <nội dung> (chỉ dùng trong chat riêng)",
  }),
  "sticker ai": Object.freeze({
    description: "Tạo hoặc biến đổi sticker bằng mô hình AI",
  }),
  sticker: Object.freeze({
    syntax: "{p}sticker [xp|spin|text <chữ>|textvd <chữ>]",
  }),
  gifmeme: Object.freeze({
    syntax: "{p}gifmeme <từ khoá cần tìm>",
  }),
  vdsex: Object.freeze({
    permission: "adminLevelHigh",
  }),
  vdboy: Object.freeze({
    description: "Gửi video ngắn về trai đẹp bất kỳ",
  }),
  data: Object.freeze({
    permission: "adminLevelHigh",
  }),
  tarrot: Object.freeze({
    description: "Rút bài bói vui kèm giọng đọc giải đoán",
  }),
  mybank: Object.freeze({
    countdown: 10,
  }),
  lich: Object.freeze({
    syntax: "{p}lich [dd/mm/yyyy | month <mm> <yyyy> | month <yyyy-mm>]",
  }),
  antivoice: Object.freeze({
    syntax: "{p}antivoice [on|off]",
  }),
});

export function enrichCommandMetadata(command) {
  if (!command || typeof command !== "object") return command;
  const key = String(command.name || "").trim().toLowerCase();
  const patch = RELEASE_COMMAND_METADATA_PATCHES[key];
  if (!patch) return command;
  return { ...command, ...patch };
}

export function enrichCommandList(commands = []) {
  if (!Array.isArray(commands)) return [];
  return commands.map(enrichCommandMetadata);
}

// Versioned deployments keep assets/mybot in shared storage. Ship additive
// command metadata as release code so an update never overwrites live settings.
export function withReleaseCommandDefaults(catalog = {}, env = process.env) {
  if (!env.MYBOT_CODE_COMMIT) return catalog;
  const commands = Array.isArray(catalog.commands) ? catalog.commands : [];
  const names = new Set(commands.map((command) => String(command?.name || "").trim().toLowerCase()));
  const additions = defaults.filter((command) => !names.has(command.name));
  return { ...catalog, commands: [...commands, ...structuredClone(additions)] };
}
