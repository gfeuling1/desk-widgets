// Notes, countdown, and system stats widgets.
// Each one builds inside `el`, saves its own data on `item` (the widget's
// entry in your layout), and returns a function that stops its timers.

const { invoke } = window.__TAURI__.core;

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// ---------- Notes ----------
// Type straight into it. Saves half a second after you stop typing.
export function notesWidget(el, item, app) {
  el.innerHTML = `
    <div class="notes-title" contenteditable="plaintext-only" spellcheck="false"></div>
    <textarea class="notes-text" placeholder="Type a note..." spellcheck="true"></textarea>`;
  const title = el.querySelector(".notes-title");
  const text = el.querySelector(".notes-text");
  title.textContent = item.title ?? "Notes";
  text.value = item.text ?? "";

  let timer;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      item.title = title.textContent.trim() || "Notes";
      item.text = text.value;
      app.saveLayout();
    }, 500);
  };
  text.addEventListener("input", save);
  title.addEventListener("input", save);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); text.focus(); }
  });
  return () => clearTimeout(timer);
}

// ---------- Countdown ----------
// Counts down to a date. Click the pencil to change the name or date.
export function countdownWidget(el, item, app) {
  el.innerHTML = `
    <div class="cd-view">
      <div class="cd-title"></div>
      <div class="cd-big"><span class="cd-num"></span> <span class="cd-unit"></span></div>
      <div class="cd-sub"></div>
      <button class="cd-edit" title="Edit">✎</button>
    </div>
    <form class="cd-form">
      <input class="cd-in-title" type="text" placeholder="What are you counting down to?">
      <input class="cd-in-date" type="datetime-local">
      <div class="cd-buttons">
        <button type="button" class="cd-cancel">Cancel</button>
        <button type="submit" class="cd-save">Save</button>
      </div>
    </form>`;
  const $ = (sel) => el.querySelector(sel);
  const root = el;

  function editing(on) {
    root.classList.toggle("cd-editing", on);
    if (on) {
      $(".cd-in-title").value = item.title ?? "";
      $(".cd-in-date").value = item.target ?? "";
      $(".cd-in-title").focus();
    }
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function tick() {
    $(".cd-title").textContent = item.title || "Countdown";
    if (!item.target) {
      $(".cd-num").textContent = "";
      $(".cd-unit").textContent = "";
      $(".cd-sub").textContent = "Click ✎ to set a date";
      return;
    }
    const target = new Date(item.target);
    const ms = target - Date.now();
    const dateText = target.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const mins = Math.floor(Math.abs(ms) / 60000);
    const days = Math.floor(mins / 1440);
    const hours = Math.floor((mins % 1440) / 60);
    const minutes = mins % 60;

    if (ms <= 0 && ms > -86400000) {
      $(".cd-num").textContent = "Today";
      $(".cd-unit").textContent = "";
      $(".cd-sub").textContent = dateText;
    } else if (days >= 1) {
      $(".cd-num").textContent = days;
      $(".cd-unit").textContent = days === 1 ? "day" : "days";
      $(".cd-sub").textContent = ms > 0 ? `${plural(hours, "hour")} more · ${dateText}` : `ago · ${dateText}`;
    } else {
      $(".cd-num").textContent = hours > 0 ? hours : minutes;
      $(".cd-unit").textContent = hours > 0 ? (hours === 1 ? "hour" : "hours") : (minutes === 1 ? "minute" : "minutes");
      $(".cd-sub").textContent = hours > 0 ? `${plural(minutes, "minute")} more · ${dateText}` : dateText;
    }
  }

  $(".cd-edit").addEventListener("click", () => editing(true));
  $(".cd-cancel").addEventListener("click", () => editing(false));
  $(".cd-form").addEventListener("submit", (e) => {
    e.preventDefault();
    item.title = $(".cd-in-title").value.trim() || "Countdown";
    item.target = $(".cd-in-date").value || null;
    app.saveLayout();
    editing(false);
    tick();
  });

  tick();
  if (!item.target) editing(true);
  const timer = setInterval(tick, 30000);
  return () => clearInterval(timer);
}

// ---------- System stats ----------
const GB = 1024 ** 3;

function speed(bytesPerSec) {
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function uptime(secs) {
  const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function statsWidget(el) {
  el.innerHTML = `
    <div class="st-header">System <span class="st-uptime"></span></div>
    <div class="st-rows"></div>
    <div class="st-net"></div>`;
  const rows = el.querySelector(".st-rows");
  const net = el.querySelector(".st-net");
  const up = el.querySelector(".st-uptime");

  const row = (label, pct, value) => `
    <div class="st-row">
      <span class="st-label">${label}</span>
      <div class="st-bar"><div style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%;
        background:${pct > 85 ? "#f87171" : pct > 65 ? "#fbbf24" : "#60a5fa"}"></div></div>
      <span class="st-value">${escapeHtml(value)}</span>
    </div>`;

  async function update() {
    try {
      const s = await invoke("system_stats");
      let html = row("CPU", s.cpu, `${Math.round(s.cpu)}%`);
      if (s.memTotal) {
        html += row("Memory", (s.memUsed / s.memTotal) * 100,
          `${(s.memUsed / GB).toFixed(1)} / ${(s.memTotal / GB).toFixed(0)} GB`);
      }
      if (s.diskTotal) {
        const used = s.diskTotal - s.diskFree;
        html += row("Disk", (used / s.diskTotal) * 100, `${Math.round(s.diskFree / GB)} GB free`);
      }
      if (s.battery) {
        // For battery, a full bar is good, so the warning colors flip.
        const b = s.battery;
        html += row("Battery", 100 - b.percent, `${b.percent}%${b.charging ? " ⚡" : ""}`)
          .replace(/width:[\d.]+%/, `width:${b.percent}%`);
      }
      rows.innerHTML = html;
      net.textContent = `↓ ${speed(s.netDown)}   ↑ ${speed(s.netUp)}`;
      up.textContent = s.uptime ? `· up ${uptime(s.uptime)}` : "";
    } catch (err) {
      console.error(err);
      rows.textContent = "Stats unavailable";
    }
  }

  update();
  const timer = setInterval(update, 2000);
  return () => clearInterval(timer);
}
