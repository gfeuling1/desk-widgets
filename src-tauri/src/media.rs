// Reads what's playing on Windows through the System Media Transport Controls,
// the same system that powers the media popup when you press a volume key.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    title: String,
    artist: String,
    album: String,
    app: String,
    playing: bool,
    position_ms: i64,
    duration_ms: i64,
}

fn current_session() -> windows::core::Result<Option<Session>> {
    let manager = Manager::RequestAsync()?.join()?;
    Ok(manager.GetCurrentSession().ok())
}

// Windows times are counted in 100-nanosecond "ticks".
const TICKS_PER_MS: i64 = 10_000;
// Ticks between 1601-01-01 (Windows' starting point) and 1970-01-01.
const EPOCH_DIFF_TICKS: i64 = 116_444_736_000_000_000;

fn now_ticks() -> i64 {
    let since_1970 = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (since_1970.as_nanos() / 100) as i64 + EPOCH_DIFF_TICKS
}

pub fn now_playing() -> windows::core::Result<Option<NowPlaying>> {
    let Some(session) = current_session()? else { return Ok(None) };
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    let playing = session.GetPlaybackInfo()?.PlaybackStatus()? == Status::Playing;

    let timeline = session.GetTimelineProperties()?;
    let duration = timeline.EndTime()?.Duration - timeline.StartTime()?.Duration;
    let mut position = timeline.Position()?.Duration;
    // Apps only report their position every few seconds, so estimate the time since then.
    if playing {
        let last_update = timeline.LastUpdatedTime()?.UniversalTime;
        if last_update > 0 {
            position += (now_ticks() - last_update).max(0);
        }
    }
    if duration > 0 {
        position = position.clamp(0, duration);
    }

    Ok(Some(NowPlaying {
        title: props.Title()?.to_string(),
        artist: props.Artist()?.to_string(),
        album: props.AlbumTitle()?.to_string(),
        app: session.SourceAppUserModelId()?.to_string(),
        playing,
        position_ms: position / TICKS_PER_MS,
        duration_ms: duration / TICKS_PER_MS,
    }))
}

// Returns the album art as a data URL the page can show in an <img>.
pub fn artwork() -> windows::core::Result<Option<String>> {
    let Some(session) = current_session()? else { return Ok(None) };
    let props = session.TryGetMediaPropertiesAsync()?.join()?;
    let Ok(thumb) = props.Thumbnail() else { return Ok(None) };
    let stream = thumb.OpenReadAsync()?.join()?;
    let size = stream.Size()? as u32;
    if size == 0 {
        return Ok(None);
    }
    let buffer = Buffer::Create(size)?;
    let filled = stream.ReadAsync(&buffer, size, InputStreamOptions::None)?.join()?;
    let reader = DataReader::FromBuffer(&filled)?;
    let mut bytes = vec![0u8; filled.Length()? as usize];
    reader.ReadBytes(&mut bytes)?;
    let mime = stream.ContentType().map(|s| s.to_string()).unwrap_or_default();
    let mime = if mime.is_empty() { "image/png".to_string() } else { mime };
    Ok(Some(format!("data:{};base64,{}", mime, STANDARD.encode(bytes))))
}

pub fn control(action: &str) -> windows::core::Result<bool> {
    let Some(session) = current_session()? else { return Ok(false) };
    let op = match action {
        "toggle" => session.TryTogglePlayPauseAsync()?,
        "next" => session.TrySkipNextAsync()?,
        "previous" => session.TrySkipPreviousAsync()?,
        _ => return Ok(false),
    };
    op.join()
}

// ---------- Commands the page can call ----------
// The Windows calls wait for results, so they run on a background thread.

#[tauri::command]
pub async fn media_now_playing() -> Result<Option<NowPlaying>, String> {
    tauri::async_runtime::spawn_blocking(now_playing)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn media_artwork() -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(artwork)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn media_control(action: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || control(&action))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}