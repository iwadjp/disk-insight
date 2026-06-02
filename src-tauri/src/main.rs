use disk_insight::mft_probe::{
    build_mft_tree_model_with_policy_progress,
    compute_reclaimable_summary,
    get_drive_capacity_now as read_drive_capacity_now,
    load_minimal_scan_cache,
    ArenaCache, DriveCapacity, JsonTreeNode, JsonTreeOutput, LargestItemsResult, ReclaimableSummary,
    StoragePolicy,
};
use std::collections::HashMap;
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
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

#[derive(Clone, serde::Serialize)]
struct RecycleTargetInfo {
    canonical_path: String,
    display_name: String,
    is_directory: bool,
    size_bytes: Option<u64>,
    warnings: Vec<String>,
    blocked_reason: Option<String>,
}

#[derive(serde::Serialize)]
struct RecycleResult {
    target: RecycleTargetInfo,
    moved_to_recycle_bin: bool,
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

/// Translate raw anyhow error strings from the scan path into user-readable messages.
/// Strips localized Windows OS error details (e.g. Japanese "パラメーターが間違っています。").
fn classify_scan_error(raw: String, drive: char) -> String {
    let lower = raw.to_lowercase();
    if lower.contains("not ntfs") {
        return format!(
            "Cannot scan {drive}: — this drive is not an NTFS volume. \
             disk-insight currently supports NTFS volumes only."
        );
    }
    if lower.contains("access is denied") || lower.contains("administrator") {
        return format!(
            "Access denied while scanning {drive}:. \
             Please run disk-insight as administrator, or unlock the drive first."
        );
    }
    raw
}

/// Pre-check: validate drive type and readiness before attempting raw NTFS volume access.
/// Returns a user-readable Err for drives that cannot be scanned (network, not-ready).
/// Non-NTFS drives fall through; get_mft_info reports a clear error at the FSCTL step.
fn check_drive_before_scan(drive: char) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW};
    use windows::core::PCWSTR;

    let root = format!("{}:\\", drive);
    let root_wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let root_pcwstr = PCWSTR::from_raw(root_wide.as_ptr());

    // Network drives cannot be opened as raw NTFS volumes.
    let dt = unsafe { GetDriveTypeW(root_pcwstr) };
    if dt == 4 {
        return Err(format!(
            "Drive {drive}: is a network drive. disk-insight requires \
             direct NTFS volume access and cannot scan network drives."
        ));
    }

    // GetVolumeInformationW does not require administrator rights on accessible volumes.
    // Use it to detect not-ready (no media) states before attempting the raw volume open.
    let mut serial = 0u32;
    if let Err(e) = unsafe {
        GetVolumeInformationW(root_pcwstr, None, Some(&mut serial), None, None, None)
    } {
        let msg = format!("{e}");
        if msg.contains("(os error 21)") || msg.to_lowercase().contains("not ready") {
            return Err(format!(
                "Drive {drive}: is not ready. Please check that media is inserted."
            ));
        }
        // Other pre-check failures (e.g. BitLocker-locked): let the scan proceed and report its own error.
    }

    Ok(())
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

    // Pre-check: detect unsupported or not-ready drives before attempting raw MFT access.
    check_drive_before_scan(drive_char)?;

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
        .map_err(|e| format!("scan task failed: {e}"))?
        .map_err(|raw| classify_scan_error(raw, drive_char))?;

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
fn get_drive_capacity_now(drive: String) -> Result<DriveCapacity, String> {
    let drive_char = drive
        .trim_end_matches(':')
        .chars()
        .next()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .ok_or_else(|| format!("invalid drive: {}", drive))?;

    read_drive_capacity_now(drive_char).map_err(|e| format!("{e:#}"))
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

/// Response wrapper for get_largest_items_under. Includes elapsed_ms for
/// performance measurement before UI integration (v0.5.5-B).
#[derive(serde::Serialize)]
struct LargestItemsResponse {
    folders:    Vec<JsonTreeNode>,
    files:      Vec<JsonTreeNode>,
    elapsed_ms: f64,
    limit:      usize,
}

#[tauri::command]
fn get_largest_items_under(
    state: State<'_, AppState>,
    record_index: u64,
    limit: Option<usize>,
) -> Result<LargestItemsResponse, String> {
    let limit = limit.unwrap_or(50).min(200).max(1);
    let t0 = std::time::Instant::now();
    let guard = state.arena_cache.lock()
        .map_err(|e| format!("state lock poisoned: {e}"))?;
    let cache = guard.as_ref()
        .ok_or_else(|| "Largest items requires live scan data. Run Scan first.".to_string())?;
    let result: LargestItemsResult = cache.largest_items_under(record_index, limit);
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "[perf] get_largest_items_under record_index={} limit={} folders={} files={} elapsed_ms={:.1}",
        record_index,
        limit,
        result.folders.len(),
        result.files.len(),
        elapsed_ms,
    );
    Ok(LargestItemsResponse {
        folders: result.folders,
        files: result.files,
        elapsed_ms,
        limit,
    })
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

fn normalize_path_for_compare(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('/', "\\");
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        s = stripped.to_string();
    } else if let Some(stripped) = s.strip_prefix(r"\??\") {
        s = stripped.to_string();
    }
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

fn normalize_raw_path_for_compare(path: &str) -> String {
    let mut s = path.replace('/', "\\");
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        s = stripped.to_string();
    } else if let Some(stripped) = s.strip_prefix(r"\??\") {
        s = stripped.to_string();
    }
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

fn normalize_existing_or_raw(path: PathBuf) -> String {
    match std::fs::canonicalize(&path) {
        Ok(canonical) => normalize_path_for_compare(&canonical),
        Err(_) => normalize_path_for_compare(&path),
    }
}

fn normalized_env_path(name: &str) -> Option<String> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .map(normalize_existing_or_raw)
}

fn drive_root_from_normalized(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
        && bytes[0].is_ascii_alphabetic()
    {
        Some(format!("{}:\\", (bytes[0] as char).to_ascii_uppercase()))
    } else {
        None
    }
}

fn path_depth_after_drive_root(path: &str) -> Option<usize> {
    let root = drive_root_from_normalized(path)?;
    let rest = path[root.len()..].trim_matches('\\');
    if rest.is_empty() {
        Some(0)
    } else {
        Some(rest.split('\\').filter(|part| !part.is_empty()).count())
    }
}

fn is_same_path(a: &str, b: &str) -> bool {
    normalize_raw_path_for_compare(a).to_lowercase()
        == normalize_raw_path_for_compare(b).to_lowercase()
}

fn is_same_or_child_path(target: &str, base: &str) -> bool {
    let target = normalize_raw_path_for_compare(target).to_lowercase();
    let base = normalize_raw_path_for_compare(base).to_lowercase();
    target == base || target.starts_with(&format!("{base}\\"))
}

fn block_reason_for_recycle_target(normalized_path: &str, attributes: u32) -> Option<String> {
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_SYSTEM;

    let drive_root = drive_root_from_normalized(normalized_path)?;
    let depth = path_depth_after_drive_root(normalized_path).unwrap_or(0);

    if depth == 0 {
        return Some("Drive root cannot be moved to the Recycle Bin.".to_string());
    }

    if depth < 2 {
        return Some("This path is too close to the drive root.".to_string());
    }

    if attributes & FILE_ATTRIBUTE_SYSTEM.0 != 0 {
        return Some("System-protected files and folders are blocked.".to_string());
    }

    let mut protected_subtrees = Vec::new();
    for env_name in ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"] {
        if let Some(path) = normalized_env_path(env_name) {
            protected_subtrees.push(path);
        }
    }
    protected_subtrees.push(format!("{drive_root}$Recycle.Bin"));
    protected_subtrees.push(format!("{drive_root}System Volume Information"));

    for protected in protected_subtrees {
        if is_same_or_child_path(normalized_path, &protected) {
            return Some(format!("{protected} is a protected system location."));
        }
    }

    let mut users_roots = Vec::new();
    if let Some(user_profile) = normalized_env_path("USERPROFILE") {
        if let Some(parent) = Path::new(&user_profile).parent() {
            users_roots.push(normalize_path_for_compare(parent));
        }
        if is_same_path(normalized_path, &user_profile) {
            return Some("The current user profile root is blocked.".to_string());
        }
    }
    if let Some(system_drive) = std::env::var_os("SystemDrive").filter(|v| !v.is_empty()) {
        let mut root = system_drive.to_string_lossy().replace('/', "\\");
        if !root.ends_with('\\') {
            root.push('\\');
        }
        users_roots.push(format!("{root}Users"));
    }
    users_roots.push(format!("{drive_root}Users"));

    users_roots.sort_by_key(|s| s.to_lowercase());
    users_roots.dedup_by(|a, b| is_same_path(a, b));

    for users_root in users_roots {
        if is_same_path(normalized_path, &users_root) {
            return Some("The Users profile root is blocked.".to_string());
        }
        let user_root_prefix = format!("{}\\", normalize_raw_path_for_compare(&users_root));
        let target = normalize_raw_path_for_compare(normalized_path);
        if target.to_lowercase().starts_with(&user_root_prefix.to_lowercase()) {
            let rest = &target[user_root_prefix.len()..];
            if !rest.is_empty() && !rest.contains('\\') {
                return Some("User profile roots are blocked.".to_string());
            }
        }
    }

    None
}

fn validate_recycle_target(path: &Path) -> Result<RecycleTargetInfo, String> {
    use windows::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY,
    };

    if path.as_os_str().is_empty() {
        return Err("path must not be empty".to_string());
    }

    let canonical = std::fs::canonicalize(path)
        .map_err(|e| format!("path does not exist or cannot be resolved: {e}"))?;
    let metadata = std::fs::metadata(&canonical)
        .map_err(|e| format!("failed to read target metadata: {e}"))?;
    let canonical_path = normalize_path_for_compare(&canonical);

    if drive_root_from_normalized(&canonical_path).is_none() {
        return Err("Only local drive paths are supported for Recycle Bin operations.".to_string());
    }

    let attributes = metadata.file_attributes();
    if let Some(reason) = block_reason_for_recycle_target(&canonical_path, attributes) {
        return Err(format!("Recycle Bin operation blocked: {reason}"));
    }

    let mut warnings = Vec::new();
    if attributes & FILE_ATTRIBUTE_HIDDEN.0 != 0 {
        warnings.push("Target has the hidden attribute.".to_string());
    }
    if attributes & FILE_ATTRIBUTE_READONLY.0 != 0 {
        warnings.push("Target has the read-only attribute.".to_string());
    }

    let display_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&canonical_path)
        .to_string();
    let is_directory = metadata.is_dir();
    let size_bytes = if is_directory { None } else { Some(metadata.len()) };

    Ok(RecycleTargetInfo {
        canonical_path,
        display_name,
        is_directory,
        size_bytes,
        warnings,
        blocked_reason: None,
    })
}

#[tauri::command]
fn move_to_recycle_bin(path: String) -> Result<RecycleResult, String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, IBindCtx,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IShellItem,
        SHCreateItemFromParsingName, FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO,
    };
    use windows::core::{IUnknown, PCWSTR};

    let target = validate_recycle_target(Path::new(&path))?;
    let path_wide: Vec<u16> = target
        .canonical_path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let com_hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let com_init_ok = com_hr.is_ok();

        let result = (|| -> windows::core::Result<()> {
            let op: IFileOperation =
                CoCreateInstance(&FileOperation, None::<&IUnknown>, CLSCTX_INPROC_SERVER)?;
            op.SetOperationFlags(FOF_ALLOWUNDO | FOFX_RECYCLEONDELETE | FOFX_EARLYFAILURE)?;

            let item: IShellItem = SHCreateItemFromParsingName(
                PCWSTR::from_raw(path_wide.as_ptr()),
                None::<&IBindCtx>,
            )?;
            op.DeleteItem(&item, None::<&IFileOperationProgressSink>)?;
            op.PerformOperations()?;

            if op.GetAnyOperationsAborted()?.as_bool() {
                return Err(windows::core::Error::from_win32());
            }
            Ok(())
        })();

        if com_init_ok {
            CoUninitialize();
        }

        result.map_err(|e| format!("Failed to move target to the Recycle Bin: {e}"))?;
    }

    Ok(RecycleResult {
        target,
        moved_to_recycle_bin: true,
    })
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
fn show_properties(path: String) -> Result<(), String> {
    use windows::Win32::UI::Shell::{ShellExecuteExW, SHELLEXECUTEINFOW, SEE_MASK_INVOKEIDLIST};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::core::PCWSTR;
    use std::mem;

    if path.is_empty() {
        return Err("path must not be empty".to_string());
    }
    if !Path::new(&path).exists() {
        return Err(format!("path does not exist: {path}"));
    }

    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let verb_wide: Vec<u16> = "properties".encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // SEE_MASK_INVOKEIDLIST routes through IContextMenu (bypasses file-association
        // lookup that caused SE_ERR_NOASSOC with ShellExecuteW). Requires COM STA.
        // S_FALSE = STA already active, refcount bumped — both are "init succeeded".
        // RPC_E_CHANGED_MODE = MTA active on this thread — proceed without re-init.
        let com_hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let com_init_ok = com_hr.is_ok();

        let mut sei = SHELLEXECUTEINFOW {
            cbSize: mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST,
            lpVerb: PCWSTR::from_raw(verb_wide.as_ptr()),
            lpFile: PCWSTR::from_raw(path_wide.as_ptr()),
            nShow: SW_SHOW.0,
            ..Default::default()
        };

        let result = ShellExecuteExW(&mut sei);

        if com_init_ok {
            CoUninitialize();
        }

        result.map_err(|e| format!("Failed to show properties: {e}"))?;
    }

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
            get_drive_capacity_now,
            move_to_recycle_bin,
            open_in_explorer,
            select_in_explorer,
            show_properties,
            get_children,
            search_subtree,
            get_largest_items_under,
            get_reclaimable_summary,
            list_drives,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run disk-insight UI");
}
