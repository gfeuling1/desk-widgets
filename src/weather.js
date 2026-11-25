// Gets the weather from Open-Meteo, or from the National Weather Service
// if Open-Meteo is down. Both are turned into the same shape:
//   { current: { temp, feels, humidity, wind, desc },
//     days: [{ date: "2026-11-24", desc, hi, lo }, ...] }
// Any value a service doesn't provide is null.

const { fetch: tauriFetch } = window.__TAURI__.http;

// Weather code meanings from Open-Meteo's documentation.
const WEATHER_CODES = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Freezing rain", 67: "Freezing rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
  85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm, hail", 97: "Heavy thunderstorm", 99: "Thunderstorm, hail",
};

const DAYS = 4;

async function getJson(url, headers = {}) {
  const res = await tauriFetch(url, { headers, connectTimeout: 8000 });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

async function fromOpenMeteo(cfg) {
  const params = new URLSearchParams({
    latitude: cfg.latitude,
    longitude: cfg.longitude,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
    temperature_unit: cfg.temperatureUnit,
    wind_speed_unit: cfg.windUnit,
    timezone: "auto",
    forecast_days: DAYS,
  });
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const c = data.current, d = data.daily;
  return {
    current: {
      temp: c.temperature_2m,
      feels: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind: c.wind_speed_10m,
      desc: WEATHER_CODES[c.weather_code] ?? "Unknown",
    },
    days: d.time.map((date, i) => ({
      date,
      desc: WEATHER_CODES[d.weather_code[i]] ?? "",
      hi: d.temperature_2m_max[i],
      lo: d.temperature_2m_min[i],
    })),
  };
}

// The National Weather Service only covers the US, and asks every app to
// identify itself with a User-Agent.
async function fromNws(cfg) {
  const headers = { "User-Agent": "DeskWidgets (github.com/gfeuling1/desk-widgets)", Accept: "application/geo+json" };
  const lat = Number(cfg.latitude).toFixed(4), lon = Number(cfg.longitude).toFixed(4);
  const point = (await getJson(`https://api.weather.gov/points/${lat},${lon}`, headers)).properties;
  const [hourly, daily] = await Promise.all([
    getJson(point.forecastHourly, headers),
    getJson(point.forecast, headers),
  ]);

  const celsius = cfg.temperatureUnit === "celsius";
  const temp = (f) => (f == null ? null : celsius ? ((f - 32) * 5) / 9 : f);
  // Wind comes as text like "5 to 10 mph", so take the larger number.
  const wind = (text) => {
    const nums = String(text ?? "").match(/\d+/g);
    if (!nums) return null;
    const mph = Math.max(...nums.map(Number));
    return cfg.windUnit === "kmh" ? mph * 1.609 : mph;
  };

  const now = hourly.properties.periods[0];
  const byDate = new Map();
  for (const p of daily.properties.periods) {
    const date = p.startTime.slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, { date, desc: "", hi: null, lo: null });
    const day = byDate.get(date);
    if (p.isDaytime) { day.hi = temp(p.temperature); day.desc = p.shortForecast; }
    else { day.lo = temp(p.temperature); day.desc ||= p.shortForecast; }
  }

  return {
    current: {
      temp: temp(now.temperature),
      feels: null,
      humidity: now.relativeHumidity?.value ?? null,
      wind: wind(now.windSpeed),
      desc: now.shortForecast,
    },
    days: [...byDate.values()].slice(0, DAYS),
  };
}

export async function getWeather(cfg) {
  try {
    return { data: await fromOpenMeteo(cfg), source: "Open-Meteo" };
  } catch (err) {
    console.warn("Open-Meteo failed, trying the National Weather Service:", err);
  }
  return { data: await fromNws(cfg), source: "National Weather Service" };
}
