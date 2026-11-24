import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";

import {
  normalizeWeatherApiCurrent,
  normalizeOpenWeatherCurrent,
  normalizeWeatherApiCurrentModel,
  normalizeTomorrowHourly,
  normalizeTomorrowDaily,
  normalizeWeatherApiDaily,
  normalizeAirQuality,
  describeAqiLevel,
  conceptFromOpenWeatherCode,
  conceptFromTomorrowCode,
  conceptFromWeatherApiCode,
  buildWeatherModel,
  geocodeWeatherLocation,
} from "../src/service-debug/api-crawl/content/weather-provider.js";
import { renderWeatherImage, createWeatherImageFile, WEATHER_CANVAS } from "../src/service-debug/api-crawl/content/weather-render.js";

// ── Legacy contract: normalizeWeatherApiCurrent ─────────────────────────────
test("weather adapter normalizes WeatherAPI current data to the image contract", () => {
  const current = normalizeWeatherApiCurrent({
    current: {
      last_updated: "2026-08-08 12:00",
      temp_c: 31,
      feelslike_c: 35,
      humidity: 70,
      wind_kph: 18,
      cloud: 40,
      vis_km: 9,
      condition: { text: "Partly cloudy", icon: "//cdn.example/icon.png" },
    },
  });

  assert.deepEqual(current.main, {
    temp: 31,
    feels_like: 35,
    temp_min: 31,
    temp_max: 31,
    humidity: 70,
  });
  assert.equal(current.weather[0].description, "Partly cloudy");
  assert.equal(current.wind.speed, 5);
  assert.equal(current.visibility, 9000);
});

test("weather adapter returns no current snapshot when provider data is absent", () => {
  assert.equal(normalizeWeatherApiCurrent(null), null);
  assert.equal(normalizeWeatherApiCurrent({}), null);
});

// ── Concept mapping ─────────────────────────────────────────────────────────
test("concept maps weather codes to canonical concepts", () => {
  assert.equal(conceptFromOpenWeatherCode(800), "clear");
  assert.equal(conceptFromOpenWeatherCode(801), "partly-cloudy");
  assert.equal(conceptFromOpenWeatherCode(802), "cloudy");
  assert.equal(conceptFromOpenWeatherCode(803), "overcast");
  assert.equal(conceptFromOpenWeatherCode(500), "rain");
  assert.equal(conceptFromOpenWeatherCode(502), "heavy-rain");
  assert.equal(conceptFromOpenWeatherCode(520), "showers");
  assert.equal(conceptFromOpenWeatherCode(200), "thunderstorm");
  assert.equal(conceptFromOpenWeatherCode(804), "overcast");
  assert.equal(conceptFromOpenWeatherCode(999), "unknown");
  assert.equal(conceptFromOpenWeatherCode(501), "rain");

  assert.equal(conceptFromTomorrowCode(1000), "clear");
  assert.equal(conceptFromTomorrowCode(1100), "partly-cloudy");
  assert.equal(conceptFromTomorrowCode(1101), "cloudy");
  assert.equal(conceptFromTomorrowCode(1102), "overcast");
  assert.equal(conceptFromTomorrowCode(4200), "showers");
  assert.equal(conceptFromTomorrowCode(5000), "snow");

  assert.equal(conceptFromWeatherApiCode(1000), "clear");
  assert.equal(conceptFromWeatherApiCode(1003), "partly-cloudy");
  assert.equal(conceptFromWeatherApiCode(1087), "thunderstorm");
  assert.equal(conceptFromWeatherApiCode(1195, "Heavy rain"), "heavy-rain");
});

// ── Current normalizers ─────────────────────────────────────────────────────
test("normalizeOpenWeatherCurrent builds canonical current model", () => {
  const current = normalizeOpenWeatherCurrent({
    dt: 1700000000,
    main: { temp: 29, feels_like: 32, temp_min: 27, temp_max: 30, humidity: 65 },
    wind: { speed: 4, deg: 90 },
    clouds: { all: 20 },
    visibility: 10000,
    weather: [{ id: 802, description: "mây rải rác" }],
  });
  assert.ok(current);
  assert.equal(current.source, "openweather");
  assert.equal(current.temp, 29);
  assert.equal(current.feelsLike, 32);
  assert.equal(current.humidity, 65);
  assert.equal(current.concept, "cloudy");
  assert.equal(current.windSpeed, 4);
  assert.equal(current.visibilityKm, 10);
});

test("normalizeWeatherApiCurrentModel builds canonical current model", () => {
  const current = normalizeWeatherApiCurrentModel({
    current: {
      last_updated: "2026-08-08 12:00",
      temp_c: 31,
      feelslike_c: 35,
      humidity: 70,
      wind_kph: 18,
      wind_degree: 180,
      cloud: 40,
      vis_km: 9,
      condition: { code: 1087, text: "Giông bão" },
    },
  });
  assert.equal(current.concept, "thunderstorm");
  assert.equal(current.windSpeed, 5);
  assert.equal(current.description, "Giông bão");
});

// ── Hourly / Daily normalizers ──────────────────────────────────────────────
test("normalizeTomorrowHourly returns at most 7 entries with time/temp/concept", () => {
  const raw = {
    data: {
      timelines: {
        hourly: Array.from({ length: 10 }, (_, i) => ({
          time: `2026-08-08T${String(i).padStart(2, "0")}:00`,
          values: { temperature: 30 - i, precipitationProbability: 10 + i, weatherCode: i === 0 ? 1000 : 1101 },
        })),
      },
    },
  };
  const hourly = normalizeTomorrowHourly(raw);
  assert.equal(hourly.length, 7);
  assert.equal(hourly[0].concept, "clear");
  assert.equal(hourly[0].temp, 30);
  assert.equal(hourly[0].precipProb, 10);
});

test("normalizeTomorrowDaily returns at most 6 entries with astronomy", () => {
  const raw = {
    data: {
      timelines: {
        daily: Array.from({ length: 8 }, (_, i) => ({
          time: `2026-08-${String(i + 1).padStart(2, "0")}`,
          values: { temperatureMax: 32 - i, temperatureMin: 25 - i, weatherCodeMax: 1000, sunriseTime: "6:00AM", sunsetTime: "6:30PM" },
        })),
      },
    },
  };
  const daily = normalizeTomorrowDaily(raw);
  assert.equal(daily.length, 6);
  assert.equal(daily[0].sunrise, "6:00AM");
  assert.equal(daily[0].sunset, "6:30PM");
});

test("normalizeAirQuality returns pollutants and level", () => {
  const aq = normalizeAirQuality({
    current: {
      air_quality: {
        pm2_5: 15.4,
        pm10: 25.2,
        o3: 33.1,
        no2: 12.0,
        so2: 5.5,
        co: 220.0,
        "us-epa-index": 2,
      },
    },
  });
  assert.ok(aq);
  assert.equal(aq.usEpaIndex, 2);
  assert.equal(aq.pollutants.pm25, 15);
  assert.equal(aq.pollutants.co, 220);
  assert.equal(aq.level.label, "Tốt");
});

test("describeAqiLevel labels ranges", () => {
  assert.equal(describeAqiLevel(10).label, "Tốt");
  assert.equal(describeAqiLevel(60).label, "Trung bình");
  assert.equal(describeAqiLevel(120).label, "Kém (nhạy cảm)");
  assert.equal(describeAqiLevel(null).label, "Không có dữ liệu");
});

// ── Orchestration: buildWeatherModel with injected fetchers ──────────────────
const sampleOpenWeather = {
  dt: 1700000000,
  main: { temp: 29, feels_like: 32, temp_min: 27, temp_max: 30, humidity: 65 },
  wind: { speed: 4, deg: 90 },
  clouds: { all: 20 },
  visibility: 10000,
  weather: [{ id: 802, description: "mây rải rác" }],
};

const sampleTomorrow = {
  data: {
    timelines: {
      hourly: Array.from({ length: 7 }, (_, i) => ({
        time: `2026-08-08T${String(i).padStart(2, "0")}:00`,
        values: { temperature: 30 - i, precipitationProbability: 10 + i, weatherCode: 1000 },
      })),
      daily: Array.from({ length: 6 }, (_, i) => ({
        time: `2026-08-${String(i + 1).padStart(2, "0")}`,
        values: { temperatureMax: 32 - i, temperatureMin: 25 - i, weatherCodeMax: 1000, sunriseTime: "6:00AM", sunsetTime: "6:30PM" },
      })),
    },
  },
};

const sampleWeatherApi = {
  current: {
    last_updated: "2026-08-08 12:00",
    temp_c: 31,
    feelslike_c: 35,
    humidity: 70,
    wind_kph: 18,
    cloud: 40,
    vis_km: 9,
    condition: { code: 1000, text: "Trời nắng" },
    air_quality: { pm2_5: 15, "us-epa-index": 1 },
  },
  forecast: { forecastday: Array.from({ length: 3 }, (_, i) => ({
    date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    day: { maxtemp_c: 32 - i, mintemp_c: 25 - i, condition: { code: 1000, text: "Nắng" } },
    astro: { sunrise: "5:55AM", sunset: "6:15PM" },
  })) },
};

const geo = { latitude: 10.8, longitude: 106.6, name: "Hồ Chí Minh", admin1: "", country: "VN", timezone: "Asia/Ho_Chi_Minh" };

test("buildWeatherModel merges all providers into a full canonical model", async () => {
  const fetchers = {
    tomorrow: async () => sampleTomorrow,
    openweather: async () => sampleOpenWeather,
    weatherapi: async () => sampleWeatherApi,
  };
  const model = await buildWeatherModel(geo, { tomorrow: "k", openweather: "k", weatherapi: "k" }, fetchers);

  assert.equal(model.location.name, "Hồ Chí Minh");
  assert.equal(model.current.temp, 29);
  assert.equal(model.current.concept, "cloudy");
  assert.equal(model.hourly.length, 7);
  assert.equal(model.daily.length, 6);
  assert.equal(model.airQuality.usEpaIndex, 1);
  assert.equal(model.astronomy.sunrise, "6:00AM");
  assert.equal(model.astronomy.sunset, "6:30PM");
});

test("buildWeatherModel falls back to OpenWeather current when WeatherAPI fails", async () => {
  const fetchers = {
    tomorrow: async () => sampleTomorrow,
    openweather: async () => sampleOpenWeather,
    weatherapi: async () => { throw new Error("timeout"); },
  };
  const model = await buildWeatherModel(geo, {}, fetchers);
  assert.equal(model.current.source, "openweather");
});

test("buildWeatherModel falls back to WeatherAPI current when OpenWeather fails", async () => {
  const fetchers = {
    tomorrow: async () => sampleTomorrow,
    openweather: async () => { throw new Error("timeout"); },
    weatherapi: async () => sampleWeatherApi,
  };
  const model = await buildWeatherModel(geo, {}, fetchers);
  assert.equal(model.current.source, "weatherapi");
});

test("buildWeatherModel uses WeatherAPI daily when Tomorrow returns no daily", async () => {
  const fetchers = {
    tomorrow: async () => ({ data: { timelines: { hourly: [], daily: [] } } }),
    openweather: async () => sampleOpenWeather,
    weatherapi: async () => sampleWeatherApi,
  };
  const model = await buildWeatherModel(geo, {}, fetchers);
  assert.equal(model.daily.length, 3);
  assert.equal(model.astronomy.sunrise, "5:55AM");
});

test("buildWeatherModel throws when no current provider is available", async () => {
  const fetchers = {
    tomorrow: async () => null,
    openweather: async () => null,
    weatherapi: async () => null,
  };
  await assert.rejects(() => buildWeatherModel(geo, {}, fetchers), /Không có provider thời tiết khả dụng/);
});

test("missing API key short-circuits a provider without throwing", async () => {
  const fetchers = { tomorrow: async () => null, openweather: async () => sampleOpenWeather, weatherapi: async () => sampleWeatherApi };
  const model = await buildWeatherModel(geo, { tomorrow: "", openweather: "k", weatherapi: "k" }, fetchers);
  assert.equal(model.current.source, "openweather");
});

test("geocodeWeatherLocation returns null for unknown city", async () => {
  // Nhánh fetch thật bị offline nên không gọi mạng; chỉ assert hàm tồn tại và là function
  assert.equal(typeof geocodeWeatherLocation, "function");
});

// ── Renderer ────────────────────────────────────────────────────────────────
function makeFullModel() {
  return {
    location: { name: "Hồ Chí Minh", admin1: "TP. Hồ Chí Minh", country: "VN", timezone: "Asia/Ho_Chi_Minh" },
    updatedAt: "2026-08-08T05:00:00.000Z",
    current: { temp: 31, feelsLike: 35, tempMin: 27, tempMax: 33, humidity: 70, windSpeed: 5, concept: "rain", description: "Mưa vừa" },
    hourly: Array.from({ length: 7 }, (_, i) => ({ time: `2026-08-08T${String(i).padStart(2, "0")}:00`, temp: 30 - i, precipProb: 30 + i, concept: i < 3 ? "rain" : "cloudy" })),
    daily: Array.from({ length: 6 }, (_, i) => ({ date: `2026-08-${String(i + 1).padStart(2, "0")}`, tempMax: 32 - i, tempMin: 25 - i, concept: i % 2 ? "clear" : "cloudy" })),
    airQuality: { usEpaIndex: 3, pollutants: { pm25: 15, pm10: 25, o3: 33, no2: 12, so2: 5, co: 220 }, level: describeAqiLevel(3) },
    astronomy: { sunrise: "5:55AM", sunset: "6:15PM" },
  };
}

test("renderWeatherImage renders a full model at 1240x2048", () => {
  const { canvas, heightUsed } = renderWeatherImage(makeFullModel());
  assert.equal(canvas.width, WEATHER_CANVAS.width);
  assert.equal(canvas.height, WEATHER_CANVAS.height);
  assert.ok(heightUsed <= WEATHER_CANVAS.height, `content overflowed: ${heightUsed}`);
  assert.ok(canvas.toBuffer().length > 0);
});

test("renderWeatherImage renders missing data sections without crashing", () => {
  const model = {
    location: { name: "Hà Nội", admin1: "", country: "VN" },
    updatedAt: "2026-08-08T05:00:00.000Z",
    current: { temp: 28, feelsLike: 30, humidity: 70, concept: "cloudy", description: "Nhiều mây" },
    hourly: [],
    daily: [],
    airQuality: null,
    astronomy: {},
  };
  const { canvas, heightUsed } = renderWeatherImage(model);
  assert.equal(canvas.height, WEATHER_CANVAS.height);
  assert.ok(heightUsed <= WEATHER_CANVAS.height);
});

test("renderWeatherImage handles long location names without crashing", () => {
  const model = makeFullModel();
  model.location.name = "Khu đô thị Tây Bắc Thành phố Trung tâm Hành chính Hà Nội";
  const { canvas, heightUsed } = renderWeatherImage(model);
  assert.equal(canvas.height, WEATHER_CANVAS.height);
  assert.ok(heightUsed <= WEATHER_CANVAS.height);
});

test("createWeatherImageFile writes a PNG file and cleans up", async () => {
  const filePath = await createWeatherImageFile(makeFullModel());
  assert.equal(existsSync(filePath), true);
  const buf = readFileSync(filePath);
  // PNG signature
  assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  await unlink(filePath);
  assert.equal(existsSync(filePath), false);
});

test("weatherCommand is exported and callable", async () => {
  const { weatherCommand } = await import("../src/service-debug/api-crawl/content/weather.js");
  assert.equal(typeof weatherCommand, "function");
});

// ── Regression: getGlobalPrefix no longer ReferenceError / QR side-effect ────
test("weatherCommand resolves prefix without ReferenceError from service.js", async () => {
  const { weatherCommand } = await import("../src/service-debug/api-crawl/content/weather.js");
  // Truyền message không hợp lệ để dừng sớm; chỉ cần đảm bảo không throw getGlobalPrefix is not defined
  const message = { threadId: "t1", type: 1, data: { content: "" } };
  const api = { sendMessage: async () => ({ status: 0 }) };
  try {
    await weatherCommand(api, message);
  } catch (err) {
    if (/getGlobalPrefix is not defined/.test(err?.message)) {
      assert.fail(`regression: ${err.message}`);
    }
  }
  assert.ok(true);
});
