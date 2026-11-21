// Lists folders, gets file icons, and opens items for the fence widgets.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use windows::core::{w, GUID, HSTRING, PCWSTR};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    IShellItemImageFactory, SHCreateItemFromParsingName, SHGetKnownFolderPath, ShellExecuteW,
    FOLDERID_Desktop, FOLDERID_Downloads, FOLDERID_PublicDesktop, KNOWN_FOLDER_FLAG,
    SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

// One file, folder, or shortcut shown in a fence.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FenceEntry {
    name: String,
    path: String,
    is_dir: bool,
    exists: bool,
    modified: u64,
}

// Finds a Windows special folder, like your real Desktop (even if OneDrive moved it).
fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe {
        let raw = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let path = raw.to_string().ok();
        CoTaskMemFree(Some(raw.0 as _));
        path.map(PathBuf::from)
    }
}

// "Desktop" and "Downloads" are shortcuts. Anything else is used as a real path.
fn resolve(folder: &str) -> Vec<PathBuf> {
    match folder {
        "Desktop" => [&FOLDERID_Desktop, &FOLDERID_PublicDesktop]
            .into_iter()
            .filter_map(known_folder)
            .collect(),
        "Downloads" => known_folder(&FOLDERID_Downloads).into_iter().collect(),
        other => vec![PathBuf::from(other)],
    }
}

// Shortcut names without ".lnk" or ".url", like the real desktop shows them.
fn display_name(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let lower = name.to_lowercase();
    if lower.ends_with(".lnk") || lower.ends_with(".url") {
        name[..name.len() - 4].to_string()
    } else {
        name
    }
}

fn entry_for(path: &Path) -> FenceEntry {
    let meta = std::fs::metadata(path).ok();
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FenceEntry {
        name: display_name(path),
        path: path.to_string_lossy().into_owned(),
        is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        exists: meta.is_some(),
        modified,
    }
}

// Everything inside a folder, skipping hidden and system files like desktop.ini.
#[tauri::command]
pub async fn fence_list_folder(folder: String) -> Result<Vec<FenceEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for dir in resolve(&folder) {
            let entries = std::fs::read_dir(&dir)
                .map_err(|e| format!("Couldn't read {}: {e}", dir.display()))?;
            for entry in entries.flatten() {
                let Ok(meta) = entry.metadata() else { continue };
                const HIDDEN_OR_SYSTEM: u32 = 0x2 | 0x4;
                if meta.file_attributes() & HIDDEN_OR_SYSTEM != 0 {
                    continue;
                }
                out.push(entry_for(&entry.path()));
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Names and details for specific paths, used by fences you fill yourself.
#[tauri::command]
pub fn fence_path_info(paths: Vec<String>) -> Vec<FenceEntry> {
    paths.iter().map(|p| entry_for(Path::new(p))).collect()
}

// The item's real Windows icon as a PNG the page can show.
// Each icon gets its own short-lived thread, because the shell needs a COM
// setup that would break album art if it ran on the shared background threads.
#[tauri::command]
pub async fn fence_icon(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::spawn(move || unsafe {
            let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let png = icon_png(&path, 64);
            if com.is_ok() {
                CoUninitialize();
            }
            png
        })
        .join()
        .ok()
        .flatten()
    })
    .await
    .ok()
    .flatten()
}

unsafe fn icon_png(path: &str, size: i32) -> Option<String> {
    unsafe {
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
        let bitmap = factory
            .GetImage(SIZE { cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
            .ok()?;
        let png = bitmap_to_png(bitmap);
        let _ = DeleteObject(bitmap.into());
        png
    }
}

unsafe fn bitmap_to_png(bitmap: HBITMAP) -> Option<String> {
    unsafe {
        let mut bm = BITMAP::default();
        let got = GetObjectW(
            bitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        );
        if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative means top row first
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let dc = GetDC(None);
        let lines = GetDIBits(dc, bitmap, 0, h as u32, Some(px.as_mut_ptr() as _), &mut info, DIB_RGB_COLORS);
        ReleaseDC(None, dc);
        if lines == 0 {
            return None;
        }

        // Windows gives blue-green-red-alpha with premultiplied alpha. PNG wants plain RGBA.
        let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2);
            if !has_alpha {
                p[3] = 255;
            } else if p[3] > 0 && p[3] < 255 {
                let a = p[3] as u32;
                for c in &mut p[..3] {
                    *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
                }
            }
        }

        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, w as u32, h as u32);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().ok()?;
            writer.write_image_data(&px).ok()?;
        }
        Some(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
    }
}

// Opens an app, folder, or file the same way double-clicking it in Explorer does.
#[tauri::command]
pub fn fence_open(path: String) -> Result<(), String> {
    let result = unsafe {
        ShellExecuteW(None, w!("open"), &HSTRING::from(path.as_str()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
    };
    // Windows returns a number above 32 when it worked.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't open {path} (code {})", result.0 as isize))
    }
}