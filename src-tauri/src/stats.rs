// CPU, memory, disk, network, and battery numbers for the system stats widget.
use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, Networks, System};

// CPU usage and network speed are measured between two readings,
// so the last reading is kept here between calls.
pub struct StatsState(Mutex<Option<Reader>>);

impl Default for StatsState {
    fn default() -> Self {
        StatsState(Mutex::new(None))
    }
}

pub struct Reader {
    system: System,
    disks: Option<Disks>,
    networks: Option<Networks>,
    last: Instant,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    percent: u8,
    charging: bool,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    cpu: f32,
    mem_used: u64,
    mem_total: u64,
    disk_free: u64,
    disk_total: u64,
    net_down: u64, // bytes per second
    net_up: u64,
    uptime: u64, // seconds
    battery: Option<Battery>,
}

#[tauri::command]
pub fn system_stats(state: tauri::State<StatsState>) -> Stats {
    let mut guard = state.0.lock().unwrap();
    if guard.is_none() {
        let Ok(mut system) = System::new() else {
            return Stats::default();
        };
        system.refresh_cpu_usage();
        *guard = Some(Reader {
            system,
            disks: Disks::new_with_refreshed_list().ok(),
            networks: Networks::new_with_refreshed_list().ok(),
            last: Instant::now(),
        });
    }
    let r = guard.as_mut().unwrap();

    r.system.refresh_cpu_usage();
    r.system.refresh_memory();

    // The C: drive, or the first drive if C: isn't found.
    let (mut disk_free, mut disk_total) = (0, 0);
    if let Some(disks) = r.disks.as_mut() {
        disks.refresh(false);
        let main = disks
            .iter()
            .find(|d| d.mount_point().to_string_lossy().to_uppercase().starts_with("C:"))
            .or_else(|| disks.first());
        if let Some(d) = main {
            disk_free = d.available_space();
            disk_total = d.total_space();
        }
    }

    // Bytes moved since the last reading, turned into a per-second speed.
    let secs = r.last.elapsed().as_secs_f64().max(0.5);
    r.last = Instant::now();
    let (mut down, mut up) = (0u64, 0u64);
    if let Some(nets) = r.networks.as_mut() {
        nets.refresh(true);
        for (_, data) in nets.iter() {
            down += data.received();
            up += data.transmitted();
        }
    }

    Stats {
        cpu: r.system.global_cpu_usage(),
        mem_used: r.system.used_memory(),
        mem_total: r.system.total_memory(),
        disk_free,
        disk_total,
        net_down: (down as f64 / secs) as u64,
        net_up: (up as f64 / secs) as u64,
        uptime: System::uptime().unwrap_or(0),
        battery: battery(),
    }
}

#[cfg(windows)]
fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe { GetSystemPowerStatus(&mut status) }.ok()?;
    // 128 means there's no battery, and 255 means Windows doesn't know the level.
    if status.BatteryFlag & 128 != 0 || status.BatteryLifePercent > 100 {
        return None;
    }
    Some(Battery {
        percent: status.BatteryLifePercent,
        charging: status.ACLineStatus == 1,
    })
}

#[cfg(not(windows))]
fn battery() -> Option<Battery> {
    None
}
