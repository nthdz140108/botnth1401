const MISSING_TARGET_MESSAGE = "Hãy reply tin nhắn bot cần thu hồi rồi dùng !undo.";

async function sendUndoNotice(api, message, text) {
  await api.sendMessage({ msg: text, ttl: 30000, linkOn: false }, message.threadId, message.type);
}

export function resolveUndoCommandTarget(message) {
  const quote = message?.data?.quote ?? message?.quote;
  const targetMsgId = quote?.globalMsgId ?? quote?.msgId;
  const targetCliMsgId = quote?.cliMsgId;

  if (!targetMsgId || !targetCliMsgId || message?.threadId == null || message?.type == null) {
    return null;
  }

  return {
    threadId: message.threadId,
    type: message.type,
    data: {
      msgId: targetMsgId,
      globalMsgId: targetMsgId,
      cliMsgId: targetCliMsgId,
    },
  };
}

export async function handleUndoMessage(api, message) {
  const target = resolveUndoCommandTarget(message);
  if (!target) {
    await sendUndoNotice(api, message, MISSING_TARGET_MESSAGE);
    return;
  }

  try {
    console.info(`[UNDO COMMAND] commandMsgId=${message.data?.msgId ?? "unknown"} targetMsgId=${target.data.msgId}`);
    await api.undoMessage(target);
  } catch (error) {
    await sendUndoNotice(api, message, `Lỗi khi xử lý lệnh undo: ${error.message}`);
  }
}
