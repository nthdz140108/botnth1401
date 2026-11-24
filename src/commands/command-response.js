export async function sendReactionConfirmReceive(api, message, numHandleCommand) {
  if (numHandleCommand !== undefined && ![1, 2, 3, 5].includes(numHandleCommand)) {
    return false;
  }
  const messageId = message?.data?.msgId || message?.data?.cliMsgId || message?.msgId;
  if (!api?.addReaction || !messageId || !message?.threadId) {
    return false;
  }
  if (message._confirmReactionSent) {
    return true;
  }

  try {
    await api.addReaction("thanks", message);
    message._confirmReactionSent = true;
    return true;
  } catch (error) {
    console.error("Lỗi khi thả reaction xác nhận command:", {
      threadId: message?.threadId,
      senderId: message?.data?.uidFrom,
      msgId: messageId,
      numHandleCommand,
      error,
    });
    return false;
  }
}

export function createCommandErrorReference(message, error) {
  const threadPart = message?.threadId ? String(message.threadId) : "unknown-thread";
  const senderPart = message?.data?.uidFrom ? String(message.data.uidFrom) : "unknown-user";
  const errorName = error instanceof Error ? error.name : typeof error;
  const referenceSeed = `${threadPart}:${senderPart}:${Date.now()}:${errorName}`;
  let hash = 0;
  for (let index = 0; index < referenceSeed.length; index += 1) {
    hash = (hash * 31 + referenceSeed.charCodeAt(index)) >>> 0;
  }
  return `CMD-${hash.toString(16).toUpperCase().padStart(8, "0")}`;
}

export async function sendCommandError(api, message, error) {
  const threadId = message?.threadId;
  const senderId = message?.data?.uidFrom;
  const reference = createCommandErrorReference(message, error);
  try {
    await api.sendMessage(
      {
        msg: `Đã xảy ra lỗi khi xử lý lệnh. Vui lòng thử lại sau.\nMã lỗi: ${reference}`,
      },
      threadId,
      message?.type
    );
  } catch (sendError) {
    console.error("Lỗi khi gửi thông báo lỗi command", {
      reference,
      threadId,
      senderId,
      sendError,
      originalError: error,
    });
    return false;
  }
  console.error("Lỗi command đã được báo cho người dùng", {
    reference,
    threadId,
    senderId,
    error,
  });
  return true;
}
