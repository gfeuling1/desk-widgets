// Ctrl+Alt+W toggles edit mode from anywhere, even when another app is focused.
use tauri::{App, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub fn register(app: &App) -> tauri::Result<()> {
    let edit = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyW);

    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &edit && event.state() == ShortcutState::Pressed {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("tray-action", "edit");
                }
            })
            .build(),
    )?;

    // If another app already uses this shortcut, keep running without it.
    if let Err(err) = app.global_shortcut().register(edit) {
        eprintln!("Couldn't register Ctrl+Alt+W: {err}");
    }
    Ok(())
}
