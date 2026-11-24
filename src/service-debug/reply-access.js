export function canContinueReply(replyData, senderId, threadId) {
  if (
    replyData?.threadId != null &&
    threadId != null &&
    String(replyData.threadId) !== String(threadId)
  ) {
    return false;
  }
  if (replyData?.replyAccess === "public") return true;
  return replyData?.userRequest === senderId || replyData?.senderId === senderId;
}
