import { createCommandDefinition, createCommandRegistry } from "./command-router.js";

export { tagHandlerRef };

export const PHASE_1_COMMANDS = Object.freeze([
  "mybot", "help", "command", "simsimi", "data", "name", "gemini",
  "gemini make", "i4tiktok", "gpt", "google", "image", "pinterest",
  "girl", "boy", "cosplay", "anime", "vdgirl",
]);

const phase1Metadata = Object.freeze({
  mybot: { aliases: ["mebot", "clean"], permission: "all", type: 1, countdown: 30, instanceScope: "main", executionLane: "heavy" },
  help: { aliases: ["menu"], permission: "all", type: 1, countdown: 5, executionLane: "fast" },
  command: { aliases: ["cmd", "command-manager"], permission: "all", type: 1, countdown: 5, executionLane: "fast" },
  simsimi: { aliases: ["sim"], permission: "all", type: 1, countdown: 30, scope: "private", requiredConfig: ["SIMSIMI_API_KEY"], executionLane: "fast" },
  data: { permission: "all", type: 1, countdown: 3, executionLane: "fast" },
  name: { aliases: ["rename", "myaccount", "myacc", "mysetting", "setaccount", "setavatar-account", "setavatarbox", "setavt", "setavataraccount", "setavtacc"], permission: "all", type: 3, countdown: 3, executionLane: "fast" },
  gemini: { aliases: ["gem", "chat"], permission: "all", type: 1, countdown: 60, requiredConfig: ["GEMINI_API_KEYS"], executionLane: "heavy" },
  "gemini make": { permission: "adminLevelHigh", type: 1, countdown: 90, executionLane: "heavy" },
  i4tiktok: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  gpt: { permission: "all", type: 1, countdown: 30, requiredConfig: ["KIRA_API_KEY"], executionLane: "heavy" },
  google: { aliases: ["gg", "search"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  image: { aliases: ["img"], permission: "all", type: 1, countdown: 120, executionLane: "heavy" },
  pinterest: { aliases: ["pin"], permission: "all", type: 1, countdown: 120, executionLane: "heavy" },
  girl: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  boy: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  cosplay: { aliases: ["cos"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  anime: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  vdgirl: { aliases: ["vdgai"], permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
});

const defaultLoader = (modulePath) => import(modulePath);

const defaultModulePromises = new Map();
const customLoaderCaches = new WeakMap();

function getLoaderCache(loadModule) {
  if (!loadModule || loadModule === defaultLoader) {
    return defaultModulePromises;
  }
  let cache = customLoaderCaches.get(loadModule);
  if (!cache) {
    cache = new Map();
    customLoaderCaches.set(loadModule, cache);
  }
  return cache;
}

function singleFlightLoader(modulePath, loadModule = defaultLoader) {
  const cache = getLoaderCache(loadModule);
  if (cache.has(modulePath)) {
    return cache.get(modulePath);
  }
  const promise = Promise.resolve().then(() => loadModule(modulePath)).catch((err) => {
    cache.delete(modulePath);
    throw err;
  });
  cache.set(modulePath, promise);
  return promise;
}

function tagHandlerRef(handler, ref) {
  try {
    if (typeof handler === "function") {
      Object.defineProperty(handler, "__handlerRef", { value: Object.freeze({ ...ref }), enumerable: false });
    }
  } catch {}
  return handler;
}

const lazy = (modulePath, exportName, invoke, loadModule = defaultLoader) => {
  const wrapped = async (context) => {
    const module = await singleFlightLoader(modulePath, loadModule);
    return invoke(module[exportName], context);
  };
  return tagHandlerRef(wrapped, { module: modulePath, export: exportName, source: modulePath });
};

const handlers = {
  mybot: lazy("./mybot/myBotManager.js", "mybotHandleCommand", (handler, { api, message, isAdminLevelHighest, aliasCommand, authorization, instanceAuthorization }) => handler(api, message, isAdminLevelHighest, aliasCommand, { instanceAuthorization: instanceAuthorization || authorization })),
  help: lazy("./instructions/help.js", "helpCommand", (handler, { api, message, groupAdmins, scope }) => scope === "group" ? handler(api, message, groupAdmins) : handler(api, message)),
  command: lazy("./instructions/help.js", "listCommands", (handler, { api, message, args }) => handler(api, message, args)),
  simsimi: lazy("../service-debug/chat-bot/simsimi/simsimi-api.js", "chatWithSimsimi", (handler, { api, message }) => handler(api, message)),
  data: lazy("../service-debug/utilities/data-manager.js", "handleDataCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  name: lazy("./bot-manager/account.js", "handleRenameCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  gemini: lazy("../service-debug/api-crawl/assistant-ai/gemini.js", "askGeminiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  "gemini make": lazy("./gemini-make-command.js", "handleGeminiMakeCommand", (handler, context) => handler(context)),
  i4tiktok: lazy("./lenh-debug/check/info-tiktok.js", "handleI4tiktokCommand", (handler, { api, message }) => handler(api, message)),
  gpt: lazy("../service-debug/api-crawl/content/gpt.js", "askGPTCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  google: lazy("../service-debug/api-crawl/google/google-search.js", "handleGoogleCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  image: lazy("../service-debug/api-crawl/google/google-image.js", "searchImageGoogle", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  pinterest: lazy("../service-debug/api-crawl/pinterest/pinterest-service.js", "searchImagePinterest", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  girl: lazy("../service-debug/chat-zalo/chat-special/send-image/send-image.js", "sendImage", (handler, { api, message }) => handler(api, message, "girl")),
  boy: lazy("../service-debug/chat-zalo/chat-special/send-image/send-image.js", "sendImage", (handler, { api, message }) => handler(api, message, "boy")),
  cosplay: lazy("../service-debug/chat-zalo/chat-special/send-image/send-image.js", "sendImage", (handler, { api, message }) => handler(api, message, "cosplay")),
  anime: lazy("../service-debug/chat-zalo/chat-special/send-image/send-image.js", "sendImage", (handler, { api, message }) => handler(api, message, "anime")),
  vdgirl: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "girl")),
};

export function createPhase1Registry(overrides = {}) {
  const definitions = PHASE_1_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase1Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase1Registry = createPhase1Registry();

export const PHASE_2_COMMANDS = Object.freeze([
  "deepseek", "analysis-image", "create-image", "google-search-ai",
  "vdsexy", "vdsex", "vdcos", "vdanime", "vdboy", "ff", "mail10p",
  "les", "quocgia", "gay", "dam", "info", "object", "card",
  "group", "detail", "speedtest", "topchat",
]);

const phase2Metadata = Object.freeze({
  deepseek: { aliases: ["deepchat"], permission: "all", type: 1, countdown: 30, requiredConfig: ["KIRA_API_KEY"], executionLane: "heavy" },
  "analysis-image": { aliases: ["analysis"], permission: "all", type: 1, countdown: 90, executionLane: "heavy" },
  "create-image": { aliases: ["createimg"], permission: "adminLevelHigh", type: 1, countdown: 90, executionLane: "heavy" },
  "google-search-ai": { aliases: ["aisearch"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  vdsexy: { permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
  vdsex: { permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
  vdcos: { permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
  vdanime: { permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
  vdboy: { permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
  ff: { permission: "all", type: 1, countdown: 15, minArgs: 1, executionLane: "fast" },
  mail10p: { permission: "all", type: 1, countdown: 60, executionLane: "fast" },
  les: { permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  quocgia: { permission: "all", type: 1, countdown: 30, minArgs: 1, executionLane: "fast" },
  gay: { permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  dam: { aliases: ["dâm"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  info: { aliases: ["i4"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  object: { aliases: ["obj"], permission: "all", type: 1, countdown: 5, executionLane: "fast" },
  card: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  group: { aliases: ["gr", "create-group", "creategr", "invite-box", "invitebox", "group-autolock", "kiemtra"], permission: "all", type: 1, countdown: 15, scope: "group", executionLane: "fast" },
  detail: { aliases: ["uptime", "xtt"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  speedtest: { aliases: ["spt", "spdt"], permission: "all", type: 1, countdown: 60, executionLane: "heavy" },
  topchat: { permission: "all", type: 1, countdown: 15, scope: "group", executionLane: "fast" },
});

const phase2Handlers = {
  deepseek: lazy("../service-debug/api-crawl/content/gpt.js", "askGPTCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  "analysis-image": lazy("../service-debug/api-crawl/assistant-ai/gemini.js", "askGeminiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  "create-image": lazy("./gemini-make-command.js", "handleGeminiMakeCommand", (handler, context) => handler(context)),
  "google-search-ai": lazy("../service-debug/api-crawl/google/google-search.js", "handleGoogleCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  vdsexy: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "sexy")),
  vdsex: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "sex")),
  vdcos: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "cosplay")),
  vdanime: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "anime")),
  vdboy: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "boy")),
  ff: lazy("./lenh-debug/check/info-ff.js", "handleFfCommand", (handler, { api, message }) => handler(api, message)),
  mail10p: lazy("./lenh-debug/hoang/hotmail.js", "handleMail10pCommand", (handler, { api, message }) => handler(api, message)),
  les: lazy("./lenh-debug/check/les.js", "handleLesCommand", (handler, { api, message }) => handler(api, message)),
  quocgia: lazy("./lenh-debug/check/quocgia.js", "handleQuocgiaCommand", (handler, { api, message }) => handler(api, message)),
  gay: lazy("./lenh-debug/check/gay.js", "handleGayCommand", (handler, { api, message }) => handler(api, message)),
  dam: lazy("./lenh-debug/check/dam.js", "handleDamCommand", (handler, { api, message }) => handler(api, message)),
  info: lazy("../service-debug/info-service/user-info.js", "userInfoCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  object: lazy("../service-debug/chat-zalo/chat-general/chat-all.js", "getObject", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  card: lazy("../service-debug/info-service/bussiness-card.js", "userBussinessCardCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  group: lazy("../service-debug/info-service/group-info.js", "groupInfoCommand", (handler, { api, message }) => handler(api, message)),
  detail: lazy("../service-debug/info-service/bot-info.js", "getBotDetails", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings)),
  speedtest: lazy("../service-debug/utilities/speedtest.js", "handleSpeedTestCommand", (handler, { api, message }) => handler(api, message)),
  topchat: lazy("../service-debug/info-service/rank-chat.js", "handleRankCommand", (handler, { api, message }) => handler(api, message)),
};

export function createPhase2Registry(overrides = {}) {
  const definitions = PHASE_2_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? phase2Handlers[name],
    ...phase2Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase2Registry = createPhase2Registry();

export const PHASE_3_COMMANDS = Object.freeze([
  "lamnet", "sticker", "stkmeme", "gifmeme", "giftxt", "editvideo",
  "gifvd", "giftext", "stickercustom", "phatnguoi", "gif",
]);

const phase3Metadata = Object.freeze({
  lamnet: { permission: "all", type: 1, countdown: 30, requiredConfig: ["HOANGDEV_API_KEY"], executionLane: "heavy" },
  sticker: { aliases: ["stk"], permission: "all", type: 1, countdown: 30, executionLane: "heavy" },
  stkmeme: { permission: "all", type: 1, countdown: 30, requiredConfig: ["TENOR_API_KEY"], minArgs: 1, executionLane: "fast" },
  gifmeme: { permission: "all", type: 1, countdown: 30, requiredConfig: ["TENOR_API_KEY"], minArgs: 1, executionLane: "fast" },
  giftxt: { permission: "all", type: 1, countdown: 30, scope: "group", minArgs: 1, executionLane: "fast" },
  editvideo: { permission: "all", type: 1, countdown: 30, requiredDependencies: ["ffmpeg"], executionLane: "heavy" },
  gifvd: { permission: "all", type: 1, countdown: 30, requiredDependencies: ["ffmpeg"], executionLane: "heavy" },
  giftext: { permission: "all", type: 1, countdown: 30, minArgs: 1, requiredDependencies: ["ffmpeg"], executionLane: "heavy" },
  stickercustom: { aliases: ["stkc"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  phatnguoi: { aliases: ["phng"], permission: "all", type: 1, countdown: 30, minArgs: 1, executionLane: "fast" },
  gif: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
});

const phase3Handlers = {
  lamnet: lazy("../service-debug/chat-zalo/chat-special/send-sticker/enhance-image.js", "handleEnhanceImageCommand", (handler, { api, message }) => handler(api, message)),
  sticker: lazy("../service-debug/chat-zalo/chat-special/send-sticker/sticker/index.js", "handleStickerCommand", (handler, { api, message, aliasCommand, isAdminLevelHighest }) => handler(api, message, { aliasCommand, isAdminLevelHighest })),
  stkmeme: lazy("../service-debug/chat-zalo/chat-special/send-sticker/stkmeme-utils.js", "handleStkmemeCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  gifmeme: lazy("../service-debug/chat-zalo/chat-special/send-gif/send-gif.js", "handleTenorGifCommand", (handler, { api, message }) => handler(api, message)),
  giftxt: lazy("./lenh-debug/send-all/giftext.js", "handleGiftext", (handler, { api, message }) => handler(api, message)),
  editvideo: lazy("../service-debug/chat-zalo/chat-special/edit-video/edit-video.js", "handleCutVideoCommand", (handler, { api, message }) => handler(api, message)),
  gifvd: lazy("../service-debug/chat-zalo/chat-special/gif-video/gifvd.js", "handleVideoToGifCommand", (handler, { api, message }) => handler(api, message)),
  giftext: lazy("../service-debug/chat-zalo/chat-special/send-gif/send-gif.js", "handleGifTextCommand", (handler, { api, message }) => handler(api, message)),
  stickercustom: lazy("../service-debug/chat-zalo/chat-special/send-sticker/customer-sticker.js", "handleSendCustomerStickerVideo", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  phatnguoi: lazy("../service-debug/api-crawl/content/phatnguoi.js", "handlePhatNguoiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  gif: lazy("../service-debug/chat-zalo/chat-special/send-gif/send-gif.js", "sendGifRemote", (handler, { api, message }) => handler(api, message)),
};

export function createPhase3Registry(overrides = {}) {
  const definitions = PHASE_3_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? phase3Handlers[name],
    ...phase3Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase3Registry = createPhase3Registry();

export const PHASE_4_COMMANDS = Object.freeze([
  "tiktok", "spotify", "youtube", "capcut", "download", "dich", "qrbank",
  "getlink", "getvoice", "checkip", "checkdomain", "cpus", "thoitiet", "prservice",
]);

const phase4Metadata = Object.freeze({
  tiktok: { aliases: ["tt"], permission: "all", type: 1, countdown: 30, minArgs: 1, requiredConfig: ["TIKTOK_SEARCH_API_URL", "TIKTOK_SEARCH_API_KEY"], executionLane: "heavy" },
  spotify: {
    aliases: ["sptf"],
    permission: "all",
    type: 1,
    countdown: 30,
    minArgs: 1,
    requiredConfig: [
      "SPOTIFY_CLIENT_ID",
      "SPOTIFY_CLIENT_SECRET",
      "SPOTIFY_DOWNLOADER_SECRET",
      "SPOTIFY_DOWNLOADER_PASSPHRASE",
    ],
    executionLane: "heavy",
  },
  youtube: { permission: "all", type: 1, countdown: 30, minArgs: 1, executionLane: "heavy" },
  capcut: { aliases: ["cpct"], permission: "all", type: 1, countdown: 30, minArgs: 1, executionLane: "heavy" },
  download: { aliases: ["dl", "down"], permission: "all", type: 1, countdown: 30, minArgs: 1, requiredConfig: ["HOANGDEV_API_KEY"], executionLane: "heavy" },
  dich: { permission: "all", type: 1, countdown: 30, minArgs: 1, requiredConfig: ["KIRA_API_KEY"], executionLane: "fast" },
  qrbank: { aliases: ["qrb"], permission: "all", type: 1, countdown: 15, minArgs: 1, executionLane: "fast" },
  getlink: { aliases: ["gl"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  getvoice: { aliases: ["gvc", "gvoice", "xuankien", "vc"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  checkip: { permission: "all", type: 1, countdown: 15, minArgs: 1, executionLane: "fast" },
  checkdomain: { permission: "all", type: 1, countdown: 15, minArgs: 1, executionLane: "fast" },
  cpus: { permission: "adminLevelHigh", type: 1, countdown: 60, risk: "high", executionLane: "heavy" },
  thoitiet: { permission: "all", type: 1, countdown: 30, minArgs: 1, requiredConfig: [["OPENWEATHER_API_KEY", "WEATHERAPI_KEY"]], executionLane: "fast" },
  prservice: { aliases: ["pr"], permission: "adminBox", type: 3, countdown: 30, scope: "group", minArgs: 1, executionLane: "fast" },
});

const phase4Handlers = {
  tiktok: lazy("../service-debug/api-crawl/tiktok/tiktok-service.js", "handleTikTokCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  spotify: lazy("../service-debug/api-crawl/spotify/spotify-downlink.js", "handleSpotifyCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  youtube: lazy("../service-debug/api-crawl/youtube/youtube-service.js", "handleYoutubeCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  capcut: lazy("../service-debug/api-crawl/capcut/capcut-service.js", "handleCapcutCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  download: lazy("../service-debug/api-crawl/api-hoangdev/aio-downlink.js", "handleDownloadCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  dich: lazy("../service-debug/api-crawl/content/translate.js", "translateCommand", (handler, { api, message }) => handler(api, message)),
  qrbank: lazy("../service-debug/info-service/bank-info.js", "handleBankInfoCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  getlink: lazy("./bot-manager/utilities.js", "handleGetLinkInQuote", (handler, { api, message }) => handler(api, message)),
  getvoice: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleGetVoiceCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
  checkip: lazy("./lenh-debug/check/checkip.js", "handleCheckipCommand", (handler, { api, message }) => handler(api, message)),
  checkdomain: lazy("./lenh-debug/check/checkdomain.js", "handleCheckdomainCommand", (handler, { api, message }) => handler(api, message)),
  cpus: lazy("./lenh-debug/benchmark/index.js", "handleBenchmarkCommand", (handler, { api, message }) => handler(api, message)),
  thoitiet: lazy("../service-debug/api-crawl/content/weather.js", "weatherCommand", (handler, { api, message }) => handler(api, message)),
  prservice: lazy("../service-debug/scheduler/pr-service.js", "handlePRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand)),
};

const phase4Aliases = Object.freeze({
  tiktok: ["tt"],
  youtube: ["yt", "ytb", "dutup"],
  capcut: [],
  download: [],
  dich: [],
  qrbank: ["qrb"],
});

export function createPhase4Registry(overrides = {}) {
  const definitions = PHASE_4_COMMANDS.map((name) => createCommandDefinition({
    name,
    aliases: phase4Aliases[name] ?? [],
    handler: overrides[name] ?? phase4Handlers[name],
    ...phase4Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase4Registry = createPhase4Registry();

export const PHASE_5_COMMANDS = Object.freeze([
  "spamjoin", "ketban", "kb", "soundcloud", "zingmp3",
  "zingchart", "nhaccuatui", "voice", "truyencuoi", "tarrot",
  "poststatus", "createqr", "scanqr", "scanapi", "sendresourcesfile",
  "sendsrc", "sendresourcesvideo", "sendresourcesimage", "sendresourcesaudio",
]);

const phase5Metadata = Object.freeze({
  spamjoin: { aliases: ["poll-service"], permission: "adminLevelHigh", type: 1, countdown: 15, scope: "both", minArgs: 2, risk: "critical", executionLane: "broadcast" },
  ketban: { permission: "adminLevelHigh", type: 3, countdown: 30, scope: "group", risk: "high", executionLane: "fast" },
  kb: { permission: "adminLevelHigh", type: 3, countdown: 30, scope: "group", risk: "high", executionLane: "fast" },
  soundcloud: { aliases: ["scl", "music"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  zingmp3: { aliases: ["zmp3", "ms3", "zing"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  zingchart: { aliases: ["topzingmp3", "zmp3c"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  nhaccuatui: { aliases: ["nct", "ms2"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  voice: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  truyencuoi: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  tarrot: { permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  poststatus: { aliases: ["ps", "status", "stt"], permission: "adminLevelHigh", type: 1, countdown: 15, risk: "high", executionLane: "heavy" },
  createqr: { aliases: ["cqr", "qr", "qrcode"], permission: "all", type: 1, countdown: 30, executionLane: "fast" },
  scanqr: { aliases: ["sqr"], permission: "all", type: 1, countdown: 15, executionLane: "fast" },
  scanapi: { aliases: ["sapi"], permission: "adminLevelHigh", type: 1, countdown: 5, minArgs: 1, risk: "high", executionLane: "fast" },
  sendresourcesfile: { aliases: ["share", "se", "filegame", "box"], permission: "adminLevelHigh", type: 1, countdown: 30, minArgs: 1, risk: "high", executionLane: "broadcast" },
  sendsrc: { aliases: ["shr", "sharesrc"], permission: "adminLevelHigh", type: 1, countdown: 30, minArgs: 1, risk: "high", executionLane: "broadcast" },
  sendresourcesvideo: { aliases: ["srv", "sendvideo"], permission: "adminLevelHigh", type: 1, countdown: 30, minArgs: 1, risk: "high", executionLane: "broadcast" },
  sendresourcesimage: { aliases: ["sendqr", "sendimage", "sendanh"], permission: "adminLevelHigh", type: 1, countdown: 30, minArgs: 1, risk: "high", executionLane: "broadcast" },
  sendresourcesaudio: { aliases: ["sra", "sendvoice", "sendaudio", "sdv"], permission: "adminLevelHigh", type: 1, countdown: 30, minArgs: 1, requiredDependencies: ["ffmpeg"], risk: "high", executionLane: "broadcast" },
});

export function createPhase5Handlers(loadModule = defaultLoader) {
  return {
    spamjoin: lazy("./lenh-debug/spam/remote-join-leave.js", "handleJoinLeaveGroup", (handler, { api, message }) => handler(api, message), loadModule),
    ketban: lazy("../automations/ndq-test.js", "ketbanCommand", (command, { api, message, groupInfo }) => command.execute(api, message, groupInfo), loadModule),
    kb: lazy("../automations/ndq-test.js", "ketbanTagCommand", (command, { api, message, groupInfo }) => command.execute(api, message, groupInfo), loadModule),
    soundcloud: lazy("../service-debug/api-crawl/music/soundcloud.js", "handleMusicCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    zingmp3: lazy("../service-debug/api-crawl/music/zingmp3.js", "handleZingMp3Command", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    zingchart: lazy("../service-debug/api-crawl/music/zingmp3.js", "handleTopChartZingMp3", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    nhaccuatui: lazy("../service-debug/api-crawl/music/nhaccuatui.js", "handleNhacCuaTuiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    voice: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleVoiceCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    truyencuoi: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleStoryCommand", (handler, { api, message }) => handler(api, message), loadModule),
    tarrot: lazy("../service-debug/chat-zalo/chat-special/send-voice/send-voice.js", "handleTarrotCommand", (handler, { api, message }) => handler(api, message), loadModule),
    poststatus: lazy("../utils/canvas/status-post.js", "handleCommandStatusPost", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    createqr: lazy("../service-debug/utilities/qr-creater.js", "handleCreateQRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    scanqr: lazy("../service-debug/utilities/qr-scan.js", "handleScanQRCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    scanapi: lazy("../service-debug/utilities/scan-api.js", "scanApi", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    sendresourcesfile: lazy("./lenh-debug/send-all/send-resources-file.js", "handleSendFile", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    sendsrc: lazy("../service-debug/utilities/share.js", "shareSrc", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    sendresourcesvideo: lazy("./lenh-debug/send-all/send-resources-video.js", "handleSendVideo", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    sendresourcesimage: lazy("./lenh-debug/send-all/send-resources-image.js", "handleSendImage", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    sendresourcesaudio: lazy("./lenh-debug/send-all/send-resources-audio.js", "handleSendAudio", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
  };
}

const phase5Handlers = createPhase5Handlers();

export function createPhase5Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase5Handlers(options.loadModule) : phase5Handlers;
  const definitions = PHASE_5_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase5Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase5Registry = createPhase5Registry();

export const PHASE_6_COMMANDS = Object.freeze([
  "lich", "manager", "listmute", "settinggroup", "changelink",
  "listadmin", "add", "remove", "setcmd", "bot", "autodownload",
  "mute", "unmute", "prefix", "sendtext",
]);

const phase6Metadata = Object.freeze({
  lich: { aliases: ["amlich", "calendar"], permission: "all", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  manager: { permission: "adminBox", type: 3, countdown: 15, scope: "group", executionLane: "fast" },
  listmute: { permission: "adminBox", type: 3, countdown: 10, scope: "group", executionLane: "fast" },
  settinggroup: { aliases: ["stg", "stgr"], permission: "adminBox", type: 3, countdown: 0, scope: "group", executionLane: "control" },
  changelink: { permission: "adminBox", type: 3, countdown: 0, scope: "group", executionLane: "control" },
  listadmin: { permission: "adminBot", type: 1, countdown: 1, scope: "both", executionLane: "control" },
  add: { permission: "adminBot", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  remove: { permission: "adminBot", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  setcmd: { aliases: ["cmdset"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", minArgs: 2, risk: "critical", executionLane: "control" },
  bot: { permission: "adminBox", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  autodownload: { aliases: ["atd"], permission: "adminBox", type: 3, countdown: 3, scope: "group", executionLane: "fast" },
  mute: { aliases: ["cam", "câm"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  unmute: { aliases: ["sua", "sửa", "sủa"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  prefix: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", risk: "high", executionLane: "control" },
  sendtext: { aliases: ["rai", "rải"], permission: "adminBox", type: 3, countdown: 1, scope: "group", active: true, executionLane: "broadcast" },
});

export function createPhase6Handlers(loadModule = defaultLoader) {
  return {
    lich: lazy("./lich-command.js", "handleCalendarCommand", (handler, { api, message, args }) => handler(api, message, args), loadModule),
    manager: lazy("./instructions/help.js", "adminCommand", (handler, { api, message }) => handler(api, message), loadModule),
    listmute: lazy("../service-debug/anti-service/mute-user.js", "handleMuteList", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    settinggroup: lazy("./bot-manager/group-manage.js", "handleSettingGroupCommand", (handler, { api, message, groupInfo, aliasCommand }) => handler(api, message, groupInfo, aliasCommand), loadModule),
    changelink: lazy("./bot-manager/utilities.js", "handleChangeGroupLink", (handler, { api, message }) => handler(api, message), loadModule),
    listadmin: lazy("./bot-manager/admin-manager.js", "executeAdminCommand", (handler, context) => handler(context), loadModule),
    add: lazy("./bot-manager/admin-manager.js", "executeAdminCommand", (handler, context) => handler(context), loadModule),
    remove: lazy("./bot-manager/admin-manager.js", "executeAdminCommand", (handler, context) => handler(context), loadModule),
    setcmd: lazy("./manager-command/set-command.js", "handleSetCommandActive", (handler, { api, message, commandParts }) => handler(api, message, commandParts), loadModule),
    bot: lazy("./bot-manager/active-bot.js", "handleActiveBotUser", (handler, { api, message, groupSettings, authorizationSnapshot, instanceAuthorization, authorization }) => handler(api, message, groupSettings, authorizationSnapshot || instanceAuthorization || authorization || null), loadModule),
    autodownload: lazy("../service-debug/api-crawl/download/auto-download.js", "handleAutoDownloadCommand", (handler, { api, message, aliasCommand, groupSettings }) => handler(api, message, aliasCommand, groupSettings), loadModule),
    mute: lazy("../service-debug/anti-service/mute-user.js", "handleMuteUser", (handler, { api, message, groupSettings, groupAdmins }) => handler(api, message, groupSettings, groupAdmins), loadModule),
    unmute: lazy("../service-debug/anti-service/mute-user.js", "handleUnmuteUser", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    prefix: lazy("./bot-manager/prefix.js", "handlePrefixCommand", (handler, { api, message, isAdminLevelHighest }) => handler(api, message, isAdminLevelHighest), loadModule),
    sendtext: lazy("./lenh-debug/send-all/autosendtext.js", "handleAutoSendTextCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
  };
}

const phase6Handlers = createPhase6Handlers();

export function createPhase6Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase6Handlers(options.loadModule) : phase6Handlers;
  const definitions = PHASE_6_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase6Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase6Registry = createPhase6Registry();

export const PHASE_7_COMMANDS = Object.freeze([
  "sendstk", "sendtask", "welcome", "bye", "updategroup",
  "antibadword", "antisetup", "antibot", "antiblockall", "antisdt",
  "antilink", "autojoin", "antijoin", "antiforward", "antitag",
  "antistickerlag", "antisticker", "antigif", "antispam", "antinude", "antiundo",
]);

const phase7Metadata = Object.freeze({
  sendstk: { aliases: ["sendsticker"], permission: "adminBox", type: 3, countdown: 1, scope: "group", active: true, executionLane: "fast" },
  sendtask: { aliases: ["autosend"], permission: "adminBox", type: 3, countdown: 1, scope: "group", active: true, executionLane: "broadcast" },
  welcome: { aliases: ["wl", "wlc"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  bye: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  updategroup: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antibadword: { aliases: ["atbw", "loctu", "loctukhoa", "loctk", "badword", "bw"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antisetup: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antibot: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antiblockall: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antisdt: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antilink: { aliases: ["xoalink", "loclink"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  autojoin: { aliases: ["auto-join"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antijoin: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antiforward: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antitag: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antistickerlag: { aliases: ["antistklag"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antisticker: { aliases: ["antistk"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antigif: { aliases: ["chonggif"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antispam: { aliases: ["chongspam"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antinude: { aliases: ["chongnude"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "heavy" },
  antiundo: { aliases: ["chongundo"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
});

export function createPhase7Handlers(loadModule = defaultLoader) {
  return {
  sendstk: lazy("./lenh-debug/send-all/sendsticker.js", "handleSendStickerCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    sendtask: lazy("./bot-manager/utilities.js", "handleSendTaskCommand", (handler, { api, message, groupSettings, commandConfig }) => handler(api, message, groupSettings, commandConfig), loadModule),
    welcome: lazy("./bot-manager/welcome-bye.js", "handleWelcomeBye", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings, "welcome"), loadModule),
    bye: lazy("./bot-manager/welcome-bye.js", "handleWelcomeBye", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings, "bye"), loadModule),
    updategroup: lazy("./bot-manager/welcome-bye.js", "handleWelcomeBye", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings, "updategroup"), loadModule),
    antibadword: lazy("../service-debug/anti-service/anti-badword.js", "handleAntiBadWordCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antisetup: lazy("../service-debug/anti-service/setup-anti.js", "handleSetupAntiCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antibot: lazy("../service-debug/anti-service/anti-bot.js", "handleAntiBotCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antiblockall: lazy("../service-debug/anti-service/anti-kick-all.js", "handleAntiKickBlockCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antisdt: lazy("../service-debug/anti-service/anti-phone-number.js", "handleAntiPhoneNumberCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antilink: lazy("../service-debug/anti-service/anti-link.js", "handleAntiLinkCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    autojoin: lazy("../service-debug/anti-service/auto-join.js", "handleAutoJoinCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antijoin: lazy("../service-debug/anti-service/anti-join-leave.js", "handleAntiJoinLeaveCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antiforward: lazy("../service-debug/anti-service/anti-forward.js", "handleAntiForwardCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antitag: lazy("../service-debug/anti-service/anti-tag.js", "handleAntiTagCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antistickerlag: lazy("../service-debug/anti-service/anti-stickerlag.js", "handleAntiEffectStickerCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antisticker: lazy("../service-debug/anti-service/anti-sticker.js", "handleAntiAllEffectStickerCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antigif: lazy("../service-debug/anti-service/anti-gif.js", "handleAntiGif", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antispam: lazy("../service-debug/anti-service/anti-spam.js", "handleAntiSpamCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antinude: lazy("../service-debug/anti-service/anti-nude/anti-nude.js", "handleAntiNudeCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antiundo: lazy("../service-debug/anti-service/anti-undo.js", "handleAntiUndoCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
  };
}

const phase7Handlers = createPhase7Handlers();

export function createPhase7Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase7Handlers(options.loadModule) : phase7Handlers;
  const definitions = PHASE_7_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase7Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase7Registry = createPhase7Registry();

export const PHASE_8_COMMANDS = Object.freeze([
  "antiall", "antitext", "antifile", "antiphoto", "antivoice",
  "onlytext", "ban", "unban", "tagall", "spamgroup", "scold",
  "approve", "learn", "learnnow", "unlearn", "reply", "autoreply",
  "undo", "todo", "sendp",
]);

const phase8Metadata = Object.freeze({
  antiall: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antitext: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antifile: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antiphoto: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antivoice: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  onlytext: { aliases: ["vanban"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  ban: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", risk: "high", executionLane: "control" },
  unban: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", risk: "high", executionLane: "control" },
  tagall: { aliases: ["all", "tag-reaction"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "broadcast" },
  spamgroup: { aliases: ["spamgr"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", minArgs: 1, risk: "critical", executionLane: "broadcast" },
  scold: { aliases: ["reo", "var", "chui", "sold"], permission: "adminBox", type: 3, countdown: 1, scope: "group", minArgs: 1, executionLane: "fast" },
  approve: { aliases: ["duyetmem"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  learn: { permission: "adminBox", type: 2, countdown: 1, scope: "group", executionLane: "fast" },
  learnnow: { permission: "adminBox", type: 2, countdown: 1, scope: "group", minArgs: 2, executionLane: "fast" },
  unlearn: { permission: "adminBox", type: 2, countdown: 1, scope: "group", minArgs: 1, executionLane: "fast" },
  reply: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  autoreply: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  undo: { aliases: ["un"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  todo: { permission: "adminBot", type: 3, countdown: 1, scope: "both", minArgs: 1, executionLane: "fast" },
  sendp: { aliases: ["sendprivate"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", minArgs: 1, risk: "high", executionLane: "fast" },
});

export function createPhase8Handlers(loadModule = defaultLoader) {
  return {
    antiall: lazy("../service-debug/anti-service/anti-all.js", "handleAntiAll", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antitext: lazy("../service-debug/anti-service/anti-text.js", "handleAntiText", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antifile: lazy("../service-debug/anti-service/anti-file.js", "handleAntiFile", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antiphoto: lazy("../service-debug/anti-service/anti-photo.js", "handleAntiPhotoVideo", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antivoice: lazy("../service-debug/anti-service/anti-voice.js", "handleAntiVoice", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    onlytext: lazy("../service-debug/anti-service/anti-not-text.js", "handleOnlyText", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    ban: lazy("./bot-manager/group-manage.js", "handleBlockBot", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    unban: lazy("./bot-manager/group-manage.js", "handleUnblockBot", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    tagall: lazy("../service-debug/chat-zalo/chat-general/chat-all.js", "chatAll", (handler, { api, message, groupInfo, aliasCommand }) => handler(api, message, groupInfo, aliasCommand), loadModule),
    spamgroup: lazy("./bot-manager/spamgroup.js", "spamgroup", (handler, { api, message }) => handler(api, message), loadModule),
    scold: lazy("../service-debug/chat-bot/scold-user/scold-user.js", "scoldUser", (handler, { api, message }) => handler(api, message), loadModule),
    approve: lazy("./bot-manager/welcome-bye.js", "handleApprove", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    learn: lazy("../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleLearnCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    learnnow: lazy("../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleLearnCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    unlearn: lazy("../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleLearnCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    reply: lazy("../service-debug/chat-bot/bot-learning/dqt-bot.js", "handleReplyCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    autoreply: lazy("../service-debug/api-crawl/assistant-ai/auto-reply.js", "handleAutoReplyCommand", (handler, { api, message, aliasCommand, groupSettings }) => handler(api, message, aliasCommand, groupSettings), loadModule),
    undo: lazy("./bot-manager/utilities.js", "handleUndoMessage", (handler, { api, message }) => handler(api, message), loadModule),
    todo: lazy("./bot-manager/utilities.js", "handleSendToDo", (handler, { api, message }) => handler(api, message), loadModule),
    sendp: lazy("./bot-manager/utilities.js", "handleSendMessagePrivate", (handler, { api, message }) => handler(api, message), loadModule),
  };
}

const phase8Handlers = createPhase8Handlers();

export function createPhase8Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase8Handlers(options.loadModule) : phase8Handlers;
  const definitions = PHASE_8_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase8Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase8Registry = createPhase8Registry();

export const PHASE_9_COMMANDS = Object.freeze([
  "kick", "block", "taget", "kickall", "blockall",
  "keygold", "keysilver", "unkey", "join", "leave", "listgroups",
  "scangroups", "deletemessage", "restart", "listblockbot", "blockbot",
  "unblockbot", "whitelist", "alias", "downloadresource", "deleteresource",
  "keylist",
]);

const phase9Metadata = Object.freeze({
  kick: { aliases: ["sut", "cút"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  block: { aliases: ["chan", "block-user", "blockmessage"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  taget: { aliases: ["target-manage"], permission: "adminBox", type: 1, countdown: 1, scope: "group", executionLane: "fast" },
  kickall: { aliases: ["cútall"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", risk: "critical", executionLane: "control" },
  blockall: { aliases: ["biếnall"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", risk: "critical", executionLane: "control" },
  keygold: { aliases: ["keyvang"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", risk: "critical", executionLane: "control" },
  keysilver: { aliases: ["keybac"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", risk: "critical", executionLane: "control" },
  unkey: { aliases: ["xoakey"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", risk: "critical", executionLane: "control" },
  join: { aliases: ["thamgianhom"], permission: "adminBot", type: 3, countdown: 1, scope: "both", minArgs: 1, executionLane: "control" },
  leave: { aliases: ["out"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", risk: "critical", executionLane: "control" },
  listgroups: { aliases: ["lgr"], permission: "adminBot", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  scangroups: { aliases: ["scgr"], permission: "adminBot", type: 3, countdown: 1, scope: "group", minArgs: 1, executionLane: "control" },
  deletemessage: { aliases: ["delmsg", "del"], permission: "adminBox", type: 3, countdown: 1, scope: "group", minArgs: 1, executionLane: "control" },
  restart: { aliases: ["rs"], permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", risk: "critical", executionLane: "control" },
  listblockbot: { aliases: ["lsbot", "list-block-group"], permission: "adminBot", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  blockbot: { aliases: ["blbot"], permission: "adminBot", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  unblockbot: { aliases: ["unblbot", "unblockmessage"], permission: "adminBot", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  whitelist: { aliases: ["wls", "setmute"], permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  alias: { aliases: ["acp", "addcmd", "cmdfind", "fixcmd", "removecmd"], permission: "adminLevelHigh", type: 1, countdown: 5, scope: "both", minArgs: 1, risk: "high", executionLane: "control" },
  downloadresource: { aliases: ["dlrsrc"], permission: "adminLevelHigh", type: 3, countdown: 5, scope: "both", minArgs: 1, risk: "high", executionLane: "heavy" },
  deleteresource: { aliases: ["delrsrc"], permission: "adminLevelHigh", type: 3, countdown: 5, scope: "both", minArgs: 1, risk: "high", executionLane: "heavy" },
  keylist: { aliases: ["listkey"], permission: "adminBox", type: 1, countdown: 1, scope: "group", executionLane: "fast" },
});

export function createPhase9Handlers(loadModule = defaultLoader) {
  return {
    kick: lazy("./bot-manager/group-manage.js", "handleKick", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    block: lazy("./bot-manager/group-manage.js", "handleBlock", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    taget: lazy("./bot-manager/group-manage.js", "handleTaget", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    kickall: lazy("./bot-manager/group-manage.js", "handleKickAll", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    blockall: lazy("./bot-manager/group-manage.js", "handleBlockAll", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    keygold: lazy("./bot-manager/group-manage.js", "handleKeyCommands", (handler, { api, message, groupSettings, isAdminLevelHighest }) => handler(api, message, groupSettings, isAdminLevelHighest), loadModule),
    keysilver: lazy("./bot-manager/group-manage.js", "handleKeyCommands", (handler, { api, message, groupSettings, isAdminLevelHighest }) => handler(api, message, groupSettings, isAdminLevelHighest), loadModule),
    unkey: lazy("./bot-manager/group-manage.js", "handleKeyCommands", (handler, { api, message, groupSettings, isAdminLevelHighest }) => handler(api, message, groupSettings, isAdminLevelHighest), loadModule),
    join: lazy("./bot-manager/remote-action-group.js", "handleJoinGroup", (handler, { api, message }) => handler(api, message), loadModule),
    leave: lazy("./bot-manager/remote-action-group.js", "handleLeaveGroup", (handler, { api, message }) => handler(api, message), loadModule),
    listgroups: lazy("./bot-manager/remote-action-group.js", "handleShowGroupsList", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    scangroups: lazy("./bot-manager/scan-group.js", "scanGroupsWithAction", (handler, { api, message, groupInfo, aliasCommand }) => handler(api, message, groupInfo, aliasCommand), loadModule),
    deletemessage: lazy("./bot-manager/recent-message.js", "handleDeleteMessage", (handler, { api, message, groupAdmins, aliasCommand }) => handler(api, message, groupAdmins, aliasCommand), loadModule),
    restart: lazy("../utils/util.js", "restartSelf", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    listblockbot: lazy("./bot-manager/group-manage.js", "handleListBlockBot", (handler, { api, message }) => handler(api, message), loadModule),
    blockbot: lazy("./bot-manager/group-manage.js", "handleBlockBot", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    unblockbot: lazy("./bot-manager/group-manage.js", "handleUnblockBot", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    whitelist: lazy("../service-debug/anti-service/white-list.js", "handleWhiteList", (handler, { api, message, groupSettings, groupAdmins }) => handler(api, message, groupSettings, groupAdmins), loadModule),
    alias: lazy("./bot-manager/utilities.js", "handleAliasCommand", (handler, { api, message, commandParts }) => handler(api, message, commandParts), loadModule),
    downloadresource: lazy("../service-debug/utilities/download-resource.js", "handleDownloadResource", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    deleteresource: lazy("../service-debug/utilities/download-resource.js", "handleDeleteResource", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    keylist: lazy("./bot-manager/key-list.js", "handleListKeyCommand", (handler, { api, message }) => handler(api, message), loadModule),
  };
}

const phase9Handlers = createPhase9Handlers();

export function createPhase9Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase9Handlers(options.loadModule) : phase9Handlers;
  const definitions = PHASE_9_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase9Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase9Registry = createPhase9Registry();

export const PHASE_10_COMMANDS = Object.freeze([
  "kickimg", "blockimg", "kickallmember", "blockallmember", "leaveallbox",
  "leavelock", "dispersegroup", "target", "key",
]);

const phase10Metadata = Object.freeze({
  kickimg: { permission: "adminLevelHigh", type: 1, countdown: 60, scope: "group", executionLane: "control" },
  blockimg: { permission: "adminLevelHigh", type: 1, countdown: 60, scope: "group", executionLane: "control" },
  kickallmember: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  blockallmember: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  leaveallbox: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  leavelock: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  dispersegroup: { permission: "adminLevelHigh", type: 1, countdown: 1, scope: "group", executionLane: "control" },
  target: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", executionLane: "control" },
  key: { permission: "adminLevelHigh", type: 3, countdown: 1, scope: "group", executionLane: "control" },
});

export function createPhase10Handlers(loadModule = defaultLoader) {
  return {
    kickimg: lazy("./bot-manager/nqduan-bridge.js", "handleKickImageCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    blockimg: lazy("./bot-manager/nqduan-bridge.js", "handleBlockImageCommand", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    kickallmember: lazy("./bot-manager/group-manage.js", "handleKickAll", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    blockallmember: lazy("./bot-manager/group-manage.js", "handleBlockAll", (handler, { api, message, groupInfo }) => handler(api, message, groupInfo), loadModule),
    leaveallbox: lazy("./bot-manager/nqduan-bridge.js", "handleLeaveAllBoxCommand", (handler, { api, message }) => handler(api, message), loadModule),
    leavelock: lazy("./bot-manager/nqduan-bridge.js", "handleLeaveLockedGroups", (handler, { api, message }) => handler(api, message), loadModule),
    dispersegroup: lazy("./bot-manager/nqduan-bridge.js", "handleDisperseGroupCommand", (handler, { api, message }) => handler(api, message), loadModule),
    target: lazy("./bot-manager/nqduan-bridge.js", "handleTargetCommand", (handler, { api, message }) => handler(api, message), loadModule),
    key: lazy("./bot-manager/nqduan-bridge.js", "handleKeyCommand", (handler, { api, message, groupSettings, isAdminLevelHighest }) => handler(api, message, groupSettings, isAdminLevelHighest), loadModule),
  };
}

const phase10Handlers = createPhase10Handlers();

export function createPhase10Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase10Handlers(options.loadModule) : phase10Handlers;
  const definitions = PHASE_10_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase10Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase10Registry = createPhase10Registry();

export const PHASE_11_COMMANDS = Object.freeze([
  "fb", "createimageai", "genminiv1", "addfriend", "addfriendall", "undofriend",
  "rejectfriend", "listfriend", "waitinglist", "vdvuto", "vdchill", "vdsad",
  "vdtet", "stickerzalo", "dinhgiasim", "benchmark", "acclq",
  "replytag", "reverse", "checkgiavang", "emote",
  "checkorder", "showcode", "4k", "cardqr", "call", "lovelink",
  "myheart", "checklq", "datavideo", "googlesearchai", "qrheart",
  "nhacnho", "fakecccd", "check", "admin", "mybank", "removefriend",
  "senduser", "prwelcome", "antivideo", "antistickereffect",
  "rutgonlink", "testflight", "cmdadd", "sticker ai", "locmem",
]);

const phase11Metadata = Object.freeze({
  fb: { permission: "all", type: 1, countdown: 5, scope: "both", executionLane: "fast" },
  createimageai: { aliases: ["gemv2"], permission: "adminLevelHigh", type: 1, countdown: 60, scope: "both", executionLane: "heavy" },
  genminiv1: { aliases: ["gemv1"], permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "heavy" },
  addfriend: { permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  addfriendall: { aliases: ["addfriend-all"], permission: "adminLevelHigh", type: 3, countdown: 30, scope: "group", risk: "high", executionLane: "broadcast" },
  undofriend: { aliases: ["undo-friend"], permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  rejectfriend: { aliases: ["reject-friend"], permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  listfriend: { aliases: ["list-friends"], permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  waitinglist: { aliases: ["friend-waiting-list"], permission: "adminLevelHigh", type: 1, countdown: 15, scope: "both", executionLane: "fast" },
  vdvuto: { permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "heavy" },
  vdchill: { permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "heavy" },
  vdsad: { permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "heavy" },
  vdtet: { permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "heavy" },
  stickerzalo: { aliases: ["stkzl"], permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "fast" },
  dinhgiasim: { permission: "adminLevelHigh", type: 1, countdown: 100, scope: "both", executionLane: "fast" },
  benchmark: { permission: "adminLevelHigh", type: 1, countdown: 100, scope: "both", executionLane: "fast" },
  acclq: { permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  replytag: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  reverse: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  checkgiavang: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  emote: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  checkorder: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  showcode: { permission: "adminLevelHigh", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  "4k": { aliases: ["hd"], permission: "all", type: 1, countdown: 30, scope: "both", executionLane: "heavy" },
  cardqr: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  call: { permission: "adminLevelHigh", type: 1, countdown: 1, scope: "both", risk: "critical", executionLane: "heavy" },
  lovelink: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  myheart: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  checklq: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  datavideo: { aliases: ["dtvd"], permission: "adminLevelHigh", type: 1, countdown: 3, scope: "both", risk: "high", executionLane: "heavy" },
  googlesearchai: { aliases: ["ggsai"], permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  qrheart: { permission: "all", type: 1, countdown: 5, scope: "both", executionLane: "fast" },
  nhacnho: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  fakecccd: { permission: "adminLevelHigh", type: 1, countdown: 1, scope: "both", risk: "high", executionLane: "fast" },
  check: { permission: "all", type: 1, countdown: 5, scope: "both", executionLane: "fast" },
  admin: { permission: "adminBot", type: 3, countdown: 1, scope: "both", executionLane: "control" },
  mybank: { permission: "adminLevelHigh", type: 1, countdown: 300, scope: "both", executionLane: "fast" },
  removefriend: { permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", executionLane: "fast" },
  senduser: { permission: "adminLevelHigh", type: 1, countdown: 120, scope: "both", executionLane: "fast" },
  prwelcome: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antivideo: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  antistickereffect: { permission: "adminBox", type: 3, countdown: 1, scope: "group", executionLane: "fast" },
  rutgonlink: { permission: "all", type: 1, countdown: 1, scope: "both", executionLane: "fast" },
  testflight: { permission: "all", type: 1, countdown: 10, scope: "both", executionLane: "fast" },
  cmdadd: { permission: "adminLevelHigh", type: 1, countdown: 30, scope: "both", instanceScope: "main", executionLane: "control" },
  "sticker ai": { aliases: ["stk ai"], permission: "adminLevelHigh", type: 1, countdown: 60, scope: "both", executionLane: "heavy" },
  locmem: { permission: "adminLevelHigh", type: 1, countdown: 30, scope: "group", risk: "critical", executionLane: "control" },
});

export function createPhase11Handlers(loadModule = defaultLoader) {
  return {
    fb: lazy("../service-debug/fb/fb.js", "handleFbCommand", (handler, { api, message }) => handler(api, message), loadModule),
    createimageai: lazy("../service-debug/api-crawl/assistant-ai/create-image.js", "handleImageGeneration", (handler, { api, message, aliasCommand, isAdminLevelHighest }) => handler(api, message, aliasCommand, { isAdminLevelHighest }), loadModule),
    genminiv1: lazy("../service-debug/api-crawl/assistant-ai/Analysis-Image.js", "handleImageAnalysis", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    addfriend: lazy("./bot-manager/nqduan-phase5.js", "handleSendFriendRequest", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    addfriendall: lazy("./bot-manager/nqduan-phase5.js", "handleAddFriendAll", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    undofriend: lazy("./bot-manager/nqduan-phase5.js", "handleUndoFriendRequest", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    rejectfriend: lazy("./bot-manager/nqduan-phase5.js", "handleRejectFriendRequest", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    listfriend: lazy("./bot-manager/nqduan-phase5.js", "handleDsBanBe", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    waitinglist: lazy("./bot-manager/nqduan-phase5.js", "handleFriendWaitingList", (handler, { api, message }) => handler(api, message), loadModule),
    vdvuto: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "vuto"), loadModule),
    vdchill: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "chill"), loadModule),
    vdsad: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "sad"), loadModule),
    vdtet: lazy("../service-debug/chat-zalo/chat-special/send-video/send-video.js", "handleVideoCommand", (handler, { api, message }) => handler(api, message, "tet"), loadModule),
    stickerzalo: lazy("../service-debug/tien-ich/stickerlocal.js", "handleStickerLocalCommand", (handler, { api, message }) => handler(api, message), loadModule),
    dinhgiasim: lazy("../service-debug/spamsms/dinhgiasim.js", "handledinhgiasimCommand", (handler, { api, message }) => handler(api, message), loadModule),
    benchmark: lazy("./lenh-debug/benchmark/index.js", "handleBenchmarkCommand", (handler, { api, message }) => handler(api, message), loadModule),
    acclq: lazy("../service-debug/lienquanmobile/acclq.js", "handleAcclqCommand", (handler, { api, message }) => handler(api, message), loadModule),
    replytag: lazy("./bot-check/replytag.js", "handleAutoReplyMentionsMessageCommand", (handler, { api, message, aliasCommand, groupSettings }) => handler(api, message, aliasCommand, groupSettings), loadModule),
    reverse: lazy("../service-debug/tien-ich/reverse.js", "handleReverseCommand", (handler, { api, message }) => handler(api, message), loadModule),
    checkgiavang: lazy("../service-debug/tien-ich/check-gia-vang.js", "handleCheckGiaVangCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    emote: lazy("../service-debug/tien-ich/emote.js", "handleEmoteCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    checkorder: lazy("../service-debug/tien-ich/checkorder.js", "handlecheckoderCommand", (handler, { api, message }) => handler(api, message), loadModule),
    showcode: lazy("../service-debug/tien-ich/showcode.js", "handleshowcodeCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    "4k": lazy("./bot-manager/nqduan-phase5.js", "handle4KImage", (handler, { api, message }) => handler(api, message), loadModule),
    cardqr: lazy("../service-debug/info-service/business-card-qr.js", "userBussinessCardQrCommand", (handler, { api, message }) => handler(api, message), loadModule),
    call: lazy("./bot-manager/nqduan-phase5.js", "spamCallInGroup", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    lovelink: lazy("../service-debug/lovelink/lovelink.js", "handlelovelinkCommand", (handler, { api, message }) => handler(api, message), loadModule),
    myheart: lazy("../service-debug/lovelink/myheart.js", "handleMyHeartCommand", (handler, { api, message }) => handler(api, message), loadModule),
    checklq: lazy("../service-debug/lienquanmobile/checklq.js", "handlechecklqCommand", (handler, { api, message }) => handler(api, message), loadModule),
    datavideo: lazy("./bot-manager/nqduan-phase5.js", "handleDownloadData", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    googlesearchai: lazy("../service-debug/api-crawl/google/google-search-ai.js", "handleGooglesearchaiCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    qrheart: lazy("../service-debug/utilities/qr-heart.js", "handleCreateQRHeartCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    nhacnho: lazy("../service-debug/tien-ich/nhacnho.js", "handleNhacNhoCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    fakecccd: lazy("../service-debug/tien-ich/cccd.js", "handleCccdCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    check: lazy("../service-debug/info-service/check-user.js", "handleCheckCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    admin: lazy("./bot-manager/admin-manager.js", "executeAdminCommand", (handler, context) => handler(context), loadModule),
    mybank: lazy("../service-debug/info-service/mybank-business.js", "myBankBusinessCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    removefriend: lazy("./bot-manager/nqduan-phase5.js", "handleRemoveFriend", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    senduser: lazy("./bot-manager/nqduan-phase5.js", "handleSendMessageToMentioned", (handler, { api, message }) => handler(api, message), loadModule),
    prwelcome: lazy("./bot-manager/welcome-bye.js", "handlePrWelcome", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antivideo: lazy("../service-debug/anti-service/anti-video.js", "handleAntiVideo", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    antistickereffect: lazy("../service-debug/anti-service/anti-stickereffect.js", "handleAntiStickerEffect", (handler, { api, message, groupSettings }) => handler(api, message, groupSettings), loadModule),
    rutgonlink: lazy("../service-debug/lovelink/rutgonlink.js", "handleRutgonlinkCommand", (handler, { api, message }) => handler(api, message), loadModule),
    testflight: lazy("../service-debug/testflight/testflight.js", "handleTestflightCommand", (handler, { api, message, aliasCommand }) => handler(api, message, aliasCommand), loadModule),
    cmdadd: lazy("./custom-commands/cmdadd-command.js", "handleCmdaddCommand", (handler, { api, message, commandParts, root }) => handler(api, message, commandParts, { root }), loadModule),
    "sticker ai": lazy("./sticker-ai-command.js", "handleStickerAiCommand", (handler, context) => handler(context), loadModule),
    locmem: lazy("../service-debug/locmem/index.js", "handleLocmemCommand", (handler, context) => handler(context.api, context.message, context), loadModule),
  };
}

const phase11Handlers = createPhase11Handlers();

export function createPhase11Registry(overrides = {}, options = {}) {
  const handlers = options.loadModule ? createPhase11Handlers(options.loadModule) : phase11Handlers;
  const definitions = PHASE_11_COMMANDS.map((name) => createCommandDefinition({
    name,
    handler: overrides[name] ?? handlers[name],
    ...phase11Metadata[name],
  }));
  return createCommandRegistry(definitions);
}

export const phase11Registry = createPhase11Registry();

export function createCommandRegistryForPhases(overrides = {}) {
  return createCommandRegistry([
    ...createPhase1Registry(overrides).definitions,
    ...createPhase2Registry(overrides).definitions,
    ...createPhase3Registry(overrides).definitions,
    ...createPhase4Registry(overrides).definitions,
    ...createPhase5Registry(overrides).definitions,
    ...createPhase6Registry(overrides).definitions,
    ...createPhase7Registry(overrides).definitions,
    ...createPhase8Registry(overrides).definitions,
    ...createPhase9Registry(overrides).definitions,
    ...createPhase10Registry(overrides).definitions,
    ...createPhase11Registry(overrides).definitions,
  ]);
}

export const commandRegistry = createCommandRegistryForPhases();
