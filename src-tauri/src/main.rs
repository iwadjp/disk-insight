use disk_insight::mft_probe::{
    build_mft_tree_model_with_policy_progress,
    compute_reclaimable_summary,
    load_minimal_scan_cache,
    ArenaCache, JsonTreeNode, JsonTreeOutput, ReclaimableSummary, StoragePolicy,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, State};

#[derive(serde::Serialize)]
struct DriveInfo {
    letter: String,
    root: String,
    display: String,
    drive_type: String,
}

#[derive(serde::Serialize)]
struct CachedScanResponse {
    output: serde_json::Value,
    created_at_unix_ms: u64,
    cache_path: String,
    cache_file_size_bytes: u64,
    cache_load_ms: u64,
}

const SAMPLE_JSON: &str = include_str!("../../public/sample/probe7.sample.json");

#[derive(Clone, serde::Serialize)]
struct ScanProgressEvent {
    scan_id:    String,
    drive:      String,
    phase:      String,
    message:    String,
    elapsed_ms: u64,
    current:    Option<u64>,
    total:      Option<u64>,
    unit:       Option<&'static str>,
    segment_current: Option<u64>,
    segment_total:   Option<u64>,
}

fn phase_message(phase: &str) -> &'static str {
    match phase {
        "opening_volume"   => "Opening volume",
        "reading_mft"      => "Reading MFT (I/O)",
        "parsing_records"  => "Parsing records",
        "building_tree"    => "Building directory tree",
        "aggregating_sizes"=> "Aggregating sizes",
        "building_ui_model"=> "Preparing UI model",
        "done"             => "Done",
        _                  => "Scanning",
    }
}

// Live scan cache. scan_drive populates this on success; get_children and
// get_reclaimable_summary read from it. None means "no live scan has run in
// this session" (e.g. only the embedded sample has been loaded).
#[derive(Default)]
struct AppState {
    arena_cache:   Mutex<Option<ArenaCache>>,
    lazy_children: Mutex<Option<HashMap<u64, Vec<JsonTreeNode>>>>,
    wof_size_map:  Mutex<Option<HashMap<u64, (u64, u64)>>>,
    cancel_flag:   Mutex<Option<Arc<AtomicBool>>>,
}

#[tauri::command]
fn load_sample_json() -> Result<serde_json::Value, String> {
    serde_json::from_str(SAMPLE_JSON)
        .map_err(|e| format!("failed to parse embedded sample JSON: {e}"))
}

#[tauri::command]
fn load_scan_cache(
    drive: String,
    storage_policy: Option<String>,
) -> Result<Option<CachedScanResponse>, String> {
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

    match load_minimal_scan_cache(drive_char, policy) {
        Ok(Some(cache)) => {
            eprintln!(
                "[cache-load] cache_hit=true cache_load_ms={} cache_file_size_bytes={} cache_path={} cache_created_at={}",
                cache.cache_load_ms,
                cache.file_size_bytes,
                cache.path,
                cache.created_at_unix_ms,
            );
            Ok(Some(CachedScanResponse {
                output: cache.output,
                created_at_unix_ms: cache.created_at_unix_ms,
                cache_path: cache.path,
                cache_file_size_bytes: cache.file_size_bytes,
                cache_load_ms: cache.cache_load_ms,
            }))
        }
        Ok(None) => {
            eprintln!(
                "[cache-load] cache_hit=false drive={} policy={}",
                drive_char,
                policy.as_str()
            );
            Ok(None)
        }
        Err(e) => {
            eprintln!(
                "[cache-load-warning] cache load ignored drive={} policy={} error={e:#}",
                drive_char,
                policy.as_str()
            );
            Ok(None)
        }
    }
}

#[tauri::command]
async fn scan_drive(
    app: tauri::AppHandle,
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

    let scan_id = format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    eprintln!(
        "[perf-tauri] scan_drive start  drive={} top={} policy={} scan_id={}",
        drive_char, top_n, policy.as_str(), scan_id
    );

    // ── Per-scan cancel flag ──────────────────────────────────────────────────
    let cancel = Arc::new(AtomicBool::new(false));
    match state.cancel_flag.lock() {
        Ok(mut guard) => *guard = Some(Arc::clone(&cancel)),
        Err(e) => eprintln!("[cancel] cancel_flag lock poisoned at scan start: {e}"),
    }

    let drive_str = format!("{}:", drive_char);
    let scan_id_cb = scan_id.clone();
    let drive_str_cb = drive_str.clone();
    let app_cb = app.clone();
    let cancel_cb = Arc::clone(&cancel);

    let spawn_start = std::time::Instant::now();
    let spawn_result = tauri::async_runtime::spawn_blocking(move || {
        build_mft_tree_model_with_policy_progress(drive_char, top_n, policy, &cancel_cb, |progress| {
            let event = ScanProgressEvent {
                scan_id:    scan_id_cb.clone(),
                drive:      drive_str_cb.clone(),
                phase:      progress.phase.to_string(),
                message:    phase_message(progress.phase).to_string(),
                elapsed_ms: progress.elapsed_ms,
                current:    progress.current,
                total:      progress.total,
                unit:       progress.unit,
                segment_current: progress.segment_current,
                segment_total:   progress.segment_total,
            };
            let _ = app_cb.emit("scan_progress", &event);
        }).map_err(|e| format!("{e:#}"))
    })
    .await;

    // ── Clear cancel flag regardless of outcome ───────────────────────────────
    if let Ok(mut guard) = state.cancel_flag.lock() {
        *guard = None;
    }

    let model = spawn_result
        .map_err(|e| format!("scan task failed: {e}"))??;

    let spawn_ms = spawn_start.elapsed().as_millis();
    eprintln!(
        "[perf-tauri] build_model done  {} ms  root_children={} top_dirs={} top_files={}  arena_cache_ms={} ms",
        spawn_ms,
        model.output.root_children.len(),
        model.output.top_directories.len(),
        model.output.top_files.len(),
        model.output.summary.children_map_time_ms,
    );

    // ── Final cancel check before committing to AppState ─────────────────────
    // Handles the race where cancel_scan arrives just as the scan completes.
    if cancel.load(Ordering::Relaxed) {
        eprintln!("[perf-tauri] scan completed but was cancelled — discarding result");
        return Err("Scan cancelled".to_string());
    }

    let output      = model.output;
    let arena_cache = model.arena_cache;
    let wof_size_map = model.wof_size_map;

    {
        let cache_lock_start = std::time::Instant::now();
        {
            let mut guard = state
                .arena_cache
                .lock()
                .map_err(|e| format!("state lock poisoned: {e}"))?;
            *guard = Some(arena_cache);
        }
        let cache_lock_ms = cache_lock_start.elapsed().as_millis();

        // Clear stale lazy_children from any previous scan.
        {
            let mut guard = state
                .lazy_children
                .lock()
                .map_err(|e| format!("state lock poisoned: {e}"))?;
            *guard = None;
        }

        let wof_lock_start = std::time::Instant::now();
        {
            let mut guard = state
                .wof_size_map
                .lock()
                .map_err(|e| format!("state lock poisoned: {e}"))?;
            *guard = Some(wof_size_map);
        }
        let wof_lock_ms = wof_lock_start.elapsed().as_millis();

        eprintln!(
            "[perf-tauri] state_lock  arena_cache={} ms  wof_size_map={} ms",
            cache_lock_ms, wof_lock_ms
        );
    }

    let cmd_ms = cmd_start.elapsed().as_millis();
    eprintln!("[perf-tauri] scan_drive return  total={} ms", cmd_ms);

    Ok(output)
}

#[tauri::command]
fn cancel_scan(state: State<'_, AppState>) {
    if let Ok(guard) = state.cancel_flag.lock() {
        if let Some(flag) = guard.as_ref() {
            flag.store(true, Ordering::Relaxed);
            eprintln!("[cancel] cancel requested");
        }
    }
}

#[tauri::command]
fn get_children(
    state: State<'_, AppState>,
    parent_record_index: u64,
) -> Result<Vec<JsonTreeNode>, String> {
    // Fast path: serve from lazy cache if this FRN was already expanded.
    {
        let guard = state.lazy_children.lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        if let Some(map) = guard.as_ref() {
            if let Some(children) = map.get(&parent_record_index) {
                return Ok(children.clone());
            }
        }
    }

    // Cache miss: build paths on demand from ArenaCache.
    let children = {
        let guard = state.arena_cache.lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.as_ref()
            .ok_or_else(|| "No live scan data. Run Scan first.".to_string())?
            .get_children_for(parent_record_index)
    };

    // Store result in lazy cache for future calls to this FRN.
    {
        let mut guard = state.lazy_children.lock()
            .map_err(|e| format!("state lock poisoned: {e}"))?;
        guard.get_or_insert_with(HashMap::new)
            .entry(parent_record_index)
            .or_insert_with(|| children.clone());
    }

    Ok(children)
}

#[tauri::command]
fn search_subtree(
    state: State<'_, AppState>,
    parent_record_index: u64,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<JsonTreeNode>, String> {
    let q = query.trim();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    // Root search disabled: NTFS root directory has FRN 5.
    if parent_record_index == 5 {
        return Err("Select a folder below the drive root to search.".to_string());
    }
    let max = max_results.unwrap_or(200).min(200);
    let guard = state.arena_cache.lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    let cache = guard.as_ref()
        .ok_or_else(|| "Search requires live scan data.".to_string())?;
    Ok(cache.search_subtree(parent_record_index, q, max))
}

#[tauri::command]
fn get_reclaimable_summary(
    state: State<'_, AppState>,
    record_index: u64,
    path: String,
    _drive: String,
) -> Result<ReclaimableSummary, String> {
    let guard = state
        .wof_size_map
        .lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    let map = guard.as_ref().ok_or("No live scan data. Run Scan first.")?;
    let (current, wof_adjusted) = map
        .get(&record_index)
        .copied()
        .ok_or_else(|| format!("record_index {} not found in wof_size_map", record_index))?;
    let wof_ratio = if current > 0 {
        (current as f64 - wof_adjusted as f64).abs() / current as f64
    } else {
        0.0
    };
    Ok(compute_reclaimable_summary(&path, current, wof_adjusted, wof_ratio, None))
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
            load_scan_cache,
            scan_drive,
            cancel_scan,
            open_in_explorer,
            select_in_explorer,
            get_children,
            search_subtree,
            get_reclaimable_summary,
            list_drives,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run disk-insight UI");
}
