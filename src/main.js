import { upcomingEvents } from "./calendar.js";
import { fenceWidget, listenForFileDrops, FENCE_COLORS, COLLAPSED_H } from "./fences.js";
import { loadSettings, openSettings } from "./settings.js";
import { getWeather } from "./weather.js";
import { notesWidget, countdownWidget, statsWidget } from "./widgets-extra.js";

const { load } = window.__TAURI__.store;
const { fetch: tauriFetch } = window.__TAURI__.http;

const GRID = 10;          // widgets snap to a 10px grid
const MIN_W = 120;
const MIN_H = 60;

// How often widgets refresh. Your location, units, and calendar links
// are in the Settings panel (tray menu > Settings), saved by settings.js.
const TIMING = {
  weather: {
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
  { id: "music-1", type: "music", x: 440, y: 60, w: 460, h: 220, view: "record" },
  { id: "fence-desktop", type: "fence", title: "Desktop", color: "#5aa9ff", folder: "Desktop",
    hideClaimed: true, sort: "name", x: 440, y: 300, w: 460, h: 320 },
  { id: "fence-downloads", type: "fence", title: "Downloads", color: "#b78cff", folder: "Downloads",
    sort: "newest", maxItems: 30, x: 920, y: 60, w: 340, h: 320 },
];

// Makes text from outside sources safe to put into the page.
const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

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
    const cfg = { ...settings.weather, ...TIMING.weather };
    const unit = cfg.temperatureUnit === "celsius" ? "C" : "F";
    el.innerHTML = `
      <div class="wx-place">${escapeHtml(cfg.place)}</div>
      <div class="wx-now">
        <div class="wx-temp">--°</div>
        <div>
          <div class="wx-desc">Loading...</div>
          <div class="wx-meta"></div>
        </div>
      </div>
      <div class="wx-days"></div>
      <div class="wx-status"></div>`;
    const temp = el.querySelector(".wx-temp");
    const desc = el.querySelector(".wx-desc");
    const meta = el.querySelector(".wx-meta");
    const days = el.querySelector(".wx-days");
    const status = el.querySelector(".wx-status");

    function minutesAgo(time) {
      const mins = Math.round((Date.now() - time) / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return `${mins} min ago`;
      return `${Math.round(mins / 60)} hr ago`;
    }

    const deg = (n) => (n == null ? "--" : `${Math.round(n)}°`);
    const windLabel = cfg.windUnit === "kmh" ? "km/h" : "mph";

    function show(data) {
      const c = data.current;
      temp.textContent = c.temp == null ? "--°" : `${Math.round(c.temp)}°${unit}`;
      desc.textContent = c.desc;
      meta.textContent = [
        c.feels != null && `Feels ${deg(c.feels)}`,
        c.humidity != null && `${Math.round(c.humidity)}% humidity`,
        c.wind != null && `${Math.round(c.wind)} ${windLabel}`,
      ].filter(Boolean).join(" · ");

      const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
      days.innerHTML = data.days.filter((d) => d.date >= today).map((d) => {
        const label = d.date === today ? "Today"
          : new Date(d.date + "T00:00").toLocaleDateString([], { weekday: "short" });
        return `
          <div class="wx-day">
            <div class="wx-day-name">${label}</div>
            <div class="wx-day-desc">${escapeHtml(d.desc)}</div>
            <div class="wx-day-temps">${deg(d.hi)} / ${deg(d.lo)}</div>
          </div>`;
      }).join("");
    }

    // Returns true if fresh weather loaded, false if it fell back to saved weather.
    async function update() {
      try {
        const { data, source } = await getWeather(cfg);
        show(data);
        // Only mention the source when it's the backup.
        status.textContent = source === "Open-Meteo" ? "" : `via ${source}`;
        await store.set("weatherCache", { version: 2, data, savedAt: Date.now() });
        return true;
      } catch (err) {
        console.error(err);
        const cached = await store.get("weatherCache");
        if (cached?.version === 2) {
          show(cached.data);
          status.textContent = `Offline · last updated ${minutesAgo(cached.savedAt)}`;
        } else {
          desc.textContent = "Weather unavailable";
          status.textContent = "Retrying soon";
        }
        return false;
      }
    }

    // Refresh normally every few minutes, but retry sooner after a failure.
    let timer;
    let stopped = false;
    async function loop() {
      const ok = await update();
      if (stopped) return;
      timer = setTimeout(loop, ok ? cfg.refreshMinutes * 60000 : 2 * 60000);
    }
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  },

    calendar(el) {
    const cfg = TIMING.calendar;
    const calendars = settings.calendars;
    el.innerHTML = `<div class="cal-header">Upcoming</div><div class="cal-list">Loading...</div>`;
    const list = el.querySelector(".cal-list");

    if (calendars.length === 0) {
      list.textContent = "Add a calendar in Settings (tray menu > Settings)";
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

    // One broken link shouldn't hide the other calendars.
    async function update() {
      const all = [];
      const failed = [];
      for (const cal of calendars) {
        try {
          const res = await tauriFetch(cal.url);
          if (!res.ok) throw new Error(`${cal.name} calendar failed: ${res.status}`);
          all.push(...upcomingEvents(await res.text(), cal.name, cal.color, cfg.daysAhead));
        } catch (err) {
          console.error(err);
          failed.push(cal.name);
        }
      }
      if (failed.length === calendars.length) {
        list.textContent = "Calendar unavailable";
        return;
      }
      all.sort((a, b) => a.start - b.start);
      show(all.slice(0, cfg.maxEvents));
      if (failed.length) {
        list.insertAdjacentHTML("beforeend",
          `<div class="cal-error">Couldn't load: ${escapeHtml(failed.join(", "))}</div>`);
      }
    }

    update();
    const timer = setInterval(update, cfg.refreshMinutes * 60 * 1000);
    return () => clearInterval(timer);
  },
    fence: (el, item) => fenceWidget(el, item, fenceApp),
    notes: (el, item) => notesWidget(el, item, fenceApp),
    countdown: (el, item) => countdownWidget(el, item, fenceApp),
    stats: (el) => statsWidget(el),
    music(el, item) {
    const { invoke } = window.__TAURI__.core;
    const VIEWS = ["record", "cover", "minimal"];
    const icon = {
      prev: `<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>`,
      next: `<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>`,
      play: `<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>`,
      pause: `<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>`,
    };

    el.innerHTML = `
      <div class="mu">
        <div class="mu-visual">
          <div class="mu-record"><div class="mu-label"><img class="mu-art" alt=""></div></div>
          <div class="mu-arm"></div>
          <img class="mu-cover mu-art" alt="">
        </div>
        <div class="mu-info">
          <div class="mu-title">Nothing playing</div>
          <div class="mu-artist"></div>
          <div class="mu-progress"><div class="mu-bar"></div></div>
          <div class="mu-times"><span class="mu-pos"></span><span class="mu-dur"></span></div>
          <div class="mu-controls">
            <button data-action="previous" title="Previous">${icon.prev}</button>
            <button data-action="toggle" class="mu-toggle" title="Play/Pause">${icon.play}</button>
            <button data-action="next" title="Next">${icon.next}</button>
          </div>
        </div>
        <button class="mu-view-btn" title="Change view">View</button>
      </div>`;

    const root = el.querySelector(".mu");
    const $ = (sel) => el.querySelector(sel);
    const arts = el.querySelectorAll(".mu-art");
    let lastTrack = "";

    const setView = (view) => {
      VIEWS.forEach((v) => root.classList.remove(`view-${v}`));
      root.classList.add(`view-${view}`);
    };
    setView(item.view ?? "record");

    $(".mu-view-btn").addEventListener("click", () => {
      const next = VIEWS[(VIEWS.indexOf(item.view ?? "record") + 1) % VIEWS.length];
      item.view = next;
      setView(next);
      saveLayout();
    });

    el.querySelectorAll(".mu-controls button").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await invoke("media_control", { action: btn.dataset.action });
        setTimeout(update, 300); // refresh quickly so the button feels instant
      }));

    const fmt = (ms) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
    };

    async function update() {
      try {
        const now = await invoke("media_now_playing");
        if (!now || !now.title) {
          root.classList.remove("playing");
          root.classList.add("idle");
          $(".mu-title").textContent = "Nothing playing";
          $(".mu-artist").textContent = "";
          $(".mu-times").style.visibility = "hidden";
          $(".mu-bar").style.width = "0%";
          lastTrack = "";
          return;
        }
        root.classList.remove("idle");
        root.classList.toggle("playing", now.playing);
        $(".mu-title").textContent = now.title;
        $(".mu-artist").textContent = [now.artist, now.album].filter(Boolean).join(" · ");
        $(".mu-toggle").innerHTML = now.playing ? icon.pause : icon.play;

        const hasTime = now.durationMs > 0;
        $(".mu-times").style.visibility = hasTime ? "visible" : "hidden";
        $(".mu-pos").textContent = fmt(now.positionMs);
        $(".mu-dur").textContent = fmt(now.durationMs);
        $(".mu-bar").style.width = hasTime ? `${(now.positionMs / now.durationMs) * 100}%` : "0%";

        // Only fetch album art when the song changes.
        const track = `${now.title}|${now.artist}|${now.album}`;
        if (track !== lastTrack) {
          lastTrack = track;
          const art = await invoke("media_artwork");
          arts.forEach((img) => {
            img.src = art ?? "";
            img.style.visibility = art ? "visible" : "hidden";
          });
        }
      } catch (err) {
        console.error(err);
      }
    }

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  },
};

// ---------- Saving and loading ----------
const store = await load("layout.json", { autoSave: 300 });
let layout = (await store.get("widgets")) ?? [];

let settings = await loadSettings(store);

// Default widgets you deleted on purpose, so they don't come back.
const hiddenDefaults = (await store.get("hiddenDefaults")) ?? [];

// Add any default widgets missing from the saved layout, and drop unknown ones.
for (const def of DEFAULT_LAYOUT) {
  if (hiddenDefaults.includes(def.id)) continue;
  if (!layout.some((w) => w.id === def.id)) layout.push(structuredClone(def));
}

async function saveLayout() {
  reportHitRegions();
  await store.set("widgets", layout);
}

// Tells Rust which areas should take clicks. Everywhere else passes through to the desktop.
// In edit mode the whole screen takes clicks so you can drag freely.
function reportHitRegions() {
  const regions = editMode || settingsOpen
    ? [{ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }]
    : layout.map((w) => ({ x: w.x, y: w.y, w: w.w, h: boxHeight(w) }));
  window.__TAURI__.core.invoke("set_hit_regions", { regions });
}

// ---------- Helpers ----------
const snap = (n) => Math.round(n / GRID) * GRID;
const clamp = (n, min, max) => Math.max(min, Math.min(n, max));
const boxHeight = (item) => (item.collapsed ? COLLAPSED_H : item.h);

function applyBox(el, item) {
  el.style.left = item.x + "px";
  el.style.top = item.y + "px";
  el.style.width = item.w + "px";
  el.style.height = boxHeight(item) + "px";
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
let settingsOpen = false;
let cleanups = [];

function render() {
  cleanups.forEach((stop) => stop());
  cleanups = [];
  desktop.innerHTML = "";
  for (const item of layout) {
    const el = document.createElement("div");
    el.className = `widget widget-${item.type}`;
    el.dataset.id = item.id;
    applyBox(el, item);

    const content = document.createElement("div");
    content.className = "widget-content";
    el.appendChild(content);

    const handle = document.createElement("div");
    handle.className = "resize-handle";
    el.appendChild(handle);

    desktop.appendChild(el);
    const build = widgetTypes[item.type];
    if (!build) { el.remove(); continue; } // from a newer or older version
    const stop = build(content, item);
    if (typeof stop === "function") cleanups.push(stop);

    // Drag to move
    el.addEventListener("pointerdown", (e) => {
      if (!editMode || e.target === handle) return;
      if (e.target.closest("[data-no-drag], [contenteditable=true]")) return;
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
  if (!on) addMenu.classList.remove("open");
  document.body.classList.toggle("editing", on);
  reportHitRegions();
  window.__TAURI__.core.invoke("tray_edit_mode", { on }); // keeps the tray checkmark in sync
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === "e" && !settingsOpen) {
    e.preventDefault();
    setEditMode(!editMode);
  }
});

document.getElementById("done-btn").addEventListener("click", () => setEditMode(false));
document.getElementById("reset-btn").addEventListener("click", async () => {
  hiddenDefaults.length = 0;
  await store.set("hiddenDefaults", hiddenDefaults);
  layout = structuredClone(DEFAULT_LAYOUT);
  await saveLayout();
  render();
});

// ---------- Adding and removing widgets ----------
// What the fence widgets are allowed to use from this file.
const fenceApp = {
  layout: () => layout,
  isEditMode: () => editMode,
  saveLayout,
  applyBox,
  addWidget,
  removeWidget,
};

// Finds the first empty spot big enough for a new widget, scanning from the top left.
function findFreeSpot(w, h) {
  const gap = 20;
  const overlaps = (x, y) => layout.some((o) =>
    x < o.x + o.w + gap && x + w + gap > o.x && y < o.y + boxHeight(o) + gap && y + h + gap > o.y);
  for (let y = 40; y + h <= window.innerHeight - 40; y += GRID * 2) {
    for (let x = 40; x + w <= window.innerWidth - 40; x += GRID * 2) {
      if (!overlaps(x, y)) return { x, y };
    }
  }
  return null;
}

// Adds a widget at (x, y), or in the first empty spot if no position is given.
function addWidget(props, x, y) {
  const item = { id: `${props.type}-${Date.now()}`, w: 340, h: 220, ...props };
  const spot = x == null ? findFreeSpot(item.w, item.h) : null;
  if (spot) {
    item.x = spot.x;
    item.y = spot.y;
  } else {
    x ??= window.innerWidth / 2;
    y ??= window.innerHeight / 2;
    item.x = clamp(snap(x - item.w / 2), 0, window.innerWidth - item.w);
    item.y = clamp(snap(y - 20), 0, window.innerHeight - item.h);
  }
  layout.push(item);
  saveLayout();
  render();
}

async function removeWidget(item) {
  layout = layout.filter((w) => w !== item);
  if (DEFAULT_LAYOUT.some((d) => d.id === item.id)) {
    hiddenDefaults.push(item.id);
    await store.set("hiddenDefaults", hiddenDefaults);
  }
  await saveLayout();
  render();
}

// The "+ Add widget" menu in the edit banner.
const ADDABLE = [
  { label: "Fence", make: () => ({ type: "fence", title: "New fence",
      color: FENCE_COLORS[layout.length % FENCE_COLORS.length], items: [], w: 340, h: 260 }) },
  { label: "Notes", make: () => ({ type: "notes", title: "Notes", text: "", w: 300, h: 240 }) },
  { label: "Countdown", make: () => ({ type: "countdown", title: "", target: null, w: 300, h: 170 }) },
  { label: "System stats", make: () => ({ type: "stats", w: 320, h: 220 }) },
  // These only show up if you've deleted them.
  { label: "Clock", single: "clock", make: () => ({ type: "clock", w: 340, h: 140 }) },
  { label: "Weather", single: "weather", make: () => ({ type: "weather", w: 340, h: 230 }) },
  { label: "Calendar", single: "calendar", make: () => ({ type: "calendar", w: 340, h: 300 }) },
  { label: "Music", single: "music", make: () => ({ type: "music", view: "record", w: 460, h: 220 }) },
];

const addMenu = document.getElementById("add-menu");
document.getElementById("add-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (addMenu.classList.toggle("open")) {
    addMenu.innerHTML = ADDABLE
      .filter((a) => !a.single || !layout.some((w) => w.type === a.single))
      .map((a) => `<button data-label="${a.label}">${a.label}</button>`).join("");
  }
});
addMenu.addEventListener("click", (e) => {
  const choice = ADDABLE.find((a) => a.label === e.target.dataset.label);
  if (!choice) return;
  addMenu.classList.remove("open");
  addWidget(choice.make());
});
document.addEventListener("click", () => addMenu.classList.remove("open"));

listenForFileDrops(fenceApp);

// ---------- Settings ----------
function showSettings() {
  if (settingsOpen) return;
  settingsOpen = true;
  reportHitRegions(); // the panel needs clicks, wherever it sits
  openSettings(settings, {
    async onSave(next) {
      const w = settings.weather, n = next.weather;
      const weatherChanged = w.latitude !== n.latitude || w.longitude !== n.longitude ||
        w.temperatureUnit !== n.temperatureUnit || w.windUnit !== n.windUnit;
      settings = next;
      await store.set("settings", settings);
      if (weatherChanged) await store.delete("weatherCache"); // old place or units
      render(); // rebuild widgets with the new settings
    },
    onClose() {
      settingsOpen = false;
      reportHitRegions();
    },
  });
}

document.getElementById("settings-btn").addEventListener("click", showSettings);

// The tray menu's "Edit mode" and "Settings" items.
window.__TAURI__.event.listen("tray-action", (e) => {
  if (e.payload === "edit") setEditMode(!editMode);
  if (e.payload === "settings") showSettings();
});

render();
reportHitRegions();
window.addEventListener("resize", reportHitRegions);