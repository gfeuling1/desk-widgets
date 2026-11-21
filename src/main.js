// Each widget type is a function that builds its content.
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

// The layout: which widgets to show and where. Later this moves to a JSON file.
const layout = [
  { type: "clock", x: 60, y: 60 },
];

const desktop = document.getElementById("desktop");
for (const item of layout) {
  const el = document.createElement("div");
  el.className = "widget";
  el.style.left = item.x + "px";
  el.style.top = item.y + "px";
  desktop.appendChild(el);
  widgetTypes[item.type](el);
}