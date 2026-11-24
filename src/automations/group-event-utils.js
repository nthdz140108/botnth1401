import { GroupEventType } from "../api-zalo/models/index.js";

const MEMBER_EVENT_TYPES = new Set([
  GroupEventType.JOIN,
  GroupEventType.LEAVE,
  GroupEventType.REMOVE_MEMBER,
  GroupEventType.BLOCK_MEMBER,
]);

export function getGroupEventMembers(event) {
  if (!MEMBER_EVENT_TYPES.has(event?.type)) {
    return [];
  }

  const members = event?.data?.updateMembers;
  if (!Array.isArray(members)) {
    return [];
  }

  return members.filter((member) => member && member.id !== undefined && member.id !== null);
}

export function getGroupEventActorId(event) {
  const actorId = event?.data?.sourceId || event?.data?.actorId;
  return actorId === undefined || actorId === null ? "" : String(actorId);
}
