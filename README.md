# Desk Widgets

A Windows desktop dashboard built with Tauri. Widgets live on the desktop behind your icons: clock, weather, calendar, music with a spinning record view, and fences that organize desktop files and folders.

![Desktop overview](docs/screenshots/overview.png)

## Features

- **Clock, weather, and calendar.** Weather comes from [Open-Meteo](https://open-meteo.com/en/docs). The calendar reads Google Calendar iCal links using [ical.js](https://github.com/kewisch/ical.js).
- **Music.** Shows what's playing from any app that reports to Windows media controls (Spotify, YouTube Music in a browser, and others), with album art, play and pause, and skip. You can switch between a record player view and a simple view.
- **Fences.** Group desktop icons into panels. A fence can show a folder (Desktop, Downloads, or any path) or a hand-picked set of items. You can collapse, search, rename, recolor, and drag items between fences, or drop folders in from File Explorer.
- **Edit mode.** Drag and resize any widget. The layout saves automatically.
- **Lives on the desktop.** Pinned behind your icons. Clicks pass through to the desktop except on widgets, and it reattaches itself if Explorer restarts.
- **Settings panel.** Search for your weather location, pick units, and add calendar links. Everything is saved on your computer, never in the code or the installer.
- **Tray menu.** Edit mode, settings, reload, Start with Windows, and quit.

| Edit mode | Music | Fences |
|---|---|---|
| ![Edit mode](docs/screenshots/edit-mode.png) | ![Music](docs/screenshots/music.png) | ![Fences](docs/screenshots/fences.png) |

<img src="docs/screenshots/tray.png" alt="Tray menu" width="292">

## Tech stack

- [Tauri v2](https://v2.tauri.app/) with a Rust backend
- Vanilla JavaScript, HTML, and CSS, with no framework or bundler
- Windows APIs through the [windows crate](https://github.com/microsoft/windows-rs): media session, shell icons, and window pinning
- Tauri plugins: [store](https://v2.tauri.app/plugin/store/), [http](https://v2.tauri.app/plugin/http-client/), [autostart](https://v2.tauri.app/plugin/autostart/), and [single-instance](https://v2.tauri.app/plugin/single-instance/)

## Run it locally

You need Windows 10 or 11 and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): Rust, Node.js, Microsoft C++ Build Tools, and the WebView2 runtime.

```powershell
git clone https://github.com/gfeuling1/desk-widgets.git
cd desk-widgets
npm install
npm run tauri dev
```

Then click the Desk Widgets icon in the tray (the ^ arrow at the right end of the taskbar) and choose **Settings...** to set your location, units, and calendars. For a Google Calendar, open Google Calendar's Settings, choose the calendar under "Settings for my calendars", and copy "Secret address in iCal format". Outlook and iCloud calendar links work too.

Settings are saved in `%APPDATA%\com.yourname.deskwidgets\layout.json`, along with your widget layout.

Only one copy runs at a time. If the installed version is running, close it before starting the dev build.

To build an installer:

```powershell
npm run tauri build
```

The installer is created in `src-tauri\target\release\bundle\nsis\`.

## Project structure

```
src/                   Front end
  main.js              Widgets, layout, drag and resize, edit mode
  fences.js            Fence widget
  settings.js          Settings panel and saved settings
  calendar.js          iCal parsing
  vendor/ical.js       iCal parser
src-tauri/src/         Rust backend
  lib.rs               App setup, plugins, and commands
  desktop.rs           Desktop pinning, click-through, Explorer watchdog
  media.rs             Windows media session (now playing, artwork, controls)
  fences.rs            Folder listing, file icons, opening files
  tray.rs              Tray icon and menu
```

## Known issues

- Some networks can't reach `api.open-meteo.com` because of a DNS issue ([Open-Meteo #2329](https://github.com/open-meteo/open-meteo/issues/2329)).

## Roadmap

- Backup weather source
- Global keyboard shortcut
- System stats, notes, and countdown widgets
- Layout profiles
