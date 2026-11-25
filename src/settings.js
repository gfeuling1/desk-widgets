// Your personal settings: weather location, units, and calendar links.
// They're saved in the app's own storage (layout.json in your AppData folder),
// so they never end up in the code, the repo, or the installer.

const { fetch: tauriFetch } = window.__TAURI__.http;

export const DEFAULT_SETTINGS = {
  weather: {
    place: "Lakewood, CO",
    latitude: 39.7047,
    longitude: -105.0814,
    temperatureUnit: "fahrenheit", // or "celsius"
    windUnit: "mph",               // or "kmh"
  },
  calendars: [], // { name, color, url }
};

const CAL_COLORS = ["#60a5fa", "#f59e0b", "#10b981", "#f472b6", "#a78bfa", "#f87171"];

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// Loads saved settings. The first time, it copies your links over from the old
// config.local.js file if you still have it.
export async function loadSettings(store) {
  const saved = await store.get("settings");
  if (saved) {
    return {
      weather: { ...DEFAULT_SETTINGS.weather, ...saved.weather },
      calendars: saved.calendars ?? [],
    };
  }

  const settings = structuredClone(DEFAULT_SETTINGS);
  try {
    const { CALENDARS } = await import("./config.local.js");
    settings.calendars = (CALENDARS ?? []).map((c) => ({ name: c.name, color: c.color, url: c.url }));
    console.info("Copied calendar links from config.local.js into settings.");
  } catch {
    // No old config file, so start with no calendars.
  }
  await store.set("settings", settings);
  return settings;
}

// Calendar apps often share links as webcal://, which is the same thing as https://.
const normalizeUrl = (url) => url.trim().replace(/^webcal:\/\//i, "https://");

// Opens the settings panel. Calls onSave(newSettings) when you click Save.
// Returns a function that closes the panel.
export function openSettings(current, { onSave, onClose }) {
  const draft = structuredClone(current);

  const overlay = document.createElement("div");
  overlay.id = "settings-overlay";
  overlay.innerHTML = `
    <form class="settings" autocomplete="off">
      <div class="settings-header">
        <h2>Settings</h2>
        <button type="button" class="settings-x" title="Close">×</button>
      </div>

      <section>
        <h3>Weather</h3>
        <label class="settings-label">Location</label>
        <div class="settings-row">
          <input class="loc-search" type="text" placeholder="Search for a city or ZIP code">
          <button type="button" class="loc-find">Search</button>
        </div>
        <div class="loc-results"></div>
        <div class="loc-current"></div>

        <div class="settings-grid">
          <div>
            <label class="settings-label">Temperature</label>
            <select class="temp-unit">
              <option value="fahrenheit">Fahrenheit (°F)</option>
              <option value="celsius">Celsius (°C)</option>
            </select>
          </div>
          <div>
            <label class="settings-label">Wind speed</label>
            <select class="wind-unit">
              <option value="mph">mph</option>
              <option value="kmh">km/h</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <h3>Calendars</h3>
        <p class="settings-hint">
          In Google Calendar, open Settings, choose a calendar under "Settings for my calendars",
          and copy the "Secret address in iCal format". Links stay hidden unless you click into them.
        </p>
        <div class="cal-rows"></div>
        <button type="button" class="cal-add">+ Add calendar</button>
      </section>

      <div class="settings-error"></div>
      <div class="settings-footer">
        <button type="button" class="settings-cancel">Cancel</button>
        <button type="submit" class="settings-save">Save</button>
      </div>
    </form>`;
  document.body.appendChild(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const errorBox = $(".settings-error");

  // ----- Weather -----
  const showPlace = () => {
    const w = draft.weather;
    $(".loc-current").innerHTML =
      `Showing weather for <strong>${escapeHtml(w.place)}</strong>
       <span class="settings-dim">(${Number(w.latitude).toFixed(2)}, ${Number(w.longitude).toFixed(2)})</span>`;
  };
  showPlace();
  $(".temp-unit").value = draft.weather.temperatureUnit;
  $(".wind-unit").value = draft.weather.windUnit;

  async function searchPlaces() {
    const query = $(".loc-search").value.trim();
    const results = $(".loc-results");
    if (!query) return;
    results.textContent = "Searching...";
    try {
      const params = new URLSearchParams({ name: query, count: 6, language: "en", format: "json" });
      const res = await tauriFetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {
        connectTimeout: 8000,
      });
      if (!res.ok) throw new Error(`Search failed: ${res.status}`);
      const places = (await res.json()).results ?? [];
      if (places.length === 0) {
        results.textContent = "No matches. Try adding the state or country.";
        return;
      }
      results.innerHTML = places.map((p, i) => `
        <button type="button" class="loc-option" data-i="${i}">
          ${escapeHtml(p.name)}<span class="settings-dim">, ${escapeHtml([p.admin1, p.country].filter(Boolean).join(", "))}</span>
        </button>`).join("");
      results.querySelectorAll(".loc-option").forEach((btn) =>
        btn.addEventListener("click", () => {
          const p = places[btn.dataset.i];
          draft.weather.place = [p.name, p.admin1 ?? p.country].filter(Boolean).join(", ");
          draft.weather.latitude = p.latitude;
          draft.weather.longitude = p.longitude;
          results.innerHTML = "";
          $(".loc-search").value = "";
          showPlace();
        }));
    } catch (err) {
      console.error(err);
      results.textContent = "Couldn't reach the location search. Check your connection and try again.";
    }
  }
  $(".loc-find").addEventListener("click", searchPlaces);
  $(".loc-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); searchPlaces(); }
  });

  // ----- Calendars -----
  function renderCalendars() {
    const rows = $(".cal-rows");
    if (draft.calendars.length === 0) {
      rows.innerHTML = `<div class="settings-dim">No calendars yet.</div>`;
      return;
    }
    rows.innerHTML = draft.calendars.map((c, i) => `
      <div class="cal-row" data-i="${i}">
        <input class="cal-color" type="color" value="${escapeHtml(c.color)}" title="Color">
        <input class="cal-name" type="text" placeholder="Name" value="${escapeHtml(c.name)}">
        <input class="cal-url" type="password" placeholder="Paste the iCal link" value="${escapeHtml(c.url)}">
        <button type="button" class="cal-remove" title="Remove">×</button>
      </div>`).join("");

    rows.querySelectorAll(".cal-row").forEach((row) => {
      const cal = draft.calendars[row.dataset.i];
      const url = row.querySelector(".cal-url");
      row.querySelector(".cal-color").addEventListener("input", (e) => (cal.color = e.target.value));
      row.querySelector(".cal-name").addEventListener("input", (e) => (cal.name = e.target.value));
      url.addEventListener("input", () => (cal.url = url.value));
      url.addEventListener("focus", () => (url.type = "text"));
      url.addEventListener("blur", () => (url.type = "password"));
      row.querySelector(".cal-remove").addEventListener("click", () => {
        draft.calendars.splice(row.dataset.i, 1);
        renderCalendars();
      });
    });
  }
  renderCalendars();

  $(".cal-add").addEventListener("click", () => {
    const n = draft.calendars.length;
    draft.calendars.push({ name: n === 0 ? "Personal" : `Calendar ${n + 1}`, color: CAL_COLORS[n % CAL_COLORS.length], url: "" });
    renderCalendars();
    overlay.querySelectorAll(".cal-url")[n]?.focus();
  });

  // ----- Save and close -----
  function close() {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
    onClose?.();
  }
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }
  window.addEventListener("keydown", onKey, true);

  $(".settings-x").addEventListener("click", close);
  $(".settings-cancel").addEventListener("click", close);

  $(".settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    draft.weather.temperatureUnit = $(".temp-unit").value;
    draft.weather.windUnit = $(".wind-unit").value;

    // Drop empty rows, then check the rest look like real links.
    draft.calendars = draft.calendars
      .map((c) => ({ ...c, name: c.name.trim() || "Calendar", url: normalizeUrl(c.url) }))
      .filter((c) => c.url);
    const bad = draft.calendars.find((c) => !/^https:\/\/\S+$/i.test(c.url));
    if (bad) {
      errorBox.textContent = `The link for "${bad.name}" should start with https:// or webcal://`;
      renderCalendars();
      return;
    }

    await onSave(draft);
    close();
  });

  return close;
}
