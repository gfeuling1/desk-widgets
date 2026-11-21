// Keeps the window on the desktop layer and lets clicks pass through
// everywhere except over a widget, so desktop icons stay usable.
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WebviewWindow};
use windows::core::w;
use windows::Win32::Foundation::{HWND, POINT};
use windows::Win32::UI::WindowsAndMessaging::{
    FindWindowW, GetCursorPos, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_HWNDPARENT,
    GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

// A widget's box, in the page's coordinates.
#[derive(Deserialize, Clone, Copy)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

// The areas of the window that should take clicks. Updated by the page.
#[derive(Default)]
pub struct HitRegions(pub Mutex<Vec<Rect>>);

pub fn pin_to_desktop(window: &WebviewWindow) -> Result<(), String> {
    let hwnd = HWND(window.hwnd().map_err(|e| e.to_string())?.0);
    unsafe {
        let progman = FindWindowW(w!("Progman"), None).map_err(|e| e.to_string())?;
        // Owned by the desktop window, so it stays visible when you press Win+D.
        SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, progman.0 as isize);
        // A "tool window" doesn't show up in Alt+Tab.
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let ex = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
    }
    Ok(())
}

// Checks the mouse position about 25 times a second. Over a widget, the window
// takes clicks. Anywhere else, clicks fall through to the desktop.
pub fn start_click_through(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut ignoring: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_err() {
                continue;
            }
            let (Ok(pos), Ok(scale)) = (window.inner_position(), window.scale_factor()) else {
                continue;
            };
            let x = (pt.x - pos.x) as f64 / scale;
            let y = (pt.y - pos.y) as f64 / scale;
            let over_widget = window
                .state::<HitRegions>()
                .0
                .lock()
                .map(|r| r.iter().any(|r| x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h))
                .unwrap_or(false);
            let ignore = !over_widget;
            if ignoring != Some(ignore) {
                let _ = window.set_ignore_cursor_events(ignore);
                ignoring = Some(ignore);
            }
        }
    });
}

#[tauri::command]
pub fn set_hit_regions(regions: Vec<Rect>, state: tauri::State<HitRegions>) {
    if let Ok(mut current) = state.0.lock() {
        *current = regions;
    }
}

// When Explorer restarts (after a crash or some updates), Windows makes a brand-new
// desktop window. Every 2 seconds, check that we're still attached to the current
// one, and reattach if not.
pub fn start_explorer_watchdog(window: WebviewWindow) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let Ok(raw) = window.hwnd() else { continue };
        let hwnd = HWND(raw.0);
        // While Explorer is still starting up, there's no Progman yet, so wait.
        let Ok(progman) = (unsafe { FindWindowW(w!("Progman"), None) }) else { continue };
        let owner = unsafe { GetWindowLongPtrW(hwnd, GWLP_HWNDPARENT) };
        if owner != progman.0 as isize && pin_to_desktop(&window).is_ok() {
            let _ = window.show();
        }
    });
}