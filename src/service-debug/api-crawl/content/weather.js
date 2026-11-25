import { extractCommandBody, getRawMessageText, safeThreadType } from "../../../commands/shared/command-input-utils.js";
import { deleteFile } from "../../../utils/util.js";
import { readCommandConfig } from "../../../utils/io-json.js";
import {
  geocodeWeatherLocation,
  buildWeatherModel,
} from "./weather-provider.js";
import { createWeatherImageFile } from "./weather-render.js";

const WEATHER_IMAGE_TTL_MS = 300000;

// Lấy prefix hiện tại từ cấu hình lệnh (nhẹ, không kéo theo side-effect của service.js)
function getGlobalPrefix() {
  return readCommandConfig().prefix || "!";
}

function getWeatherApiKeys() {
  return {
    tomorrow: process.env.TOMORROW_API_KEY || "",
    openweather: process.env.OPENWEATHER_API_KEY || "",
    weatherapi: process.env.WEATHERAPI_KEY || process.env.WEATHER_API_KEY || "",
  };
}

// Hàm xử lý tên người dùng
export function hanldeNameUser(name) {
  const words = name.split(" ");
  let line1 = "";
  let line2 = "";

  if (name.length <= 16) {
    return [name, ""];
  }

  if (words.length === 1) {
    line1 = name.substring(0, 16);
    line2 = name.substring(16);
  } else {
    for (let i = 0; i < words.length; i++) {
      if ((line1 + " " + words[i]).trim().length <= 16) {
        line1 += (line1 ? " " : "") + words[i];
      } else {
        line2 = words.slice(i).join(" ");
        break;
      }
    }
  }

  return [line1.trim(), line2.trim()];
}

// Hàm xử lý tên dài
export function handleNameLong(name, lengthLine = 16) {
  const words = name.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length <= lengthLine) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) {
        lines.push(currentLine.trim());
      }
      currentLine = word;
    }
  }

  if (currentLine) {
    lines.push(currentLine.trim());
  }

  if (lines.length === 0) {
    lines.push(name);
  }

  return { lines, totalLines: lines.length };
}

// Để tương thích với các phiên bản cũ hơn, sử dụng tên hàm đúng
export const handleNameUser = hanldeNameUser;

// Hàm xử lý lệnh thời tiết
export async function weatherCommand(api, message, aliasCommand = "thoitiet") {
  const rawText = getRawMessageText(message).trim();
  const prefix = getGlobalPrefix();
  if (!rawText) {
    return;
  }

  const threadId = message.threadId;
  const location = extractCommandBody(message, prefix, aliasCommand || "thoitiet");

  if (!location) {
    await getOverallWeather(api, message, threadId);
  } else {
    await getLocalWeather(api, message, threadId, location);
  }
}

// Hàm lấy thời tiết tổng quan (chọn ngẫu nhiên một thành phố lớn)
async function getOverallWeather(api, message, threadId) {
  try {
    const majorCities = ["Hà Nội", "Hồ Chí Minh", "Đà Nẵng", "Cần Thơ", "Huế"];
    const randomCity = majorCities[Math.floor(Math.random() * majorCities.length)];
    await getLocalWeather(api, message, threadId, randomCity, true);
  } catch (error) {
    console.error("Lỗi khi lấy thông tin thời tiết tổng quan:", error);
    await api.sendMessage(
      { msg: "Đã xảy ra lỗi khi lấy thông tin thời tiết tổng quan. Vui lòng thử lại sau.", quote: message },
      threadId,
      safeThreadType(message)
    );
  }
}

async function getLocalWeather(api, message, threadId, location, isOverall = false) {
  const threadType = safeThreadType(message);
  try {
    // Lấy tọa độ địa lý
    const geo = await geocodeWeatherLocation(location);
    if (!geo) {
      await api.sendMessage(
        { msg: "Không tìm thấy thành phố. Vui lòng kiểm tra lại tên thành phố.", quote: message },
        threadId,
        threadType
      );
      return;
    }

    // Lấy thời tiết từ nhiều provider song song (Open-Meteo miễn phí không cần key + hợp nhất key nếu có)
    const model = await buildWeatherModel(geo, getWeatherApiKeys());

    // Gán nhãn tổng quan khi người dùng không nhập địa điểm
    if (isOverall) {
      model.location.name = `Tổng quan - ${model.location.name}`;
    }

    // Render và gửi ảnh thời tiết với TTL 5 phút; file tạm luôn được dọn
    await sendWeatherImage(api, message, model, threadId);
  } catch (error) {
    console.error("Lỗi khi lấy thông tin thời tiết địa phương:", error);
    await api.sendMessage(
      { msg: `Đã xảy ra lỗi khi xử lý thông tin thời tiết: ${error.message}`, quote: message },
      threadId,
      threadType
    );
  }
}

async function sendWeatherImage(api, message, model, threadId) {
  const filePath = await createWeatherImageFile(model);
  try {
    await api.sendMessage(
      {
        msg: "",
        attachments: [filePath],
        quote: message,
        ttl: WEATHER_IMAGE_TTL_MS,
      },
      threadId,
      safeThreadType(message)
    );
  } finally {
    await deleteFile(filePath);
  }
}
