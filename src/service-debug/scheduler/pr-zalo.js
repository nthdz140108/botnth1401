import path from "path";
import fs from "fs";
import schedule from "node-schedule";
import chalk from "chalk";
import { getActiveRuntimeContext, readWebConfig, writeWebConfig } from "../../utils/io-json.js";
import { normalizePrObjects, normalizeWebPrConfig } from "./pr-config.js";
import { getDataAllGroup } from "../info-service/group-info.js";
import { MessageType } from "../../api-zalo/models/Message.js";
import { checkUrlStatus } from "../../utils/util.js";
import { getBotId } from "../../utils/env.js";

const LEGACY_RESOURCE_BASE_PATH = path.join(process.cwd(), "assets", "web-config");
const LEGACY_IMAGE_PR_PATH = path.join(LEGACY_RESOURCE_BASE_PATH, "image-pr");
const LEGACY_VIDEO_PR_PATH = path.join(LEGACY_RESOURCE_BASE_PATH, "video-pr");
const CAPTION_CARD = "Danh Thiếp Liên Hệ";

const sentPRs = new Map();
const activePrJobsByBot = new Map();
const runningPrLocksByBot = new Set();

export function getInstancePrPaths() {
  try {
    const ctx = getActiveRuntimeContext();
    const baseDir = ctx?.webConfigPath
      ? path.dirname(ctx.webConfigPath)
      : ctx?.dataDir
        ? path.join(ctx.dataDir, "web-config")
        : LEGACY_RESOURCE_BASE_PATH;
    return {
      baseDir,
      imagePrDir: path.join(baseDir, "image-pr"),
      videoPrDir: path.join(baseDir, "video-pr"),
      legacyImagePrDir: LEGACY_IMAGE_PR_PATH,
      legacyVideoPrDir: LEGACY_VIDEO_PR_PATH,
    };
  } catch {
    return {
      baseDir: LEGACY_RESOURCE_BASE_PATH,
      imagePrDir: LEGACY_IMAGE_PR_PATH,
      videoPrDir: LEGACY_VIDEO_PR_PATH,
      legacyImagePrDir: LEGACY_IMAGE_PR_PATH,
      legacyVideoPrDir: LEGACY_VIDEO_PR_PATH,
    };
  }
}

export function resolveSafePrAttachmentPath(dirPath, rawFileName) {
  const raw = String(rawFileName ?? "").trim();
  if (!raw || raw.includes("..") || raw.includes("/") || raw.includes("\\") || raw.includes("\0")) {
    return null;
  }
  const safeName = path.basename(raw);
  if (!safeName || safeName === "." || safeName === "..") {
    return null;
  }
  const resolvedDir = path.resolve(dirPath);
  const fullPath = path.resolve(resolvedDir, safeName);
  if (!fullPath.startsWith(resolvedDir + path.sep)) {
    return null;
  }
  return fullPath;
}

function resolveExistingPrMediaFile(primaryDir, legacyDir, fileName) {
  const primaryCandidate = resolveSafePrAttachmentPath(primaryDir, fileName);
  if (primaryCandidate && fs.existsSync(primaryCandidate)) {
    return primaryCandidate;
  }
  if (legacyDir && path.resolve(legacyDir) !== path.resolve(primaryDir)) {
    const legacyCandidate = resolveSafePrAttachmentPath(legacyDir, fileName);
    if (legacyCandidate && fs.existsSync(legacyCandidate)) {
      return legacyCandidate;
    }
  }
  return null;
}

function getVietnamHourMinute(nowMs = Date.now()) {
  const vn = new Date(nowMs + 7 * 3600_000);
  const hh = String(vn.getUTCHours()).padStart(2, "0");
  const mm = String(vn.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function parsePeriodicTime(periodicTime) {
  const match = String(periodicTime || "").match(/^(\d+)(s|min|h|d|m|y)$/);
  if (!match) return 0;
  const value = Number.parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1000;
    case "min":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    case "m":
      return value * 30 * 24 * 60 * 60 * 1000;
    case "y":
      return value * 365 * 24 * 60 * 60 * 1000;
    default:
      return 0;
  }
}

async function checkAndFixAttachments(api, prObject, idZaloGroup, threadType = MessageType.GroupMessage) {
  const { hinhAnh = [], video = [], link = {} } = prObject;
  const { imagePrDir, videoPrDir, legacyImagePrDir, legacyVideoPrDir } = getInstancePrPaths();
  const updatedLinks = { ...link };

  for (const fileName in updatedLinks) {
    if (!hinhAnh.includes(fileName) && !video.includes(fileName)) {
      delete updatedLinks[fileName];
    }
  }

  for (const imageName of hinhAnh) {
    const imagePath = resolveExistingPrMediaFile(imagePrDir, legacyImagePrDir, imageName);
    if (!imagePath) continue;

    let imageUrl = updatedLinks[imageName];
    if (imageUrl) {
      const ok = await checkUrlStatus(imageUrl);
      if (!ok) imageUrl = null;
    }
    if (!imageUrl) {
      try {
        const uploadResult = await api.uploadAttachment([imagePath], idZaloGroup, threadType);
        if (uploadResult && uploadResult[0]) {
          updatedLinks[imageName] = uploadResult[0].fileUrl || uploadResult[0].normalUrl;
        }
      } catch (error) {
        console.error(`Lỗi khi upload ảnh PR ${imageName}:`, error?.message || error);
      }
    }
  }

  for (const videoName of video) {
    const videoPath = resolveExistingPrMediaFile(videoPrDir, legacyVideoPrDir, videoName);
    if (!videoPath) continue;

    let videoUrl = updatedLinks[videoName];
    if (videoUrl) {
      const ok = await checkUrlStatus(videoUrl);
      if (!ok) videoUrl = null;
    }
    if (!videoUrl) {
      try {
        const uploadResult = await api.uploadAttachment([videoPath], idZaloGroup, threadType);
        if (uploadResult && uploadResult[0]) {
          updatedLinks[videoName] = uploadResult[0].fileUrl || uploadResult[0].normalUrl;
        }
      } catch (error) {
        console.error(`Lỗi khi upload video PR ${videoName}:`, error?.message || error);
      }
    }
  }

  return updatedLinks;
}

async function sendPRMessage(api, rawConfig, prObject, ttl, groupId = null) {
  const config = normalizeWebPrConfig(rawConfig);
  const { idZalo, isContentActive, isImageActive, isVideoActive, isCardActive } = prObject;
  const { imagePrDir, legacyImagePrDir } = getInstancePrPaths();
  const selectedFriends = groupId ? {} : config.selectedFriends || {};
  let selectedGroups = groupId
    ? { [groupId]: Boolean(config.selectedGroups?.[groupId]) }
    : { ...(config.selectedGroups || {}) };

  if (selectedGroups["-1"]) {
    try {
      const groups = await getDataAllGroup(api);
      selectedGroups = {};
      for (const group of groups) {
        if (group?.groupId) {
          selectedGroups[group.groupId] = true;
        }
      }
    } catch (error) {
      console.error("Lỗi khi lấy danh sách tất cả nhóm PR:", error?.message || error);
      return;
    }
  }

  try {
    const firstGroupTarget = Object.keys(selectedGroups).find((k) => selectedGroups[k]) || null;
    const firstFriendTarget = Object.keys(selectedFriends).find((k) => selectedFriends[k]) || null;
    const threadIdForAttachments = groupId || firstGroupTarget || firstFriendTarget || null;
    const targetTypeForAttachments =
      groupId || firstGroupTarget ? MessageType.GroupMessage : MessageType.DirectMessage;

    const defaultLinks = threadIdForAttachments
      ? await checkAndFixAttachments(api, prObject, threadIdForAttachments, targetTypeForAttachments)
      : prObject.link || {};

    if (JSON.stringify(prObject.link) !== JSON.stringify(defaultLinks)) {
      prObject.link = defaultLinks;
      const prIndex = config.prObjects.findIndex((pr) => pr.ten === prObject.ten);
      if (prIndex !== -1) {
        config.prObjects[prIndex] = prObject;
        await writeWebConfig(config);
      }
    }

    for (const targetGroupId in selectedGroups) {
      if (!selectedGroups[targetGroupId]) continue;

      const customGroupContent = prObject.customContent?.[targetGroupId];
      const tempPrObject = {
        ...prObject,
        noiDung: customGroupContent?.noiDung || prObject.noiDung,
        hinhAnh: customGroupContent?.hinhAnh || prObject.hinhAnh,
        video: customGroupContent?.video || prObject.video,
        link: customGroupContent?.link || defaultLinks,
      };

      if (customGroupContent) {
        const customLinks = await checkAndFixAttachments(
          api,
          tempPrObject,
          targetGroupId,
          MessageType.GroupMessage
        );
        if (JSON.stringify(tempPrObject.link) !== JSON.stringify(customLinks)) {
          tempPrObject.link = customLinks;
          const prIndex = config.prObjects.findIndex((pr) => pr.ten === prObject.ten);
          if (prIndex !== -1) {
            config.prObjects[prIndex].customContent[targetGroupId] = {
              ...customGroupContent,
              link: customLinks,
            };
            await writeWebConfig(config);
          }
        }
      }

      try {
        if (
          isContentActive &&
          tempPrObject.noiDung &&
          (!isVideoActive || tempPrObject.video.length === 0)
        ) {
          if (isImageActive && tempPrObject.hinhAnh.length === 1) {
            const link = tempPrObject.link[tempPrObject.hinhAnh[0]];
            if (link) {
              await api.sendImage(
                link,
                {
                  type: MessageType.GroupMessage,
                  threadId: targetGroupId,
                },
                tempPrObject.noiDung,
                ttl
              );
            } else {
              await api.sendMessage(
                { msg: tempPrObject.noiDung, ttl },
                targetGroupId,
                MessageType.GroupMessage
              );
            }
          } else {
            await api.sendMessage(
              { msg: tempPrObject.noiDung, ttl },
              targetGroupId,
              MessageType.GroupMessage
            );
          }
        }

        if (isVideoActive && tempPrObject.video.length > 0) {
          for (const videoName of tempPrObject.video) {
            const videoUrl = tempPrObject.link[videoName];
            if (videoUrl) {
              try {
                await api.sendVideo({
                  videoUrl,
                  threadId: targetGroupId,
                  threadType: MessageType.GroupMessage,
                  videoAlreadyUploaded: true,
                  message: {
                    text: isContentActive ? tempPrObject.noiDung : "",
                  },
                  ttl,
                });
              } catch (error) {
                console.error(
                  `Lỗi khi gửi video ${videoName} cho nhóm ${targetGroupId}:`,
                  error?.message || error
                );
              }
            }
          }
        }

        if (
          isImageActive &&
          tempPrObject.hinhAnh.length > 0 &&
          (tempPrObject.hinhAnh.length > 1 || (isVideoActive && tempPrObject.video.length > 0))
        ) {
          const imagePaths = tempPrObject.hinhAnh
            .map((imageName) => resolveExistingPrMediaFile(imagePrDir, legacyImagePrDir, imageName))
            .filter(Boolean);
          if (imagePaths.length > 0 && typeof api.zSendLocalImages === "function") {
            await api.zSendLocalImages(
              imagePaths,
              targetGroupId,
              MessageType.GroupMessage,
              800,
              600,
              { text: "" },
              ttl
            );
          }
        }

        if (isCardActive && idZalo && idZalo !== "-1") {
          try {
            await api.sendBusinessCard(
              null,
              idZalo,
              CAPTION_CARD,
              MessageType.GroupMessage,
              targetGroupId,
              ttl
            );
          } catch (error) {
            console.error(
              `Lỗi khi gửi business card cho nhóm ${targetGroupId}:`,
              error?.message || error
            );
          }
        }
      } catch (error) {
        console.error(`Lỗi khi gửi PR cho nhóm ${targetGroupId}:`, error?.message || error);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const defaultPrObject = {
      ...prObject,
      link: defaultLinks,
    };

    for (const friendId in selectedFriends) {
      if (!selectedFriends[friendId]) continue;
      try {
        if (
          isContentActive &&
          defaultPrObject.noiDung &&
          (!isVideoActive || defaultPrObject.video.length === 0)
        ) {
          if (isImageActive && defaultPrObject.hinhAnh.length === 1) {
            const link = defaultPrObject.link[defaultPrObject.hinhAnh[0]];
            if (link) {
              await api.sendImage(
                link,
                {
                  type: MessageType.DirectMessage,
                  threadId: friendId,
                },
                defaultPrObject.noiDung,
                ttl
              );
            } else {
              await api.sendMessage(
                { msg: defaultPrObject.noiDung, ttl },
                friendId,
                MessageType.DirectMessage
              );
            }
          } else {
            await api.sendMessage(
              { msg: defaultPrObject.noiDung, ttl },
              friendId,
              MessageType.DirectMessage
            );
          }
        }

        if (isVideoActive && defaultPrObject.video.length > 0) {
          for (const videoName of defaultPrObject.video) {
            const videoUrl = defaultPrObject.link[videoName];
            if (videoUrl) {
              try {
                await api.sendVideo({
                  videoUrl,
                  threadId: friendId,
                  threadType: MessageType.DirectMessage,
                  videoAlreadyUploaded: true,
                  message: {
                    text: isContentActive ? defaultPrObject.noiDung : "",
                  },
                  ttl,
                });
              } catch (error) {
                console.error(
                  `Lỗi khi gửi video ${videoName} cho bạn ${friendId}:`,
                  error?.message || error
                );
              }
            }
          }
        }

        if (
          isImageActive &&
          defaultPrObject.hinhAnh.length > 0 &&
          (defaultPrObject.hinhAnh.length > 1 || (isVideoActive && defaultPrObject.video.length > 0))
        ) {
          const imagePaths = defaultPrObject.hinhAnh
            .map((imageName) => resolveExistingPrMediaFile(imagePrDir, legacyImagePrDir, imageName))
            .filter(Boolean);
          if (imagePaths.length > 0 && typeof api.zSendLocalImages === "function") {
            await api.zSendLocalImages(
              imagePaths,
              friendId,
              MessageType.DirectMessage,
              800,
              600,
              { text: "" },
              ttl
            );
          }
        }

        if (isCardActive && idZalo && idZalo !== "-1") {
          try {
            await api.sendBusinessCard(
              null,
              idZalo,
              CAPTION_CARD,
              MessageType.DirectMessage,
              friendId,
              ttl
            );
          } catch (error) {
            console.error(
              `Lỗi khi gửi business card cho bạn ${friendId}:`,
              error?.message || error
            );
          }
        }
      } catch (error) {
        console.error(`Lỗi khi gửi PR cho bạn ${friendId}:`, error?.message || error);
      }
    }
  } catch (error) {
    console.error(`Lỗi khi gửi PR cho ${prObject.ten}:`, error?.message || error);
  }
}

async function schedulePR(api) {
  const botKey = String(api?.getBotId?.() || api?.getOwnId?.() || getBotId() || "admin");
  const prevJob = activePrJobsByBot.get(botKey);
  if (prevJob) {
    try {
      prevJob.cancel();
    } catch {
      // ignore stale job cancel error
    }
    activePrJobsByBot.delete(botKey);
  }

  const job = schedule.scheduleJob("0 * * * * *", async function () {
    if (runningPrLocksByBot.has(botKey)) {
      return;
    }
    runningPrLocksByBot.add(botKey);

    try {
      const rawConfig = await readWebConfig();
      const config = normalizeWebPrConfig(rawConfig);
      const currentHourMinute = getVietnamHourMinute();
      const ttl = 3600000;
      const prObjects = normalizePrObjects(config?.prObjects);

      for (const prObject of prObjects) {
        const prKey = `${botKey}:${prObject.ten}_${currentHourMinute}`;
        if (sentPRs.has(prKey) && Date.now() - sentPRs.get(prKey) < 60000) {
          continue;
        }

        if (prObject.thoiGianGui.includes(currentHourMinute)) {
          await sendPRMessage(api, config, prObject, ttl);
          sentPRs.set(prKey, Date.now());
        }

        for (const groupId in config.selectedGroups) {
          if (config.selectedGroups[groupId] && prObject.customContent[groupId]?.periodicTime) {
            const periodicTime = prObject.customContent[groupId].periodicTime;
            const intervalMs = parsePeriodicTime(periodicTime);
            if (intervalMs > 0) {
              const lastSent = prObject.customContent[groupId].lastSent || 0;
              const now = Date.now();
              if (now - lastSent >= intervalMs) {
                await sendPRMessage(api, config, prObject, ttl, groupId);
                prObject.customContent[groupId].lastSent = now;
                await writeWebConfig(config);
              }
            }
          }
        }
      }

      const now = Date.now();
      for (const [key, timestamp] of sentPRs) {
        if (now - timestamp > 60000) {
          sentPRs.delete(key);
        }
      }
    } finally {
      runningPrLocksByBot.delete(botKey);
    }
  });

  activePrJobsByBot.set(botKey, job);
}

export async function initPRService(api) {
  let config = await readWebConfig();
  if (!config || Object.keys(config).length === 0 || Array.isArray(config)) {
    config = {
      prObjects: [
        {
          ten: "",
          idZalo: "-1",
          noiDung: "",
          hinhAnh: [],
          video: [],
          link: {},
          thoiGianGui: [],
          customContent: {},
          isContentActive: true,
          isImageActive: true,
          isVideoActive: true,
          isCardActive: true,
        },
      ],
      selectedGroups: {},
      selectedFriends: {},
    };
    await writeWebConfig(config);
    console.log(chalk.yellow("Đã khởi tạo webConfig.json với cấu hình mặc định"));
  } else {
    config = normalizeWebPrConfig(config);
    await writeWebConfig(config);
    console.log(chalk.yellow("Đã kiểm tra và hoàn thiện cấu hình webConfig.json"));
  }
  await schedulePR(api);
  console.log(chalk.yellow("Dịch vụ PR đã khởi tạo thành công"));
}
