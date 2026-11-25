// The tray icon by the clock, with a menu for the things you'd otherwise
// need keyboard focus or a terminal for.
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{App, Emitter, Manager, Wry};
use tauri_plugin_autostart::ManagerExt;

// Kept so the page can update the Edit mode checkmark when you press Ctrl+E or Done.
pub struct EditItem(pub CheckMenuItem<Wry>);

pub fn create(app: &App) -> tauri::Result<()> {
    let edit = CheckMenuItem::with_id(app, "edit", "Edit mode", true, false, Some("Ctrl+Alt+W"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings...", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Reload widgets", true, None::<&str>)?;

    // Only the installed app should change the startup setting, so this is
    // grayed out while you run `npm run tauri dev`.
    let installed = !cfg!(debug_assertions);
    let startup_label = if installed { "Start with Windows" } else { "Start with Windows (installed app only)" };
    let startup_on = app.autolaunch().is_enabled().unwrap_or(false);
    let startup = CheckMenuItem::with_id(app, "startup", startup_label, installed, startup_on, None::<&str>)?;

    let quit = MenuItem::with_id(app, "quit", "Quit Desk Widgets", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &edit,
            &settings,
            &reload,
            &PredefinedMenuItem::separator(app)?,
            &startup,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    app.manage(EditItem(edit));
    let startup_item = startup.clone();

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Desk Widgets")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            // Both need keyboard focus: Ctrl+E to leave edit mode, typing in Settings.
            id @ ("edit" | "settings") => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                let _ = app.emit("tray-action", id);
            }
            "reload" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.reload();
                }
            }
            "startup" => {
                let autostart = app.autolaunch();
                let _ = if autostart.is_enabled().unwrap_or(false) {
                    autostart.disable()
                } else {
                    autostart.enable()
                };
                let _ = startup_item.set_checked(autostart.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

// Called by the page whenever edit mode turns on or off.
#[tauri::command]
pub fn tray_edit_mode(on: bool, item: tauri::State<EditItem>) {
    let _ = item.0.set_checked(on);
}