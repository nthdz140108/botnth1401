import { removeBackgroundFromImageUrl, removeBackgroundFromImageBase64 } from "remove.bg";

export async function removeBackground(input) {
  const apiKey = process.env.REMOVE_BG_API_KEY || "";
  if (!apiKey) {
    const error = new Error("REMOVE_BG_API_KEY Không được cấu hình");
    error.code = "MISSING_DEPENDENCY";
    throw error;
  }

  try {
    let result;
    if (Buffer.isBuffer(input)) {
      result = await removeBackgroundFromImageBase64({
        base64img: input.toString("base64"),
        apiKey,
        size: "regular",
        type: "auto",
      });
    } else if (typeof input === "string" && /^https?:\/\//i.test(input.trim())) {
      result = await removeBackgroundFromImageUrl({
        url: input.trim(),
        apiKey,
        size: "regular",
        type: "auto",
      });
    } else if (typeof input === "string") {
      result = await removeBackgroundFromImageBase64({
        base64img: input.trim(),
        apiKey,
        size: "regular",
        type: "auto",
      });
    } else {
      throw new Error("Đầu vào xóa phông không hợp lệ (cần URL hoặc Buffer ảnh)");
    }

    if (!result?.base64img) {
      throw new Error("Provider remove.bg không trả về dữ liệu ảnh");
    }

    return Buffer.from(result.base64img, "base64");
  } catch (error) {
    if (error?.code === "MISSING_DEPENDENCY") throw error;
    const message = error?.message || String(error);
    const providerError = new Error(`Lỗi xóa phông remove.bg: ${message}`);
    providerError.code = "REMOVE_BG_ERROR";
    providerError.cause = error;
    throw providerError;
  }
}
