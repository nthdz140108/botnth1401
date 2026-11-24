import chalk from "chalk";
import { readGroupSettings } from "../../utils/io-json.js";

import { LRUCache } from "lru-cache";

const groupInfoCache = new LRUCache({ max: 500, ttl: 30_000 });
const CACHE_DURATION = 30_000;
const inFlightRequests = new Map();

export function getGroupInfoCache() {
  return groupInfoCache;
}

export function getInFlightGroupRequestCount() {
  return inFlightRequests.size;
}

export function clearInFlightGroupRequests() {
  inFlightRequests.clear();
}

export function isHttpNotFound(error) {
  return error?.status === 404;
}

export async function getGroupName(api, threadId) {
  try {
    return (await getGroupInfoData(api, threadId)).name;
  } catch (error) {
    console.warn("Unable to get group name:", error);
    return `Group ${threadId}`;
  }
}

export async function getGroupInfoData(api, threadId) {
  const cachedData = groupInfoCache.get(threadId);
  if (cachedData && Date.now() - cachedData.timestamp < CACHE_DURATION) {
    return cachedData.data;
  }

  const inflightKey = String(threadId);
  if (inFlightRequests.has(inflightKey)) {
    return inFlightRequests.get(inflightKey);
  }

  const promise = (async () => {
    try {
      return await _fetchGroupInfoInternal(api, threadId);
    } finally {
      inFlightRequests.delete(inflightKey);
    }
  })();

  inFlightRequests.set(inflightKey, promise);
  return promise;
}

async function _fetchGroupInfoInternal(api, threadId) {
  const maxRetries = 3;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const groupInfo = await api.getGroupInfo(threadId);
      const processedInfo = getAllInfoGroup(groupInfo, threadId);
      if (!processedInfo.name) throw new Error("Empty group info returned");
      groupInfoCache.set(threadId, {
        data: processedInfo,
        timestamp: Date.now(),
      });
      return processedInfo;
    } catch (error) {
      lastError = error;
      if (isHttpNotFound(error) && attempt < maxRetries) {
        const delay = 500 * attempt;
        console.warn(
          chalk.yellow(
            `[group-info] HTTP 404 groupId=${threadId}; retrying in ${delay}ms (${attempt}/${maxRetries})`
          )
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      break;
    }
  }

  const staleCache = groupInfoCache.get(threadId);
  if (staleCache?.data?.name) return staleCache.data;

  let minimalName = "";
  try {
    minimalName = readGroupSettings()[threadId]?.nameGroup || "";
  } catch (settingsError) {
    console.warn(`[group-info] Unable to read group settings: ${settingsError.message}`);
  }
  minimalName ||= `Group ${threadId}`;
  console.warn(
    chalk.yellow(
      `[group-info] Unable to load groupId=${threadId}: ${lastError?.message || "unknown error"}; using minimal metadata`
    )
  );

  return {
    name: minimalName,
    memberCount: 0,
    createdTime: "",
    groupType: "",
    memVerList: [],
    creatorId: "",
    adminIds: [],
    admins: [],
    avt: "",
    fullAvt: "",
    globalId: "",
    groupId: threadId,
    desc: "",
    setting: {},
    totalMember: 0,
  };
}

export function getAllInfoGroup(groupInfo, threadId) {
  const mapEntry = groupInfo?.gridInfoMap?.[threadId];
  const info = mapEntry && typeof mapEntry === "object" ? mapEntry : {};
  return {
    name: info.name || "",
    memberCount: Array.isArray(info.memVerList) ? info.memVerList.length : 0,
    createdTime: info.createdTime
      ? new Date(info.createdTime).toLocaleString()
      : "",
    groupType: info.type || "",
    memVerList: info.memVerList || [],
    creatorId: info.creatorId || "",
    adminIds: info.adminIds || [],
    admins: info.admins || [],
    avt: info.avt || "",
    fullAvt: info.fullAvt || "",
    globalId: info.globalId || "",
    groupId: info.groupId || threadId,
    desc: info.desc || "",
    setting: info.setting || {},
    totalMember: info.totalMember || 0,
  };
}

export async function getDataAllGroup(api) {
  const allGroupsResult = await api.getAllGroups();
  if (!allGroupsResult?.gridVerMap) {
    throw new Error("Unable to get group list");
  }

  const groupIds = Object.keys(allGroupsResult.gridVerMap);
  const allGroupsInfo = await Promise.all(
    groupIds.map(async (threadId) => {
      try {
        return await getGroupInfoData(api, threadId);
      } catch (error) {
        console.error(`Unable to get group info ${threadId}:`, error);
        return null;
      }
    })
  );
  return allGroupsInfo.filter(Boolean);
}
