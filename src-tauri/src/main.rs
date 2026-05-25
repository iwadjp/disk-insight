use disk_insight::mft_probe::{build_mft_tree_model_with_policy, JsonTreeNode, JsonTreeOutput, StoragePolicy};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

#[derive(serde::Serialize)]
struct DriveInfo {
    letter: String,
    root: String,
    display: String,
    drive_type: String,
}

const SAMPLE_JSON: &str = include_str!("../../public/sample/probe7.sample.json");

// Live scan cache. scan_drive populates this on success; get_children reads
// from it. None means "no live scan has run in this session" (e.g. only the
// embedded sample has been loaded, or the app just started).
#[derive(Default)]
struct AppState {
    children_map: Mutex<Option<HashMap<u64, Vec<JsonTreeNode>>>>,
}

#[tauri::command]
fn load_sample_json() -> Result<serde_json::Value, String> {
    serde_json::from_str(SAMPLE_JSON)
        .map_err(|e| format!("failed to parse embedded sample JSON: {e}"))
}

#[tauri::command]
async fn scan_drive(
    state: State<'_, AppState>,
    drive: String,
    top: Option<usize>,
    storage_policy: Option<String>,
) -> Result<JsonTreeOutput, String> {
    let cmd_start = std::time::Instant::now();
    let top_n = top.unwrap_or(100).max(1);
    let drive_char = drive
        .trim_end_matches(':')
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .ok_or_else(|| format!("invalid drive: {}", drive))?;

    let policy = match storage_policy.as_deref() {
        Some("wof_adjusted") => StoragePolicy::WofAdjusted,
        _ => StoragePolicy::Current,
    };

    eprintln!(
        "[perf-tauri] scan_drive start  drive={} top={} policy={}",
        drive_char, top_n, policy.as_str()
    );

    let spawn_start = std::time::Instant::now();
    let model = tauri::async_runtime::spawn_blocking(move || {
        build_mft_tree_model_with_policy(drive_char, top_n, policy).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("scan task failed: {e}"))??;

    let spawn_ms = spawn_start.elapsed().as_millis();
    eprintln!(
        "[perf-tauri] build_model done  {} ms  root_children={} top_dirs={} top_files={}",
        spawn_ms,
        model.output.root_children.len(),
        model.output.top_directories.len(),
        model.output.top_files.len()
    );

    {
        let lock_start = std::time::Instant::now();
        let mut guard = state
            .children_map
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        *guard = Some(model.children_map);
        eprintln!("[perf-tauri] state_lock  {} ms", lock_start.elapsed().as_millis());
    }

    let cmd_ms = cmd_start.elapsed().as_millis();
    eprintln!("[perf-tauri] scan_drive return  total={} ms", cmd_ms);

    Ok(model.output)
}

#[tauri::command]
fn get_children(
    state: State<'_, AppState>,
    parent_record_index: u64,
) -> Result<Vec<JsonTreeNode>, String> {
    let guard = state
        .children_map
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    match guard.as_ref() {
        Some(map) => Ok(map.get(&parent_record_index).cloned().unwrap_or_default()),
        None => Err("No live scan data is loaded. Run Scan first.".to_string()),
    }
}

#[tauri::command]
fn open_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    std::process::Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("failed to open Explorer: {e}"))?;
    Ok(())
}

#[tauri::command]
fn select_in_explorer(path: String) -> Result<(), String> {
    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path))
        .spawn()
        .map_err(|e| format!("failed to select file in Explorer: {e}"))?;
    Ok(())
}

#[tauri::command]
fn list_drives() -> Vec<DriveInfo> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows::core::PCWSTR;

    let mut drives = Vec::new();
    let mask = unsafe { GetLogicalDrives() };

    for i in 0u32..26 {
        if mask & (1 << i) != 0 {
            let letter = char::from(b'A' + i as u8);
            let root = format!("{}:\\", letter);
            let display = format!("{}:", letter);
            let root_wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
            let dt = unsafe { GetDriveTypeW(PCWSTR::from_raw(root_wide.as_ptr())) };
            let drive_type = match dt {
                2 => "removable",
                3 => "fixed",
                4 => "remote",
                5 => "cdrom",
                6 => "ramdisk",
                _ => "unknown",
            }
            .to_string();
            drives.push(DriveInfo { letter: letter.to_string(), root, display, drive_type });
        }
    }
    drives
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_sample_json,
            scan_drive,
            open_in_explorer,
            select_in_explorer,
            get_children,
            list_drives,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run disk-insight UI");
}
