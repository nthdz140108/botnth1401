export async function handleStickerAiCommand({ api, message, isAdminLevelHighest = false, aliasCommand = "sticker ai" }) {
  const { handleStickerCommand } = await import("../service-debug/chat-zalo/chat-special/send-sticker/sticker/index.js");
  return handleStickerCommand(api, message, {
    aliasCommand,
    isAdminLevelHighest,
    forceAiMode: true,
  });
}

export const __test = {};