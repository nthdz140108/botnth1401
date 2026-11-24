import { fetchJsonWithCache } from "../../../utils/public-api-cache.js";

// Khóa API được đọc từ weather.js và truyền vào bên dưới để giữ khớp contract
// credentials test (weather.js phải tham chiếu process.env.*).

// ── Geocoding ────────────────────────────────────────────────────────────────
export async function geocodeWeatherLocation(location) {
  const geoData = await fetchJsonWithCache(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=vi&format=json`,
    { provider: "weather-geocode", ttlMs: 24 * 60 * 60 * 1000, timeoutMs: 10000, retries: 1 },
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
    `http://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${lat},${lon}&days=3&aqi=yes&lang=vi`,
    { provider: "weather-weatherapi", ttlMs: 10 * 60 * 1000, timeoutMs: 12000, retries: 1 },
  );
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
export async function buildWeatherModel(geo, apiKeys, fetchers = {}) {
  const { latitude, longitude } = geo;
  const fetchTomorrow = fetchers.tomorrow || ((lat, lon, key) => fetchTomorrowWeather(lat, lon, key));
  const fetchOpen = fetchers.openweather || ((lat, lon, key) => fetchOpenWeatherData(lat, lon, key));
  const fetchWeatherApi = fetchers.weatherapi || ((lat, lon, key) => fetchWeatherApiData(lat, lon, key));

  const results = await Promise.allSettled([
    fetchTomorrow(latitude, longitude, apiKeys?.tomorrow),
    fetchOpen(latitude, longitude, apiKeys?.openweather),
    fetchWeatherApi(latitude, longitude, apiKeys?.weatherapi),
  ]);

  const [tomorrowResult, openWeatherResult, weatherApiResult] = results;

  const tomorrowRaw = tomorrowResult?.status === "fulfilled" ? tomorrowResult.value : null;
  const openWeatherRaw = openWeatherResult?.status === "fulfilled" ? openWeatherResult.value : null;
  const weatherApiRaw = weatherApiResult?.status === "fulfilled" ? weatherApiResult.value : null;

  const current = normalizeOpenWeatherCurrent(openWeatherRaw) || normalizeWeatherApiCurrentModel(weatherApiRaw);
  if (!current) {
    throw new Error("Không có provider thời tiết khả dụng cho dữ liệu hiện tại.");
  }

  const tomorrowHourly = normalizeTomorrowHourly(tomorrowRaw);
  const tomorrowDaily = normalizeTomorrowDaily(tomorrowRaw);
  const weatherApiDaily = normalizeWeatherApiDaily(weatherApiRaw);

  // Dự báo 6 ngày ưu tiên Tomorrow.io; bổ sung từ WeatherAPI khi còn thiếu.
  let daily = tomorrowDaily;
  if (daily.length === 0) daily = weatherApiDaily;
  else if (daily.length < 6) {
    const merged = [...daily];
    for (const item of weatherApiDaily) {
      if (merged.length >= 6) break;
      if (!merged.some((d) => d.date === item.date)) merged.push(item);
    }
    daily = merged.slice(0, 6);
  }

  let astronomy = { sunrise: null, sunset: null };
  const tomorrowSunrise = tomorrowDaily[0]?.sunrise;
  const tomorrowSunset = tomorrowDaily[0]?.sunset;
  if (tomorrowSunrise || tomorrowSunset) {
    astronomy = { sunrise: tomorrowSunrise || null, sunset: tomorrowSunset || null };
  } else {
    const astro = weatherApiDaily[0];
    astronomy = { sunrise: astro?.sunrise || null, sunset: astro?.sunset || null };
  }

  return {
    location: {
      name: geo.name,
      admin1: geo.admin1,
      country: geo.country,
      latitude,
      longitude,
      timezone: geo.timezone || "Asia/Ho_Chi_Minh",
    },
    updatedAt: current.updatedAt || new Date().toISOString(),
    current,
    hourly: tomorrowHourly,
    daily,
    airQuality: normalizeAirQuality(weatherApiRaw),
    astronomy,
  };
}
