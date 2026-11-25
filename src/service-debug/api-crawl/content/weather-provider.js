import { LRUCache } from "lru-cache";
import { fetchJsonWithCache } from "../../../utils/public-api-cache.js";

const openMeteoCache = new LRUCache({ max: 200, ttl: 10 * 60 * 1000 });

const CITY_QUERY_ALIASES = Object.freeze({
  hcm: "Ho Chi Minh City",
  tphcm: "Ho Chi Minh City",
  "tp hcm": "Ho Chi Minh City",
  "tp.hcm": "Ho Chi Minh City",
  "sai gon": "Ho Chi Minh City",
  "sài gòn": "Ho Chi Minh City",
  saigon: "Ho Chi Minh City",
  hn: "Hà Nội",
  "ha noi": "Hà Nội",
  dn: "Đà Nẵng",
  "da nang": "Đà Nẵng",
});

function normalizeLocationQuery(location) {
  const trimmed = String(location || "").trim();
  if (!trimmed) return "";
  const key = trimmed.toLowerCase().replace(/\s+/g, " ");
  return CITY_QUERY_ALIASES[key] || trimmed;
}

async function fetchOpenMeteoJson(url, cacheKey) {
  const cached = openMeteoCache.get(cacheKey);
  if (cached) return cached;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "HHH-MyBot-Weather/3.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`Open-Meteo HTTP ${res.status}`);
  }
  const data = await res.json();
  openMeteoCache.set(cacheKey, data);
  return data;
}

// Khóa API được đọc từ weather.js và truyền vào bên dưới để giữ khớp contract
// credentials test (weather.js phải tham chiếu process.env.*).

// ── Geocoding ────────────────────────────────────────────────────────────────
export async function geocodeWeatherLocation(location) {
  const normalizedQuery = normalizeLocationQuery(location);
  if (!normalizedQuery) return null;
  const geoData = await fetchJsonWithCache(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(normalizedQuery)}&count=1&language=vi&format=json`,
    { provider: "weather-geocode", ttlMs: 24 * 60 * 60 * 1000, timeoutMs: 8000, retries: 1 },
  );
  if (!geoData?.results || geoData.results.length === 0) return null;
  const r = geoData.results[0];
  return {
    latitude: r.latitude,
    longitude: r.longitude,
    name: r.name,
    admin1: r.admin1 || "",
    country: r.country || "",
    timezone: r.timezone || "Asia/Ho_Chi_Minh",
  };
}

// ── Raw fetchers (mỗi provider một hàm, độc lập để test fallback) ────────────
export async function fetchTomorrowWeather(lat, lon, apiKey) {
  if (!apiKey) return null;
  return fetchJsonWithCache(
    `https://api.tomorrow.io/v4/weather/forecast?location=${lat},${lon}&apikey=${apiKey}&timesteps=1d,1h&units=metric`,
    { provider: "weather-tomorrow", ttlMs: 10 * 60 * 1000, timeoutMs: 12000, retries: 1 },
  );
}

export async function fetchOpenWeatherData(lat, lon, apiKey) {
  if (!apiKey) return null;
  return fetchJsonWithCache(
    `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=vi`,
    { provider: "weather-openweather", ttlMs: 10 * 60 * 1000, timeoutMs: 12000, retries: 1 },
  );
}

export async function fetchWeatherApiData(lat, lon, apiKey) {
  if (!apiKey) return null;
  return fetchJsonWithCache(
    `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=3&aqi=yes&lang=vi`,
    { provider: "weather-weatherapi", ttlMs: 10 * 60 * 1000, timeoutMs: 8000, retries: 1 },
  );
}

export async function fetchOpenMeteo(lat, lon, timezone = "Asia/Ho_Chi_Minh") {
  const tz = timezone || "Asia/Ho_Chi_Minh";
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    `&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m` +
    `&hourly=temperature_2m,precipitation_probability,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset` +
    `&wind_speed_unit=ms&timezone=${encodeURIComponent(tz)}&forecast_days=7`;
  return fetchOpenMeteoJson(url, `forecast:${lat}:${lon}:${tz}`);
}

export async function fetchOpenMeteoAirQuality(lat, lon) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    `&current=us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,sulphur_dioxide,ozone`;
  return fetchOpenMeteoJson(url, `air:${lat}:${lon}`);
}

// ── Chuẩn hóa từng provider về model phân loại canonical ─────────────────────
const CONCEPT_LABELS = {
  clear: "Trời quang",
  "partly-cloudy": "Có mây rải rác",
  cloudy: "Có mây",
  overcast: "Nhiều mây",
  fog: "Sương mù",
  drizzle: "Mưa phùn",
  rain: "Mưa",
  "heavy-rain": "Mưa to",
  showers: "Mưa rào",
  snow: "Tuyết",
  sleet: "Mưa tuyết",
  hail: "Mưa đá",
  thunderstorm: "Giông bão",
  unknown: "Không xác định",
};

export function describeConcept(concept) {
  return CONCEPT_LABELS[concept] || CONCEPT_LABELS.unknown;
}

// Mapping weather code của Tomorrow.io → concept
export function conceptFromTomorrowCode(code) {
  const map = {
    1000: "clear",
    1100: "partly-cloudy",
    1101: "cloudy",
    1102: "overcast",
    1001: "overcast",
    2000: "fog",
    2100: "fog",
    3000: "cloudy",
    3001: "cloudy",
    4000: "drizzle",
    4001: "rain",
    4200: "showers",
    4201: "rain",
    4202: "heavy-rain",
    5000: "snow",
    5001: "snow",
    5100: "sleet",
    6000: "hail",
    6200: "hail",
    6201: "hail",
    7000: "thunderstorm",
    7101: "thunderstorm",
    7102: "thunderstorm",
    8000: "showers",
  };
  return map[code] || "unknown";
}

// Mapping weather code của OpenWeather → concept
export function conceptFromOpenWeatherCode(code) {
  const n = Number(code);
  if (Number.isNaN(n)) return "unknown";
  if (n >= 200 && n < 300) return "thunderstorm";
  if (n >= 300 && n < 400) return "drizzle";
  if (n >= 500 && n < 600) {
    if (n === 511) return "sleet";
    if (n === 502 || n === 503 || n === 504) return "heavy-rain";
    if (n >= 520 && n <= 531) return "showers";
    return "rain";
  }
  if (n >= 600 && n < 700) return n === 611 ? "sleet" : "snow";
  if (n >= 700 && n < 800) return "fog";
  if (n === 800) return "clear";
  if (n === 801) return "partly-cloudy";
  if (n === 802) return "cloudy";
  if (n === 803 || n === 804) return "overcast";
  return "unknown";
}

// Mapping weather code của WeatherAPI → concept (dựa trên text khi code lạ)
export function conceptFromWeatherApiCode(code, text = "") {
  const n = Number(code);
  if (!Number.isNaN(n)) {
    if (n === 1000) return "clear";
    if (n === 1003) return "partly-cloudy";
    if (n === 1006) return "cloudy";
    if (n === 1009) return "overcast";
    if (n === 1030 || n === 1135 || n === 1147) return "fog";
    if (n >= 1063 && n <= 1087) return n === 1087 ? "thunderstorm" : "rain";
    if (n >= 1150 && n <= 1192) return "rain";
    if (n === 1195 || n === 1201) return "heavy-rain";
    if (n >= 1210 && n <= 1258) return "snow";
    if (n >= 1273 && n <= 1282) return "thunderstorm";
  }
  if (/snow/i.test(text)) return "snow";
  if (/thunder|storm/i.test(text)) return "thunderstorm";
  if (/driz/i.test(text)) return "drizzle";
  if (/rain shower/i.test(text)) return "showers";
  if (/rain|shower/i.test(text)) return "rain";
  if (/fog|mist|haze/i.test(text)) return "fog";
  if (/overcast/i.test(text)) return "overcast";
  if (/cloud/i.test(text)) return "cloudy";
  if (/sun|clear/i.test(text)) return "clear";
  return "unknown";
}

// Mapping WMO weather code của Open-Meteo → concept canonical
export function conceptFromWmoCode(code) {
  const n = Number(code);
  if (Number.isNaN(n)) return "unknown";
  if (n === 0) return "clear";
  if (n === 1) return "partly-cloudy";
  if (n === 2) return "cloudy";
  if (n === 3) return "overcast";
  if (n === 45 || n === 48) return "fog";
  if (n >= 51 && n <= 57) return "drizzle";
  if (n === 61 || n === 63 || n === 66) return "rain";
  if (n === 65 || n === 67 || n === 82) return "heavy-rain";
  if ((n >= 71 && n <= 77) || n === 85 || n === 86) return "snow";
  if (n === 80 || n === 81) return "showers";
  if (n === 95 || n === 96 || n === 99) return "thunderstorm";
  return "unknown";
}

function formatClockFromIso(isoStr) {
  if (!isoStr || typeof isoStr !== "string") return null;
  const parts = isoStr.split("T");
  return parts.length > 1 ? parts[1].slice(0, 5) : isoStr;
}

export function normalizeOpenMeteoCurrent(raw) {
  const c = raw?.current;
  if (!c || c.temperature_2m == null) return null;
  const concept = conceptFromWmoCode(c.weather_code);
  const isKmh = raw?.current_units?.wind_speed_10m === "km/h";
  const rawWind = Number(c.wind_speed_10m ?? 0);
  return {
    source: "openmeteo",
    updatedAt: c.time || new Date().toISOString(),
    temp: c.temperature_2m,
    feelsLike: c.apparent_temperature ?? c.temperature_2m,
    tempMin: raw?.daily?.temperature_2m_min?.[0] ?? c.temperature_2m,
    tempMax: raw?.daily?.temperature_2m_max?.[0] ?? c.temperature_2m,
    humidity: c.relative_humidity_2m ?? 0,
    windSpeed: isKmh ? Number((rawWind / 3.6).toFixed(1)) : rawWind,
    windDeg: c.wind_direction_10m ?? 0,
    cloud: c.cloud_cover ?? 0,
    visibilityKm: 10,
    concept,
    description: describeConcept(concept),
  };
}

export function normalizeOpenMeteoHourly(raw) {
  const h = raw?.hourly;
  const times = Array.isArray(h?.time) ? h.time : [];
  if (times.length === 0) return [];
  const temps = h.temperature_2m || [];
  const probs = h.precipitation_probability || [];
  const codes = h.weather_code || [];

  const currentIso = String(raw?.current?.time || "");
  let startIdx = 0;
  if (currentIso) {
    const idx = times.findIndex((t) => String(t) >= currentIso);
    if (idx >= 0) startIdx = idx;
  }

  return times.slice(startIdx, startIdx + 7).map((time, offset) => {
    const i = startIdx + offset;
    return {
      time,
      temp: temps[i] ?? null,
      precipProb: probs[i] ?? 0,
      concept: conceptFromWmoCode(codes[i]),
    };
  });
}

export function normalizeOpenMeteoDaily(raw) {
  const d = raw?.daily;
  const dates = Array.isArray(d?.time) ? d.time : [];
  if (dates.length === 0) return [];
  const maxTemps = d.temperature_2m_max || [];
  const minTemps = d.temperature_2m_min || [];
  const codes = d.weather_code || [];
  const sunrises = d.sunrise || [];
  const sunsets = d.sunset || [];

  return dates.slice(0, 6).map((date, i) => ({
    date,
    tempMax: maxTemps[i] ?? null,
    tempMin: minTemps[i] ?? null,
    concept: conceptFromWmoCode(codes[i]),
    sunrise: formatClockFromIso(sunrises[i]),
    sunset: formatClockFromIso(sunsets[i]),
  }));
}

export function normalizeOpenMeteoAirQuality(raw) {
  const c = raw?.current;
  if (!c) return null;
  const aqi = c.us_aqi ?? null;
  if (aqi == null && c.pm2_5 == null && c.pm10 == null) return null;
  const roundedAqi = aqi != null ? Math.round(Number(aqi)) : null;
  return {
    usEpaIndex: roundedAqi,
    isDefault: roundedAqi == null,
    pollutants: {
      pm25: c.pm2_5 != null ? Math.round(Number(c.pm2_5)) : null,
      pm10: c.pm10 != null ? Math.round(Number(c.pm10)) : null,
      o3: c.ozone != null ? Math.round(Number(c.ozone)) : null,
      no2: c.nitrogen_dioxide != null ? Math.round(Number(c.nitrogen_dioxide)) : null,
      so2: c.sulphur_dioxide != null ? Math.round(Number(c.sulphur_dioxide)) : null,
      co: c.carbon_monoxide != null ? Number(Number(c.carbon_monoxide).toFixed(1)) : null,
    },
    level: describeAqiLevel(roundedAqi),
  };
}

// Giữ tương thích contract cũ: đầu ra của normalizeWeatherApiCurrent giữ nguyên.
export function normalizeWeatherApiCurrent(weatherApiData) {
  const current = weatherApiData?.current;
  if (!current) return null;

  const timestamp = Date.parse(current.last_updated || "");
  return {
    dt: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : Math.floor(Date.now() / 1000),
    weather: [{
      description: current.condition?.text || "Unknown",
      icon: current.condition?.icon || "",
    }],
    main: {
      temp: current.temp_c,
      feels_like: current.feelslike_c,
      temp_min: current.temp_c,
      temp_max: current.temp_c,
      humidity: current.humidity,
    },
    wind: { speed: Number(current.wind_kph || 0) / 3.6 },
    clouds: { all: current.cloud || 0 },
    visibility: Number(current.vis_km || 0) * 1000,
    rain: {},
  };
}

export function normalizeOpenWeatherCurrent(raw) {
  const main = raw?.main;
  const weather = raw?.weather?.[0];
  if (!main || !weather) return null;
  return {
    source: "openweather",
    updatedAt: new Date((raw.dt || Date.now() / 1000) * 1000).toISOString(),
    temp: main.temp,
    feelsLike: main.feels_like,
    tempMin: main.temp_min,
    tempMax: main.temp_max,
    humidity: main.humidity,
    windSpeed: raw.wind?.speed ?? 0,
    windDeg: raw.wind?.deg ?? 0,
    cloud: raw.clouds?.all ?? 0,
    visibilityKm: raw.visibility != null ? raw.visibility / 1000 : null,
    concept: conceptFromOpenWeatherCode(weather.id),
    description: weather.description || describeConcept(conceptFromOpenWeatherCode(weather.id)),
  };
}

export function normalizeWeatherApiCurrentModel(raw) {
  const current = raw?.current;
  if (!current) return null;
  return {
    source: "weatherapi",
    updatedAt: current.last_updated || new Date().toISOString(),
    temp: current.temp_c,
    feelsLike: current.feelslike_c,
    tempMin: current.temp_c,
    tempMax: current.temp_c,
    humidity: current.humidity,
    windSpeed: Number(current.wind_kph || 0) / 3.6,
    windDeg: current.wind_degree ?? 0,
    cloud: current.cloud ?? 0,
    visibilityKm: current.vis_km ?? null,
    concept: conceptFromWeatherApiCode(current.condition?.code, current.condition?.text),
    description: current.condition?.text || describeConcept(conceptFromWeatherApiCode(current.condition?.code, current.condition?.text)),
  };
}

export function normalizeTomorrowHourly(raw) {
  const timelines = raw?.data?.timelines || raw?.timelines;
  return (timelines?.hourly || []).slice(0, 7).map((h) => {
    const v = h.values || {};
    return {
      time: h.time,
      temp: v.temperature,
      precipProb: v.precipitationProbability,
      concept: conceptFromTomorrowCode(v.weatherCode),
    };
  });
}

export function normalizeTomorrowDaily(raw) {
  const timelines = raw?.data?.timelines || raw?.timelines;
  return (timelines?.daily || []).slice(0, 6).map((d) => {
    const v = d.values || {};
    return {
      date: d.time,
      tempMax: v.temperatureMax,
      tempMin: v.temperatureMin,
      concept: conceptFromTomorrowCode(v.weatherCodeMax),
      sunrise: v.sunriseTime || null,
      sunset: v.sunsetTime || null,
    };
  });
}

export function normalizeWeatherApiDaily(raw) {
  return (raw?.forecast?.forecastday || []).slice(0, 6).map((d) => ({
    date: d.date,
    day: d?.day,
    tempMax: d?.day?.maxtemp_c ?? null,
    tempMin: d?.day?.mintemp_c ?? null,
    concept: conceptFromWeatherApiCode(d?.day?.condition?.code, d?.day?.condition?.text),
    sunrise: d?.astro?.sunrise || null,
    sunset: d?.astro?.sunset || null,
  }));
}

export function normalizeAirQuality(raw) {
  const aq = raw?.current?.air_quality;
  if (!aq) return null;
  const pm25 = aq.pm2_5;
  const pm10 = aq.pm10;
  return {
    usEpaIndex: aq["us-epa-index"] ?? null,
    isDefault: aq["us-epa-index"] == null,
    pollutants: {
      pm25: pm25 != null ? Math.round(pm25) : null,
      pm10: pm10 != null ? Math.round(pm10) : null,
      o3: aq.o3 != null ? Math.round(aq.o3) : null,
      no2: aq.no2 != null ? Math.round(aq.no2) : null,
      so2: aq.so2 != null ? Math.round(aq.so2) : null,
      co: aq.co != null ? Number(aq.co.toFixed(1)) : null,
    },
    level: describeAqiLevel(aq["us-epa-index"]),
  };
}

export function describeAqiLevel(index) {
  if (index == null || Number.isNaN(index)) return { label: "Không có dữ liệu", color: "#8aa0b6" };
  if (index <= 50) return { label: "Tốt", color: "#22c55e" };
  if (index <= 100) return { label: "Trung bình", color: "#eab308" };
  if (index <= 150) return { label: "Kém (nhạy cảm)", color: "#f97316" };
  if (index <= 200) return { label: "Không lành mạnh", color: "#ef4444" };
  if (index <= 300) return { label: "Rất không lành mạnh", color: "#a855f7" };
  return { label: "Nguy hiểm", color: "#7f1d1d" };
}

// ── Orchestration: lấy song song + hợp nhất về model thống nhất ──────────────
export async function buildWeatherModel(geo, apiKeys, fetchers) {
  const { latitude, longitude } = geo;
  const timezone = geo.timezone || "Asia/Ho_Chi_Minh";
  const hasCustomFetchers = Boolean(fetchers && typeof fetchers === "object" && Object.keys(fetchers).length > 0);

  const defaultFetchers = {
    tomorrow: (lat, lon, key) => fetchTomorrowWeather(lat, lon, key),
    openweather: (lat, lon, key) => fetchOpenWeatherData(lat, lon, key),
    weatherapi: (lat, lon, key) => fetchWeatherApiData(lat, lon, key),
    openmeteo: (lat, lon, tz) => fetchOpenMeteo(lat, lon, tz),
    openmeteoAir: (lat, lon) => fetchOpenMeteoAirQuality(lat, lon),
  };

  const fetchTomorrow = fetchers?.tomorrow || defaultFetchers.tomorrow;
  const fetchOpen = fetchers?.openweather || defaultFetchers.openweather;
  const fetchWeatherApi = fetchers?.weatherapi || defaultFetchers.weatherapi;
  const fetchOpenMeteoFn = fetchers?.openmeteo || (hasCustomFetchers ? async () => null : defaultFetchers.openmeteo);
  const fetchOpenMeteoAirFn = fetchers?.openmeteoAir || (hasCustomFetchers ? async () => null : defaultFetchers.openmeteoAir);

  const results = await Promise.allSettled([
    fetchTomorrow(latitude, longitude, apiKeys?.tomorrow),
    fetchOpen(latitude, longitude, apiKeys?.openweather),
    fetchWeatherApi(latitude, longitude, apiKeys?.weatherapi),
    fetchOpenMeteoFn(latitude, longitude, timezone),
    fetchOpenMeteoAirFn(latitude, longitude),
  ]);

  const [tomorrowResult, openWeatherResult, weatherApiResult, openMeteoResult, openMeteoAirResult] = results;

  const tomorrowRaw = tomorrowResult?.status === "fulfilled" ? tomorrowResult.value : null;
  const openWeatherRaw = openWeatherResult?.status === "fulfilled" ? openWeatherResult.value : null;
  const weatherApiRaw = weatherApiResult?.status === "fulfilled" ? weatherApiResult.value : null;
  const openMeteoRaw = openMeteoResult?.status === "fulfilled" ? openMeteoResult.value : null;
  const openMeteoAirRaw = openMeteoAirResult?.status === "fulfilled" ? openMeteoAirResult.value : null;

  const current =
    normalizeOpenWeatherCurrent(openWeatherRaw) ||
    normalizeWeatherApiCurrentModel(weatherApiRaw) ||
    normalizeOpenMeteoCurrent(openMeteoRaw);
  if (!current) {
    throw new Error("Không có provider thời tiết khả dụng cho dữ liệu hiện tại.");
  }

  const tomorrowHourly = normalizeTomorrowHourly(tomorrowRaw);
  const openMeteoHourly = normalizeOpenMeteoHourly(openMeteoRaw);
  const hourly = tomorrowHourly.length > 0 ? tomorrowHourly : openMeteoHourly;

  const tomorrowDaily = normalizeTomorrowDaily(tomorrowRaw);
  const weatherApiDaily = normalizeWeatherApiDaily(weatherApiRaw);
  const openMeteoDaily = normalizeOpenMeteoDaily(openMeteoRaw);

  // Dự báo 6 ngày ưu tiên Tomorrow.io -> WeatherAPI -> Open-Meteo (bổ sung đủ 6 ngày).
  let daily = tomorrowDaily;
  for (const fallbackDaily of [weatherApiDaily, openMeteoDaily]) {
    if (daily.length === 0) {
      daily = fallbackDaily;
    } else if (daily.length < 6 && fallbackDaily.length > 0) {
      const merged = [...daily];
      for (const item of fallbackDaily) {
        if (merged.length >= 6) break;
        if (!merged.some((d) => d.date === item.date)) merged.push(item);
      }
      daily = merged.slice(0, 6);
    }
  }

  let astronomy = { sunrise: null, sunset: null };
  const primaryAstro =
    (tomorrowDaily[0]?.sunrise || tomorrowDaily[0]?.sunset ? tomorrowDaily[0] : null) ||
    (weatherApiDaily[0]?.sunrise || weatherApiDaily[0]?.sunset ? weatherApiDaily[0] : null) ||
    (openMeteoDaily[0]?.sunrise || openMeteoDaily[0]?.sunset ? openMeteoDaily[0] : null);
  if (primaryAstro) {
    astronomy = { sunrise: primaryAstro.sunrise || null, sunset: primaryAstro.sunset || null };
  }

  const airQuality = normalizeAirQuality(weatherApiRaw) || normalizeOpenMeteoAirQuality(openMeteoAirRaw);

  return {
    location: {
      name: geo.name,
      admin1: geo.admin1,
      country: geo.country,
      latitude,
      longitude,
      timezone,
    },
    updatedAt: current.updatedAt || new Date().toISOString(),
    current,
    hourly,
    daily,
    airQuality,
    astronomy,
  };
}
