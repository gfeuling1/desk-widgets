import { upcomingEvents } from "./calendar.js";

const { load } = window.__TAURI__.store;
const { fetch: tauriFetch } = window.__TAURI__.http;

// Private calendar links live in config.local.js, which is never committed.
let CALENDARS = [];
try {
  ({ CALENDARS } = await import("./config.local.js"));
} catch {
  console.warn("No src/config.local.js found, so the calendar widget is empty.");
}

const GRID = 10;          // widgets snap to a 10px grid
const MIN_W = 120;
const MIN_H = 60;

// Your personal settings. Change these to match where you live.
const SETTINGS = {
  weather: {
    place: "Lakewood, CO",
    latitude: 39.7047,
    longitude: -105.0814,
    temperatureUnit: "fahrenheit", // or "celsius"
    windUnit: "mph",               // or "kmh"
    refreshMinutes: 15,
  },
  calendar: {
    daysAhead: 7,
    maxEvents: 8,
    refreshMinutes: 10,
  },
};

// Every widget that should exist. New ones get added to your saved layout automatically.
const DEFAULT_LAYOUT = [
  { id: "clock-1", type: "clock", x: 60, y: 60, w: 340, h: 140 },
  { id: "weather-1", type: "weather", x: 60, y: 220, w: 340, h: 230 },
  { id: "calendar-1", type: "calendar", x: 60, y: 470, w: 340, h: 300 },
];

// Makes text from outside sources safe to put into the page.
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

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

// Each widget type builds its content inside the element it's given.
// If it starts a timer, it returns a function that stops it.
const widgetTypes = {
  clock(el) {
    el.innerHTML = `<div class="clock-time"></div><div class="clock-date"></div>`;
    const time = el.querySelector(".clock-time");
    const date = el.querySelector(".clock-date");
    const tick = () => {
      const now = new Date();
      time.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      date.textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  },

  weather(el) {
    const cfg = SETTINGS.weather;
    const unit = cfg.temperatureUnit === "celsius" ? "C" : "F";
    el.innerHTML = `
      <div class="wx-place">${cfg.place}</div>
      <div class="wx-now">
        <div class="wx-temp">--°</div>
        <div>
          <div class="wx-desc">Loading...</div>
          <div class="wx-meta"></div>
        </div>
      </div>
      <div class="wx-days"></div>`;
    const temp = el.querySelector(".wx-temp");
    const desc = el.querySelector(".wx-desc");
    const meta = el.querySelector(".wx-meta");
    const days = el.querySelector(".wx-days");

    async function update() {
      try {
        const params = new URLSearchParams({
          latitude: cfg.latitude,
          longitude: cfg.longitude,
          current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code",
          daily: "weather_code,temperature_2m_max,temperature_2m_min",
          temperature_unit: cfg.temperatureUnit,
          wind_speed_unit: cfg.windUnit,
          timezone: "auto",
          forecast_days: 4,
        });
        const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!res.ok) throw new Error(`Weather request failed: ${res.status}`);
        const data = await res.json();

        const c = data.current;
        temp.textContent = `${Math.round(c.temperature_2m)}°${unit}`;
        desc.textContent = WEATHER_CODES[c.weather_code] ?? "Unknown";
        meta.textContent =
          `Feels ${Math.round(c.apparent_temperature)}° · ${c.relative_humidity_2m}% humidity · ` +
          `${Math.round(c.wind_speed_10m)} ${cfg.windUnit}`;

        const d = data.daily;
        days.innerHTML = d.time.map((day, i) => {
          const label = i === 0 ? "Today"
            : new Date(day + "T00:00").toLocaleDateString([], { weekday: "short" });
          return `
            <div class="wx-day">
              <div class="wx-day-name">${label}</div>
              <div class="wx-day-desc">${WEATHER_CODES[d.weather_code[i]] ?? ""}</div>
              <div class="wx-day-temps">${Math.round(d.temperature_2m_max[i])}° / ${Math.round(d.temperature_2m_min[i])}°</div>
            </div>`;
        }).join("");
      } catch (err) {
        console.error(err);
        desc.textContent = "Weather unavailable";
      }
    }

    update();
    const timer = setInterval(update, cfg.refreshMinutes * 60 * 1000);
    return () => clearInterval(timer);
  },
    calendar(el) {
    const cfg = SETTINGS.calendar;
    el.innerHTML = `<div class="cal-header">Upcoming</div><div class="cal-list">Loading...</div>`;
    const list = el.querySelector(".cal-list");

    if (CALENDARS.length === 0) {
      list.textContent = "Add a calendar link in src/config.local.js";
      return;
    }

    function dayLabel(date) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const day = new Date(date); day.setHours(0, 0, 0, 0);
      const diff = Math.round((day - today) / 86400000);
      if (diff <= 0) return "Today";
      if (diff === 1) return "Tomorrow";
      return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    }

    function show(events) {
      if (events.length === 0) {
        list.textContent = "Nothing coming up";
        return;
      }
      const now = new Date();
      let html = "";
      let lastDay = "";
      for (const ev of events) {
        const day = dayLabel(ev.start);
        if (day !== lastDay) {
          html += `<div class="cal-day">${day}</div>`;
          lastDay = day;
        }
        const time = ev.allDay ? "All day"
          : ev.start <= now ? "Now"
          : ev.start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        html += `
          <div class="cal-event">
            <span class="cal-dot" style="background:${escapeHtml(ev.color)}"></span>
            <span class="cal-time">${time}</span>
            <span class="cal-title">${escapeHtml(ev.title)}</span>
          </div>`;
      }
      list.innerHTML = html;
    }

    async function update() {
      try {
        const all = [];
        for (const cal of CALENDARS) {
          const res = await tauriFetch(cal.url);
          if (!res.ok) throw new Error(`${cal.name} calendar failed: ${res.status}`);
          all.push(...upcomingEvents(await res.text(), cal.name, cal.color, cfg.daysAhead));
        }
        all.sort((a, b) => a.start - b.start);
        show(all.slice(0, cfg.maxEvents));
      } catch (err) {
        console.error(err);
        list.textContent = "Calendar unavailable";
      }
    }

    update();
    const timer = setInterval(update, cfg.refreshMinutes * 60 * 1000);
    return () => clearInterval(timer);
  },
};

// ---------- Saving and loading ----------
const store = await load("layout.json", { autoSave: 300 });
let layout = (await store.get("widgets")) ?? [];

// Add any default widgets missing from the saved layout, and drop unknown ones.
for (const def of DEFAULT_LAYOUT) {
  if (!layout.some((w) => w.id === def.id)) layout.push(structuredClone(def));
}
layout = layout.filter((w) => widgetTypes[w.type]);

async function saveLayout() {
  await store.set("widgets", layout);
}

// ---------- Helpers ----------
const snap = (n) => Math.round(n / GRID) * GRID;
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));

function applyBox(el, item) {
  el.style.left = item.x + "px";
  el.style.top = item.y + "px";
  el.style.width = item.w + "px";
  el.style.height = item.h + "px";
}

// Follows the mouse after a press until it's released.
function trackPointer(target, startEvent, onMove, onEnd) {
  target.setPointerCapture(startEvent.pointerId);
  const move = (e) => onMove(e.clientX - startEvent.clientX, e.clientY - startEvent.clientY);
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    onEnd();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
}

// ---------- Building the desktop ----------
const desktop = document.getElementById("desktop");
let editMode = false;
let cleanups = [];

function render() {
  cleanups.forEach((stop) => stop());
  cleanups = [];
  desktop.innerHTML = "";
  for (const item of layout) {
    const el = document.createElement("div");
    el.className = "widget";
    applyBox(el, item);

    const content = document.createElement("div");
    content.className = "widget-content";
    el.appendChild(content);

    const handle = document.createElement("div");
    handle.className = "resize-handle";
    el.appendChild(handle);

    desktop.appendChild(el);
    const stop = widgetTypes[item.type](content);
    if (typeof stop === "function") cleanups.push(stop);

    // Drag to move
    el.addEventListener("pointerdown", (e) => {
      if (!editMode || e.target === handle) return;
      e.preventDefault();
      const startX = item.x, startY = item.y;
      trackPointer(el, e, (dx, dy) => {
        item.x = clamp(snap(startX + dx), 0, window.innerWidth - item.w);
        item.y = clamp(snap(startY + dy), 0, window.innerHeight - item.h);
        applyBox(el, item);
      }, saveLayout);
    });

    // Drag the corner to resize
    handle.addEventListener("pointerdown", (e) => {
      if (!editMode) return;
      e.preventDefault();
      e.stopPropagation();
      const startW = item.w, startH = item.h;
      trackPointer(handle, e, (dx, dy) => {
        item.w = clamp(snap(startW + dx), MIN_W, window.innerWidth - item.x);
        item.h = clamp(snap(startH + dy), MIN_H, window.innerHeight - item.y);
        applyBox(el, item);
      }, saveLayout);
    });
  }
}

// ---------- Edit mode ----------
function setEditMode(on) {
  editMode = on;
  document.body.classList.toggle("editing", on);
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "e") {
    e.preventDefault();
    setEditMode(!editMode);
  }
});

document.getElementById("done-btn").addEventListener("click", () => setEditMode(false));
document.getElementById("reset-btn").addEventListener("click", async () => {
  layout = structuredClone(DEFAULT_LAYOUT);
  await saveLayout();
  render();
});

render();