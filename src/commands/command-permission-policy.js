import { ROLE_LEVELS } from "../utils/role-policy.js";

export const EFFECT_SCOPES = Object.freeze(["user", "group", "multiGroup", "global"]);
export const RISKS = Object.freeze(["normal", "sensitive", "high", "critical"]);

const HIGH = (effectScope = "global", risk = "critical") =>
  Object.freeze({ requiredRole: "adminLevelHigh", effectScope, risk });
const BOT = (effectScope = "multiGroup", risk = "normal") =>
  Object.freeze({ requiredRole: "adminBot", effectScope, risk });
const BOX = (effectScope = "group", risk = "normal") =>
  Object.freeze({ requiredRole: "adminBox", effectScope, risk });
const MEMBER = (effectScope = "user", risk = "normal") =>
  Object.freeze({ requiredRole: "member", effectScope, risk });

export const COMMAND_PERMISSION_POLICY = Object.freeze({
  // Phase 1
  mybot: MEMBER("user", "sensitive"),
  help: MEMBER(),
  command: MEMBER(),
  simsimi: MEMBER(),
  data: HIGH("global", "high"),
  name: MEMBER("user", "sensitive"),
  gemini: MEMBER(),
  "gemini make": HIGH("global", "high"),
  i4tiktok: MEMBER(),
  gpt: MEMBER(),
  google: MEMBER(),
  image: MEMBER(),
  pinterest: MEMBER(),
  girl: MEMBER(),
  boy: MEMBER(),
  cosplay: MEMBER(),
  anime: MEMBER(),
  vdgirl: MEMBER(),

  // Phase 2
  deepseek: MEMBER(),
  "analysis-image": MEMBER(),
  "create-image": HIGH("global", "high"),
  "google-search-ai": MEMBER(),
  vdsexy: MEMBER(),
  vdsex: MEMBER(),
  vdcos: MEMBER(),
  vdanime: MEMBER(),
  vdboy: MEMBER(),
  ff: MEMBER(),
  mail10p: MEMBER(),
  les: MEMBER(),
  quocgia: MEMBER(),
  gay: MEMBER(),
  dam: MEMBER(),
  info: MEMBER(),
  object: MEMBER(),
  card: MEMBER(),
  group: MEMBER("group", "sensitive"),
  detail: MEMBER(),
  speedtest: MEMBER(),
  topchat: MEMBER("group"),

  // Phase 3
  lamnet: MEMBER(),
  sticker: MEMBER(),
  stkmeme: MEMBER(),
  gifmeme: MEMBER(),
  giftxt: MEMBER("group"),
  editvideo: MEMBER(),
  gifvd: MEMBER(),
  giftext: MEMBER(),
  stickercustom: MEMBER(),
  phatnguoi: MEMBER(),
  gif: MEMBER(),

  // Phase 4
  tiktok: MEMBER(),
  spotify: MEMBER(),
  youtube: MEMBER(),
  capcut: MEMBER(),
  download: MEMBER(),
  dich: MEMBER(),
  qrbank: MEMBER(),
  getlink: MEMBER(),
  getvoice: MEMBER(),
  checkip: MEMBER(),
  checkdomain: MEMBER(),
  cpus: HIGH("user", "high"),
  thoitiet: MEMBER(),
  prservice: BOX("group", "sensitive"),

  // Phase 5
  spamjoin: HIGH("multiGroup", "critical"),
  ketban: HIGH("user", "high"),
  kb: HIGH("user", "high"),
  soundcloud: MEMBER(),
  zingmp3: MEMBER(),
  zingchart: MEMBER(),
  nhaccuatui: MEMBER(),
  voice: MEMBER(),
  truyencuoi: MEMBER(),
  tarrot: MEMBER(),
  poststatus: HIGH("global", "high"),
  createqr: MEMBER(),
  scanqr: MEMBER(),
  scanapi: HIGH("global", "high"),
  sendresourcesfile: HIGH("global", "high"),
  sendsrc: HIGH("global", "high"),
  sendresourcesvideo: HIGH("global", "high"),
  sendresourcesimage: HIGH("global", "high"),
  sendresourcesaudio: HIGH("global", "high"),

  // Phase 6
  lich: MEMBER(),
  manager: BOX("group", "sensitive"),
  listmute: BOX("group"),
  settinggroup: BOX("group", "sensitive"),
  changelink: BOX("group", "sensitive"),
  listadmin: BOT("multiGroup", "sensitive"),
  add: BOT("global", "sensitive"),
  remove: BOT("global", "sensitive"),
  setcmd: HIGH("global", "critical"),
  bot: BOX("group", "sensitive"),
  autodownload: BOX("group", "sensitive"),
  mute: BOX("group"),
  unmute: BOX("group"),
  prefix: HIGH("global", "high"),
  sendtext: BOX("group", "sensitive"),

  // Phase 7
  sendstk: BOX("group"),
  sendtask: BOX("group", "sensitive"),
  welcome: BOX("group", "sensitive"),
  bye: BOX("group", "sensitive"),
  updategroup: BOX("group", "sensitive"),
  antibadword: BOX("group", "sensitive"),
  antisetup: BOX("group", "sensitive"),
  antibot: BOX("group", "sensitive"),
  antiblockall: BOX("group", "sensitive"),
  antisdt: BOX("group", "sensitive"),
  antilink: BOX("group", "sensitive"),
  autojoin: HIGH("group", "high"),
  antijoin: BOX("group", "sensitive"),
  antiforward: BOX("group", "sensitive"),
  antitag: BOX("group", "sensitive"),
  antistickerlag: BOX("group", "sensitive"),
  antisticker: BOX("group", "sensitive"),
  antigif: BOX("group", "sensitive"),
  antispam: BOX("group", "sensitive"),
  antinude: BOX("group", "sensitive"),
  antiundo: BOX("group", "sensitive"),

  // Phase 8
  antiall: BOX("group", "sensitive"),
  antitext: BOX("group", "sensitive"),
  antifile: BOX("group", "sensitive"),
  antiphoto: BOX("group", "sensitive"),
  antivoice: BOX("group", "sensitive"),
  onlytext: BOX("group", "sensitive"),
  ban: HIGH("global", "high"),
  unban: HIGH("global", "high"),
  tagall: BOX("group"),
  spamgroup: HIGH("multiGroup", "critical"),
  scold: BOX("group"),
  approve: BOX("group"),
  learn: BOX("group"),
  learnnow: BOX("group"),
  unlearn: BOX("group"),
  reply: BOX("group"),
  autoreply: BOX("group", "sensitive"),
  undo: BOX("group"),
  todo: BOT("multiGroup"),
  sendp: HIGH("global", "high"),

  // Phase 9
  kick: BOX("group"),
  block: BOX("group"),
  taget: BOX("group"),
  kickall: HIGH("group", "critical"),
  blockall: HIGH("group", "critical"),
  keygold: HIGH("group", "critical"),
  keysilver: HIGH("group", "critical"),
  unkey: HIGH("group", "critical"),
  join: BOT("multiGroup"),
  leave: HIGH("group", "critical"),
  listgroups: BOT("multiGroup"),
  scangroups: BOT("multiGroup"),
  deletemessage: BOX("group"),
  restart: HIGH("global", "critical"),
  listblockbot: BOT("multiGroup"),
  blockbot: BOT("multiGroup", "sensitive"),
  unblockbot: BOT("multiGroup", "sensitive"),
  whitelist: BOX("group", "sensitive"),
  alias: HIGH("global", "high"),
  downloadresource: HIGH("global", "high"),
  deleteresource: HIGH("global", "high"),
  keylist: BOX("group"),

  // Phase 10
  kickimg: HIGH("group", "critical"),
  blockimg: HIGH("group", "critical"),
  kickallmember: HIGH("group", "critical"),
  blockallmember: HIGH("group", "critical"),
  leaveallbox: HIGH("global", "critical"),
  leavelock: HIGH("multiGroup", "critical"),
  dispersegroup: HIGH("group", "critical"),
  target: HIGH("group", "critical"),
  key: HIGH("group", "critical"),

  // Phase 11
  fb: MEMBER(),
  createimageai: HIGH("global", "high"),
  genminiv1: MEMBER(),
  addfriend: HIGH("user", "high"),
  addfriendall: HIGH("group", "high"),
  undofriend: HIGH("user", "high"),
  rejectfriend: HIGH("user", "high"),
  listfriend: HIGH("user", "high"),
  waitinglist: HIGH("user", "sensitive"),
  vdvuto: MEMBER(),
  vdchill: MEMBER(),
  vdsad: MEMBER(),
  vdtet: MEMBER(),
  stickerzalo: MEMBER(),
  dinhgiasim: HIGH("user", "high"),
  benchmark: HIGH("user", "high"),
  acclq: HIGH("user", "high"),
  replytag: BOX("group"),
  reverse: MEMBER(),
  checkgiavang: MEMBER(),
  emote: MEMBER(),
  checkorder: MEMBER(),
  showcode: HIGH("user", "high"),
  "4k": MEMBER(),
  cardqr: MEMBER(),
  call: HIGH("user", "critical"),
  lovelink: MEMBER(),
  myheart: MEMBER(),
  checklq: MEMBER(),
  datavideo: HIGH("global", "high"),
  googlesearchai: MEMBER(),
  qrheart: MEMBER(),
  nhacnho: MEMBER(),
  fakecccd: HIGH("user", "high"),
  check: MEMBER(),
  admin: BOT("global", "sensitive"),
  mybank: HIGH("user", "high"),
  removefriend: HIGH("user", "high"),
  senduser: HIGH("global", "high"),
  prwelcome: BOX("group"),
  antivideo: BOX("group", "sensitive"),
  antistickereffect: BOX("group", "sensitive"),
  rutgonlink: MEMBER(),
  testflight: MEMBER(),
  cmdadd: HIGH("global", "sensitive"),
  "sticker ai": HIGH("global", "high"),
  locmem: HIGH("group", "critical"),
});

const ADMIN_TIER_ACTIONS = Object.freeze({
  plain: Object.freeze({ requiredRole: "adminLevelHigh", effectScope: "global", risk: "sensitive" }),
  box: Object.freeze({ requiredRole: "adminBot", effectScope: "group", risk: "sensitive" }),
  qtv: Object.freeze({ requiredRole: "adminLevelHigh", effectScope: "global", risk: "critical" }),
});

const REMOVE_ALIASES = new Set(["remove", "rm", "del"]);

const GROUP_CREATE_ACTIONS = new Set([
  "create-group",
  "creategr",
  "invite-box",
  "invitebox",
  "group-autolock",
]);

const NAME_ACCOUNT_ACTIONS = new Set([
  "rename",
  "myaccount",
  "myacc",
  "mysetting",
  "setaccount",
  "setavatar-account",
  "setavataraccount",
  "setavtacc",
  "setavt",
]);

const MYBOT_ADMIN_ACTIONS = new Set([
  "add",
  "remove",
  "del",
  "delete",
  "set",
  "config",
  "reset",
  "restart",
  "reload",
  "switch",
  "logout",
  "clean",
]);

function firstToken(value) {
  return String(value ?? "").trim().toLowerCase();
}

function resolveAdminActionPolicy(alias, args) {
  const tokens = [alias, ...args].map(firstToken).filter(Boolean);
  const actionIndex = tokens.findIndex((token) => token === "add" || REMOVE_ALIASES.has(token));
  if (actionIndex === -1) return null;
  const mode = tokens[actionIndex] === "add" ? "add" : "remove";
  const tierToken = tokens[actionIndex + 1];
  if (tierToken === "box") return ADMIN_TIER_ACTIONS.box;
  if (tierToken === "qtv") return ADMIN_TIER_ACTIONS.qtv;
  return ADMIN_TIER_ACTIONS.plain;
}

function matchesAnyToken(candidates, predicate) {
  return candidates.some(predicate);
}

export function resolveActionPolicy(canonicalName, { alias = "", args = [], scope = "group" } = {}) {
  const candidates = [alias, ...(Array.isArray(args) ? args : [])].map(firstToken);
  switch (canonicalName) {
    case "admin":
      return resolveAdminActionPolicy(alias, args);
    case "group":
      if (matchesAnyToken(candidates, (token) => GROUP_CREATE_ACTIONS.has(token))) {
        return Object.freeze({ requiredRole: "adminLevelHigh", effectScope: "global", risk: "high" });
      }
      return null;
    case "name":
      if (matchesAnyToken(candidates, (token) => NAME_ACCOUNT_ACTIONS.has(token))) {
        return Object.freeze({ requiredRole: "adminLevelHigh", effectScope: "user", risk: "high" });
      }
      return null;
    case "mybot":
      if (matchesAnyToken(candidates.slice(1), (token) => MYBOT_ADMIN_ACTIONS.has(token))) {
        return Object.freeze({ requiredRole: "adminLevelHigh", effectScope: "global", risk: "high" });
      }
      return null;
    default:
      return null;
  }
}

function highestRole(left, right) {
  return ROLE_LEVELS[left] >= ROLE_LEVELS[right] ? left : right;
}

export function normalizeCanonicalCommand(value) {
  return String(value ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export function failClosedPolicy(canonicalName) {
  return Object.freeze({
    requiredRole: "adminLevelHigh",
    effectScope: "global",
    risk: "critical",
    source: "fail-closed",
    canonicalName: normalizeCanonicalCommand(canonicalName),
    failClosed: true,
  });
}

export function resolveRequiredRole({
  canonicalName,
  alias = "",
  args = [],
  scope = "group",
  definition = null,
} = {}) {
  const name = normalizeCanonicalCommand(canonicalName || definition?.name || "");
  const baseEntry = COMMAND_PERMISSION_POLICY[name];
  if (!baseEntry) {
    return failClosedPolicy(name || alias);
  }

  const actionPolicy = resolveActionPolicy(name, { alias, args, scope });
  const requiredRole = actionPolicy
    ? highestRole(baseEntry.requiredRole, actionPolicy.requiredRole)
    : baseEntry.requiredRole;
  const risk = actionPolicy?.risk ?? baseEntry.risk;
  const effectScope = actionPolicy?.effectScope ?? baseEntry.effectScope;

  return Object.freeze({
    requiredRole,
    effectScope,
    risk,
    source: actionPolicy ? "action-policy" : "command-policy",
    canonicalName: name,
    failClosed: false,
  });
}

export function roleSatisfies(callerRole, requiredRole) {
  const callerName = callerRole === "all" ? "member" : callerRole === "adminBotOrGroup" ? "adminBox" : callerRole;
  const requiredName = requiredRole === "all" ? "member" : requiredRole === "adminBotOrGroup" ? "adminBox" : requiredRole;
  const caller = ROLE_LEVELS[callerName] ?? -1;
  const required = ROLE_LEVELS[requiredName] ?? Number.MAX_SAFE_INTEGER;
  return caller >= required;
}

export function hasPermissionPolicyEntry(canonicalName) {
  return Object.prototype.hasOwnProperty.call(
    COMMAND_PERMISSION_POLICY,
    normalizeCanonicalCommand(canonicalName),
  );
}
