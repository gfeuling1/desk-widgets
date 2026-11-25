mod media;
mod tray;
mod desktop;
mod fences;
mod shortcut;
mod stats;
use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(desktop::HitRegions::default())
        .manage(stats::StatsState::default())
                .setup(|app| {
            let window = app.get_webview_window("main").expect("main window missing");
            desktop::pin_to_desktop(&window)?;
            desktop::start_click_through(window.clone());
            desktop::start_explorer_watchdog(window);
            tray::create(app)?;
            shortcut::register(app)?;

            // Start with Windows, but only for the installed app, not `npm run tauri dev`.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart = app.autolaunch();
                if !autostart.is_enabled().unwrap_or(false) {
                    let _ = autostart.enable();
                }
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            media::media_now_playing,
            media::media_artwork,
            media::media_control,
            desktop::set_hit_regions,
            fences::fence_list_folder,
            fences::fence_path_info,
            fences::fence_icon,
            fences::fence_open,
            tray::tray_edit_mode,
            stats::system_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
