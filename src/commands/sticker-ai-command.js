export async function handleStickerAiCommand({
  api,
  message,
  isAdminLevelHighest = false,
  aliasCommand = "sticker ai",
}) {
  const [{ handleStickerCommand }, { runWithHfFallbackTracker, getHfFallbackState }] =
    await Promise.all([
      import("../service-debug/chat-zalo/chat-special/send-sticker/sticker/index.js"),
      import("../service-debug/chat-zalo/chat-special/send-sticker/sticker/hf.js"),
    ]);

  const wrappedApi =
    api && typeof api === "object"
      ? new Proxy(api, {
          get(target, prop, receiver) {
            if (prop === "sendMessage" && typeof target.sendMessage === "function") {
              return async (payload, threadId, type) => {
                const state = getHfFallbackState();
                if (
                  state?.usedT2iFallback &&
                  payload &&
                  typeof payload === "object" &&
                  typeof payload.msg === "string" &&
                  payload.msg.includes("Sticker của bạn đây!")
                ) {
                  const note =
                    "\n(Lưu ý: Model chỉnh sửa ảnh gốc không khả dụng trên gói HF miễn phí nên đã chuyển sang tạo sticker mới theo mô tả.)";
                  return target.sendMessage({ ...payload, msg: `${payload.msg}${note}` }, threadId, type);
                }
                return target.sendMessage(payload, threadId, type);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : api;

  return runWithHfFallbackTracker(() =>
    handleStickerCommand(wrappedApi, message, {
      aliasCommand,
      isAdminLevelHighest,
      forceAiMode: true,
    })
  );
}

export const __test = {};
