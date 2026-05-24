use disk_insight::mft_probe::{build_mft_tree_model, JsonTreeNode, JsonTreeOutput};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::State;

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
) -> Result<JsonTreeOutput, String> {
    let top_n = top.unwrap_or(100).max(1);
    let drive_char = drive
        .trim_end_matches(':')
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .ok_or_else(|| format!("invalid drive: {}", drive))?;

    let model = tauri::async_runtime::spawn_blocking(move || {
        build_mft_tree_model(drive_char, top_n).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("scan task failed: {e}"))??;

    {
        let mut guard = state
            .children_map
            .lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        *guard = Some(model.children_map);
    }
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

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            load_sample_json,
            scan_drive,
            open_in_explorer,
            select_in_explorer,
            get_children,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run disk-insight UI");
}
