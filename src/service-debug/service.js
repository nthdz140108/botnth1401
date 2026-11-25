import { readCommandConfig } from "../utils/io-json.js";
import { initRankSystem } from "./info-service/rank-chat.js";
import { initializeScheduler } from "./scheduler/scheduler.js";
import { startMuteCheck } from "./anti-service/mute-user.js";
import { startBadWordViolationCheck } from "./anti-service/anti-badword.js";
import { startNudeViolationCheck } from "./anti-service/anti-nude/anti-nude.js";
import { initPRService } from "./scheduler/pr-zalo.js";
import { handleActionGroupReply } from "../commands/bot-manager/remote-action-group.js";
import { handleDownloadReply } from "./api-crawl/api-hoangdev/aio-downlink.js";
import { checkReplySelectionsMapData } from "./api-crawl/index.js";
import { notifyResetGroup } from "../commands/bot-manager/active-bot.js";
import { handleScanGroupsReply } from "../commands/bot-manager/scan-group.js";
import { startAntiConfigCheck } from "./anti-service/index.js";
import { initializeCacheService } from "../utils/link-platform-cache.js";
import { checkRestartFile } from "../utils/util.js";
import { initCheckCommand, startPeriodicCheckTime } from "../commands/mybot/Check-time/start-period.js";
import { initAdminHandle } from "../commands/bot-manager/init-admin.js";
import { startReminderService } from "./tien-ich/nhacnho.js";
import { restoreAutoSticker } from "../commands/lenh-debug/send-all/sendsticker.js";
import { buildSendtaskSchedulesFromStudio } from "../commands/studio/runtime-apply.js";
import { getBotName, getProjectRoot } from "../utils/env.js";

let _musicReply = null;
let _zingMp3Reply = null;
let _ytReply = null;
let _tiktokReply = null;
let _nctReply = null;
let _capcutReply = null;

async function getMusicReply() {
  if (!_musicReply) {
    const mod = await import("./api-crawl/music/soundcloud.js");
    _musicReply = mod.handleMusicReply;
  }
  return _musicReply;
}

async function getZingMp3Reply() {
  if (!_zingMp3Reply) {
    const mod = await import("./api-crawl/music/zingmp3.js");
    _zingMp3Reply = mod.handleZingMp3Reply;
  }
  return _zingMp3Reply;
}

async function getYoutubeReply() {
  if (!_ytReply) {
    const mod = await import("./api-crawl/youtube/youtube-service.js");
    _ytReply = mod.handleYoutubeReply;
  }
  return _ytReply;
}

async function getTikTokReply() {
  if (!_tiktokReply) {
    const mod = await import("./api-crawl/tiktok/tiktok-service.js");
    _tiktokReply = mod.handleTikTokReply;
  }
  return _tiktokReply;
}

async function getNhacCuaTuiReply() {
  if (!_nctReply) {
    const mod = await import("./api-crawl/music/nhaccuatui.js");
    _nctReply = mod.handleNhacCuaTuiReply;
  }
  return _nctReply;
}

async function getCapcutReply() {
  if (!_capcutReply) {
    const mod = await import("./api-crawl/capcut/capcut-service.js");
    _capcutReply = mod.handleCapcutReply;
  }
  return _capcutReply;
}

var globalPrefix = "!";

export function getGlobalPrefix() {
  return globalPrefix;
}

export function setGlobalPrefix(newPrefix) {
  globalPrefix = newPrefix;
}

function loadPersistedSendtaskSchedulerOptions() {
  try {
    const studio = buildSendtaskSchedulesFromStudio({
      root: getProjectRoot(),
      botId: getBotName() || "admin",
    });
    return {
      schedules: studio.schedulerEnabled ? studio.schedules : [],
      retry: studio.retry,
    };
  } catch {
    return {};
  }
}

export async function initService(api) {
  const commandConfig = readCommandConfig();
  globalPrefix = commandConfig.prefix || "!";
  const schedulerOptions = loadPersistedSendtaskSchedulerOptions();

  const tasks = [
    checkRestartFile(api),
    initializeCacheService(),
    startPeriodicCheckTime(api),
    initCheckCommand(api),
    initAdminHandle(api),
    initializeScheduler(api, schedulerOptions),
    initPRService(api),
    startAntiConfigCheck(),
    startMuteCheck(api),
    startBadWordViolationCheck(),
    startNudeViolationCheck(),
    initRankSystem(),
    notifyResetGroup(api),
    startReminderService(api),
    Promise.resolve().then(() => restoreAutoSticker(api)),
  ];

  await Promise.all(tasks);
}

export async function rebindServiceApi(api) {
  const schedulerOptions = loadPersistedSendtaskSchedulerOptions();
  await Promise.all([
    startPeriodicCheckTime(api),
    initializeScheduler(api, schedulerOptions),
    initPRService(api),
    startMuteCheck(api),
    startReminderService(api),
    Promise.resolve().then(() => restoreAutoSticker(api)),
  ]);
}

export async function handleOnChatUser() {
  return false;
}

export async function handleOnReplyFromUser(
  api,
  message,
  groupInfo,
  groupAdmins,
  groupSettings,
  isAdminLevelHighest,
  callerIsBotAdmin,
  callerIsAdminBox,
  handleChat
) {
  if (await checkReplySelectionsMapData(api, message)) return true;
  if (await handleScanGroupsReply(api, message)) return true;
  const musicHandler = await getMusicReply();
  if (await musicHandler(api, message)) return true;
  const zingHandler = await getZingMp3Reply();
  if (await zingHandler(api, message)) return true;
  const ytHandler = await getYoutubeReply();
  if (await ytHandler(api, message)) return true;
  const ttHandler = await getTikTokReply();
  if (await ttHandler(api, message)) return true;
  const nctHandler = await getNhacCuaTuiReply();
  if (await nctHandler(api, message)) return true;
  if (await handleDownloadReply(api, message)) return true;
  const capcutHandler = await getCapcutReply();
  if (await capcutHandler(api, message)) return true;
  if (
    await handleActionGroupReply(
      api,
      message,
      groupInfo,
      groupAdmins,
      groupSettings,
      isAdminLevelHighest,
      callerIsBotAdmin,
      callerIsAdminBox,
      handleChat
    )
  )
    return true;
  return false;
}
