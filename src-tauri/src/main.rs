use disk_insight::mft_probe::{build_mft_tree_output, JsonTreeOutput};

const SAMPLE_JSON: &str = include_str!("../../public/sample/probe7.sample.json");

#[tauri::command]
fn load_sample_json() -> Result<serde_json::Value, String> {
    serde_json::from_str(SAMPLE_JSON)
        .map_err(|e| format!("failed to parse embedded sample JSON: {e}"))
}

#[tauri::command]
async fn scan_drive(drive: String, top: Option<usize>) -> Result<JsonTreeOutput, String> {
    let top_n = top.unwrap_or(100).max(1);
    let drive_char = drive
        .trim_end_matches(':')
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .ok_or_else(|| format!("invalid drive: {}", drive))?;

    tauri::async_runtime::spawn_blocking(move || {
        build_mft_tree_output(drive_char, top_n).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| format!("scan task failed: {e}"))?
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_sample_json, scan_drive])
        .run(tauri::generate_context!())
        .expect("failed to run disk-insight UI");
}
