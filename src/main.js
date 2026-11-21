const { load } = window.__TAURI__.store;

const GRID = 10;          // widgets snap to a 10px grid
const MIN_W = 120;
const MIN_H = 60;

// Used the first time the app runs, or when you press "Reset layout".
const DEFAULT_LAYOUT = [
  { id: "clock-1", type: "clock", x: 60, y: 60, w: 340, h: 140 },
];

// Each widget type builds its content inside the element it's given.
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
    setInterval(tick, 1000);
  },
};

// ---------- Saving and loading ----------
const store = await load("layout.json", { autoSave: 300 });
let layout = (await store.get("widgets")) ?? structuredClone(DEFAULT_LAYOUT);

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

function render() {
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
    widgetTypes[item.type](content);

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