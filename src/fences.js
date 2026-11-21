// Fence widgets: labeled boxes that hold your shortcuts, folders, and files.
// A fence either mirrors a real folder (like Desktop or Downloads) or holds
// items you put in it yourself.

const { invoke } = window.__TAURI__.core;

export const FENCE_COLORS = ["#5aa9ff", "#3ddc97", "#ffb547", "#ff6b9a", "#b78cff", "#ff7a59"];
export const COLLAPSED_H = 44; // a collapsed fence shows only its title bar

const REFRESH_MS = 5000; // how often folder fences check for new files
const iconCache = new Map();

function iconFor(path) {
  if (!iconCache.has(path)) {
    iconCache.set(path, invoke("fence_icon", { path }).catch(() => null));
  }
  return iconCache.get(path);
}

// Every path you've put into a fence yourself. The Desktop fence hides these
// so each item only shows up in one place.
function claimedPaths(app) {
  return new Set(app.layout()
    .filter((w) => w.type === "fence" && Array.isArray(w.items))
    .flatMap((w) => w.items.map((p) => p.toLowerCase())));
}

function fenceAtPoint(app, x, y) {
  const el = document.elementFromPoint(x, y)?.closest(".widget");
  const item = el && app.layout().find((w) => w.id === el.dataset.id);
  return item?.type === "fence" ? { el, item } : null;
}

// Tells every fence to reload, for example after an item moves between fences.
function fencesChanged(app) {
  app.saveLayout();
  document.dispatchEvent(new Event("fences-changed"));
}

// Adds paths to a fence you fill yourself, skipping any it already has.
function addToFence(app, fence, paths) {
  const have = new Set(fence.items.map((p) => p.toLowerCase()));
  for (const p of paths) {
    if (!have.has(p.toLowerCase())) fence.items.push(p);
  }
  fencesChanged(app);
}

export function fenceWidget(el, item, app) {
  item.color ??= FENCE_COLORS[Math.max(0, app.layout().indexOf(item)) % FENCE_COLORS.length];
  item.title ??= "New fence";
  if (!item.folder) item.items ??= [];

  el.innerHTML = `
    <div class="fence">
      <div class="fence-head">
        <span class="fence-dot" data-no-drag title="Change color"></span>
        <span class="fence-title" data-no-drag title="Double-click to rename in edit mode"></span>
        <span class="fence-count"></span>
        <button class="fence-delete" data-no-drag title="Delete fence (your files are not touched)">×</button>
      </div>
      ${item.folder ? `<input class="fence-search" data-no-drag placeholder="Search this fence...">` : ""}
      <div class="fence-grid"></div>
    </div>`;

  const root = el.querySelector(".fence");
  const dot = el.querySelector(".fence-dot");
  const title = el.querySelector(".fence-title");
  const count = el.querySelector(".fence-count");
  const grid = el.querySelector(".fence-grid");
  const search = el.querySelector(".fence-search");
  const widgetEl = el.parentElement;

  let entries = [];
  let lastKey = "";

  title.textContent = item.title;
  dot.style.background = item.color;
  root.classList.toggle("collapsed", !!item.collapsed);

  // ----- Header: collapse, rename, recolor, delete -----
  el.querySelector(".fence-head").addEventListener("click", (e) => {
    if (app.isEditMode() || e.target.closest("button, [contenteditable=true]")) return;
    item.collapsed = !item.collapsed;
    root.classList.toggle("collapsed", item.collapsed);
    app.applyBox(widgetEl, item);
    updateCount();
    app.saveLayout();
  });

  title.addEventListener("dblclick", () => {
    if (!app.isEditMode()) return;
    title.contentEditable = "true";
    title.focus();
    document.getSelection().selectAllChildren(title);
  });
  const finishRename = () => {
    if (title.contentEditable !== "true") return;
    title.contentEditable = "false";
    item.title = title.textContent.trim() || "Untitled";
    title.textContent = item.title;
    app.saveLayout();
  };
  title.addEventListener("blur", finishRename);
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); title.blur(); }
    e.stopPropagation(); // so typing "e" with Ctrl held doesn't toggle edit mode
  });

  dot.addEventListener("click", () => {
    if (!app.isEditMode()) return;
    item.color = FENCE_COLORS[(FENCE_COLORS.indexOf(item.color) + 1) % FENCE_COLORS.length];
    dot.style.background = item.color;
    app.saveLayout();
  });

  el.querySelector(".fence-delete").addEventListener("click", () => app.removeWidget(item));

  search?.addEventListener("input", draw);

  // ----- Loading what's inside -----
  async function load() {
    if (!item.folder) {
      return invoke("fence_path_info", { paths: item.items });
    }
    let list = await invoke("fence_list_folder", { folder: item.folder });
    if (item.hideClaimed) {
      const claimed = claimedPaths(app);
      list = list.filter((e) => !claimed.has(e.path.toLowerCase()));
    }
    if (item.sort === "newest") {
      list.sort((a, b) => b.modified - a.modified);
    } else {
      list.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    }
    return list.slice(0, item.maxItems ?? 60);
  }

  async function refresh() {
    try {
      const next = await load();
      const key = JSON.stringify(next.map((e) => [e.path, e.modified, e.exists]));
      if (key === lastKey) return; // nothing changed, so skip redrawing
      lastKey = key;
      entries = next;
      draw();
    } catch (err) {
      console.error(err);
      lastKey = "";
      grid.innerHTML = `<div class="fence-empty">Couldn't read this folder</div>`;
    }
  }

  function updateCount() {
    const n = entries.length;
    count.textContent = `${n} item${n === 1 ? "" : "s"}${item.collapsed ? " · click to expand" : ""}`;
  }

  // ----- Drawing the icons -----
  function draw() {
    updateCount();
    const q = search?.value.trim().toLowerCase() ?? "";
    const shown = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;

    grid.innerHTML = "";
    if (shown.length === 0) {
      grid.innerHTML = `<div class="fence-empty">${
        q ? "No matches" : item.folder ? "Nothing here" : "Drag shortcuts here"}</div>`;
      return;
    }

    for (const entry of shown) {
      const tile = document.createElement("div");
      tile.className = "fence-item" + (entry.exists ? "" : " missing");
      tile.dataset.noDrag = "";
      tile.title = entry.exists ? entry.path : `Missing: ${entry.path}`;
      tile.innerHTML = `
        <div class="fence-icon"></div>
        <div class="fence-label"></div>
        ${item.folder ? "" : `<button class="fence-remove" title="Remove from fence">×</button>`}`;
      const icon = tile.querySelector(".fence-icon");
      icon.textContent = entry.name.charAt(0).toUpperCase(); // shown until the real icon loads
      tile.querySelector(".fence-label").textContent = entry.name;

      if (entry.exists) {
        iconFor(entry.path).then((src) => {
          if (!src) return;
          const img = new Image();
          img.src = src;
          img.alt = "";
          img.draggable = false;
          icon.replaceChildren(img);
          icon.classList.add("has-img");
        });
      }

      tile.addEventListener("dblclick", () => {
        if (app.isEditMode()) return;
        invoke("fence_open", { path: entry.path }).catch(console.error);
      });

      tile.querySelector(".fence-remove")?.addEventListener("click", (e) => {
        e.stopPropagation();
        item.items = item.items.filter((p) => p !== entry.path);
        fencesChanged(app);
      });

      tile.addEventListener("pointerdown", (e) => {
        if (!app.isEditMode() || e.button !== 0 || e.target.closest(".fence-remove")) return;
        startItemDrag(e, tile, entry);
      });

      grid.appendChild(tile);
    }
  }

  // ----- Moving icons between fences (edit mode) -----
  function startItemDrag(startEvent, tile, entry) {
    startEvent.preventDefault();
    startEvent.stopPropagation();
    let ghost = null;
    let target = null;

    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - startEvent.clientX, e.clientY - startEvent.clientY) < 5) return;
        ghost = tile.cloneNode(true);
        ghost.classList.add("fence-ghost");
        document.body.appendChild(ghost);
        tile.classList.add("dragging");
      }
      ghost.style.left = e.clientX - 38 + "px";
      ghost.style.top = e.clientY - 30 + "px";
      const hit = fenceAtPoint(app, e.clientX, e.clientY);
      const next = hit && hit.item !== item && (!hit.item.folder || hit.item.hideClaimed) ? hit : null;
      if (target?.el !== next?.el) {
        target?.el.classList.remove("drop-target");
        next?.el.classList.add("drop-target");
        target = next;
      }
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      ghost?.remove();
      tile.classList.remove("dragging");
      target?.el.classList.remove("drop-target");
      if (!target) return;

      // Take it out of this fence if you put it here yourself.
      if (!item.folder) item.items = item.items.filter((p) => p !== entry.path);
      // Dropping on a hand-filled fence adds it there. Dropping it on the
      // Desktop fence just hands it back.
      if (!target.item.folder) addToFence(app, target.item, [entry.path]);
      else fencesChanged(app);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ----- Keeping it up to date -----
  document.addEventListener("fences-changed", refresh);
  refresh();
  const timer = item.folder ? setInterval(refresh, REFRESH_MS) : null;
  return () => {
    clearInterval(timer);
    document.removeEventListener("fences-changed", refresh);
  };
}

// Lets you drag files, folders, and shortcuts from Explorer or the desktop
// onto a fence. In edit mode you can also drop them on empty space:
// one folder makes a fence that mirrors it, anything else makes a new fence.
export function listenForFileDrops(app) {
  const webview = window.__TAURI__.webview.getCurrentWebview();
  let hovered = null;

  const toPage = (pos) => ({ x: pos.x / window.devicePixelRatio, y: pos.y / window.devicePixelRatio });
  const setHover = (hit) => {
    if (hovered?.el === hit?.el) return;
    hovered?.el.classList.remove("drop-target");
    hit?.el.classList.add("drop-target");
    hovered = hit;
  };

  webview.onDragDropEvent(async (event) => {
    const { type, position, paths } = event.payload;
    if (type === "leave") return setHover(null);

    const { x, y } = toPage(position);
    const hit = fenceAtPoint(app, x, y);
    const usable = hit && !hit.item.folder ? hit : null;
    if (type === "enter" || type === "over") return setHover(usable);
    if (type !== "drop") return;
    setHover(null);

    if (usable) {
      addToFence(app, usable.item, paths);
    } else if (!hit && app.isEditMode() && paths.length > 0) {
      const info = await invoke("fence_path_info", { paths });
      const oneFolder = info.length === 1 && info[0].isDir;
      app.addWidget(oneFolder
        ? { type: "fence", title: info[0].name, folder: info[0].path, sort: "name" }
        : { type: "fence", title: "New fence", items: paths }, x, y);
    }
  });
}