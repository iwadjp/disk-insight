const SAMPLE_JSON: &str = include_str!("../../public/sample/probe7.sample.json");

#[tauri::command]
fn load_sample_json() -> Result<serde_json::Value, String> {
    serde_json::from_str(SAMPLE_JSON)
        .map_err(|err| format!("failed to parse embedded sample JSON: {err}"))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![load_sample_json])
        .run(tauri::generate_context!())
        .expect("failed to run disk-insight UI");
}
