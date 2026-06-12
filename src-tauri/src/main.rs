#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod dispatch;

use chrono::{Datelike, Local, Timelike, Weekday};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use notify::{RecommendedWatcher, Watcher, RecursiveMode, Config as NotifyConfig};
use tauri::Emitter;

// ── Path helpers ──────────────────────────────────────────────────────────────

fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()))
}

fn brain_root() -> PathBuf {
    home_dir().join("Desktop").join("CD_claude")
}

fn app_data_dir() -> PathBuf {
    home_dir().join("Library/Application Support/com.connordore.antfarm")
}

// ── Event store ───────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct RawAntfarmEvent {
    session_id: Option<String>,
    hook_event_name: Option<String>,
    cwd: Option<String>,
    notification_type: Option<String>,
}

#[derive(Clone)]
struct EventDerivedStatus {
    status: String,
    project_slug: Option<String>,
    attention: bool,
}

struct EventsStateInner {
    sessions: HashMap<String, EventDerivedStatus>,
}

struct EventsState(Arc<Mutex<EventsStateInner>>);

fn events_file_path() -> PathBuf {
    home_dir().join(".antfarm/events.jsonl")
}

fn offset_path() -> PathBuf {
    app_data_dir().join("events_offset.json")
}

fn load_offset() -> u64 {
    fs::read_to_string(offset_path())
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .and_then(|v| v.get("offset").and_then(|o| o.as_u64()))
        .unwrap_or(0)
}

fn save_offset(offset: u64) {
    let _ = fs::create_dir_all(app_data_dir());
    let _ = fs::write(offset_path(), format!("{{\"offset\":{}}}", offset));
}

fn match_cwd_to_slug_ci(cwd: &str, registry: &Registry) -> Option<String> {
    let basename = Path::new(cwd).file_name()?.to_str()?.to_lowercase();
    for (slug, proj) in &registry.projects {
        for repo in &proj.repos {
            if repo.to_lowercase() == basename {
                return Some(slug.clone());
            }
        }
    }
    None
}

fn process_events_file(store: &Arc<Mutex<EventsStateInner>>, registry: &Registry) {
    let path = events_file_path();
    let file_size = match fs::metadata(&path) {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    let mut offset = load_offset();
    if file_size < offset {
        eprintln!("antfarm events: file shrank ({} < {}), resetting offset to 0", file_size, offset);
        offset = 0;
        save_offset(0);
    }
    if file_size == offset {
        return;
    }
    let Ok(mut f) = fs::File::open(&path) else { return };
    if offset > 0 && f.seek(SeekFrom::Start(offset)).is_err() {
        return;
    }
    let mut raw = Vec::new();
    let Ok(bytes_read) = f.read_to_end(&mut raw) else { return };
    let new_offset = offset + bytes_read as u64;
    let text = String::from_utf8_lossy(&raw);
    {
        let mut guard = store.lock().unwrap();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() { continue; }
            let ev: RawAntfarmEvent = match serde_json::from_str(line) {
                Ok(e) => e,
                Err(_) => continue,
            };
            let (Some(sid), Some(hook)) = (&ev.session_id, &ev.hook_event_name) else { continue };
            let status = match hook.as_str() {
                "SessionStart" => "running",
                "Stop" => "idle",
                "SessionEnd" => "done",
                "Notification" => match ev.notification_type.as_deref() {
                    Some("permission_prompt") => "needs_permission",
                    _ => "idle", // idle_prompt: muted, no alert
                },
                _ => continue,
            };
            let project_slug = ev.cwd.as_deref()
                .and_then(|c| match_cwd_to_slug_ci(c, registry));
            let attention = status == "needs_permission";
            guard.sessions.insert(sid.clone(), EventDerivedStatus {
                status: status.to_string(),
                project_slug,
                attention,
            });
        }
    }
    save_offset(new_offset);
}

fn spawn_events_watcher(app: tauri::AppHandle, store: Arc<Mutex<EventsStateInner>>) {
    let offset = load_offset();
    eprintln!("antfarm events: starting, resuming from offset={}", offset);
    {
        let registry = load_registry();
        process_events_file(&store, &registry);
    }
    std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(
            move |res| { let _ = tx.send(res); },
            NotifyConfig::default(),
        ) {
            Ok(w) => w,
            Err(e) => { eprintln!("antfarm events: watcher init failed: {e}"); return; }
        };
        let watch_dir = home_dir().join(".antfarm");
        if let Err(e) = watcher.watch(&watch_dir, RecursiveMode::NonRecursive) {
            eprintln!("antfarm events: watch failed: {e}");
            return;
        }
        eprintln!("antfarm events: watching {:?}", watch_dir);
        let target = events_file_path();
        for result in &rx {
            match result {
                Ok(event) if event.paths.iter().any(|p| p == &target) => {
                    let reg = load_registry();
                    process_events_file(&store, &reg);
                    let _ = app.emit("antfarm-events-updated", ());
                }
                Err(e) => eprintln!("antfarm events: watch error: {e}"),
                _ => {}
            }
        }
    });
}

// ── Registry ──────────────────────────────────────────────────────────────────

#[derive(Deserialize, Default, Clone)]
struct RegistryProject {
    #[serde(default)]
    repos: Vec<String>,
}

#[derive(Deserialize, Default, Clone)]
struct Registry {
    #[serde(default)]
    projects: HashMap<String, RegistryProject>,
}

fn load_registry() -> Registry {
    match fs::read_to_string(brain_root().join("ant-farm-registry.json")) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_default(),
        Err(_) => Registry::default(),
    }
}

// ── File helpers ──────────────────────────────────────────────────────────────

fn mtime_secs(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().and_then(|m| {
        m.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs()))
    })
}

fn newest_mtime(dir: &Path) -> Option<u64> {
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return mtime_secs(dir),
    };
    let mut best = mtime_secs(dir);
    for entry in rd.flatten() {
        let p = entry.path();
        let t = if p.is_dir() { newest_mtime(&p) } else { mtime_secs(&p) };
        match (best, t) {
            (None, Some(v)) => best = Some(v),
            (Some(a), Some(b)) if b > a => best = Some(b),
            _ => {}
        }
    }
    best
}

fn count_bullets(path: &Path) -> usize {
    match fs::read_to_string(path) {
        Ok(c) => c
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                t.starts_with("- ") || t.starts_with("* ")
            })
            .count(),
        Err(_) => 0,
    }
}

fn extract_h1(readme: &Path, fallback: &str) -> String {
    match fs::read_to_string(readme) {
        Ok(c) => {
            for line in c.lines() {
                if let Some(rest) = line.trim().strip_prefix("# ") {
                    let name = rest.trim().to_string();
                    if !name.is_empty() {
                        return name;
                    }
                }
            }
            fallback.to_string()
        }
        Err(_) => fallback.to_string(),
    }
}

fn extract_status(readme: &Path) -> Option<String> {
    match fs::read_to_string(readme) {
        Ok(c) => {
            for line in c.lines() {
                if let Some(rest) = line.trim().strip_prefix("Status:") {
                    let s = rest.trim().to_string();
                    if !s.is_empty() {
                        return Some(s);
                    }
                }
            }
            None
        }
        Err(_) => None,
    }
}

// ── Project list command ──────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Debug, Clone)]
struct Project {
    slug: String,
    name: String,
    status: Option<String>,
    last_activity: Option<u64>,
    idea_count: usize,
    decision_count: usize,
    repos: Vec<String>,
}

#[tauri::command]
fn list_projects() -> Vec<Project> {
    let tools_dir = brain_root().join("tools-built");
    let registry = load_registry();
    let rd = match fs::read_dir(&tools_dir) {
        Ok(r) => r,
        Err(_) => return vec![],
    };
    let mut projects: Vec<Project> = rd
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let slug = path.file_name()?.to_string_lossy().to_string();
            let readme = path.join("README.md");
            Some(Project {
                name: extract_h1(&readme, &slug),
                status: extract_status(&readme),
                last_activity: newest_mtime(&path),
                idea_count: count_bullets(&path.join("ideas.md")),
                decision_count: count_bullets(&path.join("decisions.md")),
                repos: registry
                    .projects
                    .get(&slug)
                    .map(|p| p.repos.clone())
                    .unwrap_or_default(),
                slug,
            })
        })
        .collect();
    projects.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    projects
}

// ── Project detail command ────────────────────────────────────────────────────

#[derive(Serialize, Debug, Clone)]
struct ProjectDetail {
    slug: String,
    name: String,
    status: Option<String>,
    last_activity: Option<u64>,
    repos: Vec<String>,
    readme: Option<String>,
    ideas: Option<String>,
    notes_files: Vec<String>,
}

#[tauri::command]
fn get_project_detail(slug: String) -> Option<ProjectDetail> {
    let project_dir = brain_root().join("tools-built").join(&slug);
    if !project_dir.is_dir() {
        return None;
    }
    let registry = load_registry();
    let readme_path = project_dir.join("README.md");
    let readme = fs::read_to_string(&readme_path).ok();
    let ideas = fs::read_to_string(project_dir.join("ideas.md")).ok();

    let notes_dir = project_dir.join("notes");
    let notes_files = if notes_dir.is_dir() {
        fs::read_dir(&notes_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.is_file() {
                    p.file_name().map(|n| n.to_string_lossy().into_owned())
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec![]
    };

    Some(ProjectDetail {
        name: extract_h1(&readme_path, &slug),
        status: extract_status(&readme_path),
        last_activity: newest_mtime(&project_dir),
        repos: registry
            .projects
            .get(&slug)
            .map(|p| p.repos.clone())
            .unwrap_or_default(),
        readme,
        ideas,
        notes_files,
        slug,
    })
}

#[tauri::command]
fn get_file_content(slug: String, filename: String) -> Option<String> {
    // Guard against path traversal
    if filename.contains('/') || filename.contains('\\') || filename.starts_with('.') {
        return None;
    }
    let path = brain_root()
        .join("tools-built")
        .join(&slug)
        .join("notes")
        .join(&filename);
    fs::read_to_string(&path).ok()
}

// ── Settings ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Settings {
    weekly_cap_tokens: u64,
    reset_weekday: u8, // 0=Mon … 6=Sun
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            weekly_cap_tokens: 100_000_000,
            reset_weekday: 0,
        }
    }
}

fn settings_path() -> PathBuf {
    app_data_dir().join("settings.json")
}

#[tauri::command]
fn get_settings() -> Settings {
    match fs::read_to_string(settings_path()) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_default(),
        Err(_) => Settings::default(),
    }
}

#[tauri::command]
fn save_settings(settings: Settings) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(settings_path(), json).map_err(|e| e.to_string())
}

// ── Usage rollup ──────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
struct DayBucket {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    est_dollars: f64,
}

impl DayBucket {
    fn total_tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache_write
    }
    fn add(&mut self, other: &DayBucket) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.est_dollars += other.est_dollars;
    }
}

#[derive(Serialize, Deserialize)]
struct FileCacheEntry {
    mtime: u64,
    size: u64,
    days: HashMap<String, DayBucket>,
}

#[derive(Serialize, Deserialize, Default)]
struct UsageCache {
    version: u8,
    files: HashMap<String, FileCacheEntry>,
}

#[derive(Serialize, Clone)]
struct DayUsage {
    date: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    est_dollars: f64,
    total_tokens: u64,
}

#[derive(Serialize, Clone)]
struct ProjectUsage {
    slug: String,
    name: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    est_dollars: f64,
    total_tokens: u64,
}

#[derive(Serialize)]
struct WeekTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    est_dollars: f64,
    total_tokens: u64,
    week_start: String,
    today: String,
    days_until_reset: u8,
}

#[derive(Serialize)]
struct UsageRollup {
    days: Vec<DayUsage>,
    week: WeekTotals,
    by_project: Vec<ProjectUsage>,
    cached_files: usize,
    parsed_files: usize,
}

// Named rate table — easy to retune. Returns (input_rate, output_rate) per 1M tokens.
// Cache multipliers are applied from the model's input_rate in est_dollars_for().
fn model_rates(model: &str) -> (f64, f64) {
    match model {
        "claude-opus-4-8"  => (5.0,  25.0),
        "claude-sonnet-4-6" => (3.0, 15.0),
        _                  => (4.0,  20.0), // blended fallback for unknown/future models
    }
}

fn est_dollars_for(model: &str, input: u64, output: u64, cache_read: u64, cache_write: u64) -> f64 {
    if model == "<synthetic>" {
        return 0.0;
    }
    let (ir, or_) = model_rates(model);
    // Cache multipliers applied to the model's own input rate per message
    (input      as f64 * ir * 1.00   // input_tokens        → input_rate × 1.0
        + output      as f64 * or_       // output_tokens       → output_rate
        + cache_read  as f64 * ir * 0.10 // cache_read          → input_rate × 0.10
        + cache_write as f64 * ir * 1.25 // cache_creation      → input_rate × 1.25
    ) / 1_000_000.0
}

fn match_dir_to_slug(dir_name: &str, registry: &Registry) -> String {
    // Match transcript dir like "-Users-foo-Desktop-roast-dash" to a project slug.
    // Strategy: find the registry repo whose "-{repo}" is a suffix of dir_name.
    // Take the longest suffix match to avoid ambiguity.
    let mut best: Option<(usize, String)> = None;
    for (slug, proj) in &registry.projects {
        for repo in &proj.repos {
            let suffix = format!("-{}", repo);
            if dir_name.ends_with(&suffix) {
                let len = suffix.len();
                if best.as_ref().map(|(l, _)| len > *l).unwrap_or(true) {
                    best = Some((len, slug.clone()));
                }
            }
        }
    }
    best.map(|(_, s)| s).unwrap_or_else(|| "unfiled".to_string())
}

fn parse_jsonl_file(path: &Path) -> HashMap<String, DayBucket> {
    let mut days: HashMap<String, DayBucket> = HashMap::new();
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return days,
    };
    for line in content.lines() {
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if obj.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let msg = match obj.get("message").and_then(|m| m.as_object()) {
            Some(m) => m,
            None => continue,
        };
        let usage = match msg.get("usage").and_then(|u| u.as_object()) {
            Some(u) => u,
            None => continue,
        };
        let model = msg
            .get("model")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown");
        let input = usage
            .get("input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let output = usage
            .get("output_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_write = usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        // Cowork audit.jsonl uses "_audit_timestamp"; CC uses "timestamp"
        let timestamp = match obj
            .get("timestamp")
            .or_else(|| obj.get("_audit_timestamp"))
            .and_then(|t| t.as_str())
            .filter(|t| t.len() >= 10)
        {
            Some(t) => t,
            None => continue,
        };
        let date = timestamp[..10].to_string();
        let est = est_dollars_for(model, input, output, cache_read, cache_write);
        let bucket = days.entry(date).or_default();
        bucket.input += input;
        bucket.output += output;
        bucket.cache_read += cache_read;
        bucket.cache_write += cache_write;
        bucket.est_dollars += est;
    }
    days
}

fn slug_to_name(slug: &str, _registry: &Registry) -> String {
    // Best-effort human name: look for a README in tools-built
    let readme = brain_root()
        .join("tools-built")
        .join(slug)
        .join("README.md");
    if readme.exists() {
        let name = extract_h1(&readme, slug);
        if name != slug {
            return name;
        }
    }
    // Fallback: prettify slug
    slug.replace('-', " ")
        .split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn weekday_to_dow(wd: Weekday) -> u8 {
    match wd {
        Weekday::Mon => 0,
        Weekday::Tue => 1,
        Weekday::Wed => 2,
        Weekday::Thu => 3,
        Weekday::Fri => 4,
        Weekday::Sat => 5,
        Weekday::Sun => 6,
    }
}

#[tauri::command]
fn usage_rollup() -> UsageRollup {
    let settings = get_settings();
    let registry = load_registry();
    let today = Local::now();
    let today_str = today.format("%Y-%m-%d").to_string();
    let today_dow = weekday_to_dow(today.weekday());
    let reset_dow = settings.reset_weekday.min(6);

    // Days since week start
    let days_since_reset = ((today_dow + 7 - reset_dow) % 7) as i64;
    let days_until_reset = if days_since_reset == 0 { 0u8 } else { (7 - days_since_reset) as u8 };
    let week_start = (today - chrono::Duration::days(days_since_reset))
        .format("%Y-%m-%d")
        .to_string();

    // Load incremental cache
    let data_dir = app_data_dir();
    let _ = fs::create_dir_all(&data_dir);
    let cache_path = data_dir.join("usage_cache.json");
    let mut cache: UsageCache = fs::read_to_string(&cache_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    let mut cached_files = 0usize;
    let mut parsed_files = 0usize;

    // Accumulate: project_slug → date → DayBucket
    let mut by_project_day: HashMap<String, HashMap<String, DayBucket>> = HashMap::new();

    let claude_projects = home_dir().join(".claude/projects");
    if let Ok(rd) = fs::read_dir(&claude_projects) {
        for entry in rd.flatten() {
            let proj_dir = entry.path();
            if !proj_dir.is_dir() {
                continue;
            }
            let dir_name = proj_dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let slug = match_dir_to_slug(&dir_name, &registry);

            if let Ok(files) = fs::read_dir(&proj_dir) {
                for fentry in files.flatten() {
                    let fpath = fentry.path();
                    if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    let fpath_str = fpath.to_string_lossy().into_owned();
                    let meta = match fs::metadata(&fpath) {
                        Ok(m) => m,
                        Err(_) => continue,
                    };
                    let fmtime = meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let fsize = meta.len();

                    // Check cache
                    let cached = cache.files.get(&fpath_str);
                    let days_data = if cached
                        .map(|e| e.mtime == fmtime && e.size == fsize)
                        .unwrap_or(false)
                    {
                        cached_files += 1;
                        eprintln!("cache hit: {}", fpath_str);
                        cached.unwrap().days.clone()
                    } else {
                        parsed_files += 1;
                        let days = parse_jsonl_file(&fpath);
                        cache.files.insert(
                            fpath_str.clone(),
                            FileCacheEntry {
                                mtime: fmtime,
                                size: fsize,
                                days: days.clone(),
                            },
                        );
                        days
                    };

                    let proj_map = by_project_day.entry(slug.clone()).or_default();
                    for (date, bucket) in &days_data {
                        proj_map.entry(date.clone()).or_default().add(bucket);
                    }
                }
            }
        }
    }

    // ── Cowork audit.jsonl files ──────────────────────────────────────────────
    // Each session companion dir contains audit.jsonl with the same usage shape as CC.
    let cowork_base = home_dir()
        .join("Library/Application Support/Claude/local-agent-mode-sessions");
    if let Ok(space_dirs) = fs::read_dir(&cowork_base) {
        for space_entry in space_dirs.flatten() {
            let space_dir = space_entry.path();
            if !space_dir.is_dir() {
                continue;
            }
            if let Ok(ws_dirs) = fs::read_dir(&space_dir) {
                for ws_entry in ws_dirs.flatten() {
                    let ws_dir = ws_entry.path();
                    if !ws_dir.is_dir() {
                        continue;
                    }
                    if let Ok(session_dirs) = fs::read_dir(&ws_dir) {
                        for sd_entry in session_dirs.flatten() {
                            let sd = sd_entry.path();
                            let sd_name = sd
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("");
                            if !sd.is_dir() || !sd_name.starts_with("local_") {
                                continue;
                            }
                            let audit = sd.join("audit.jsonl");
                            if !audit.is_file() {
                                continue;
                            }

                            // Resolve project slug from sibling .json metadata
                            let meta_path = ws_dir.join(format!("{}.json", sd_name));
                            let slug = fs::read_to_string(&meta_path)
                                .ok()
                                .and_then(|c| {
                                    serde_json::from_str::<serde_json::Value>(&c).ok()
                                })
                                .and_then(|v| {
                                    v.get("userSelectedFolders")
                                        .and_then(|f| f.as_array())
                                        .and_then(|a| a.first())
                                        .and_then(|s| s.as_str())
                                        .and_then(|rp| Path::new(rp).file_name())
                                        .and_then(|n| n.to_str())
                                        .and_then(|bn| {
                                            match_basename_to_slug(bn, &registry)
                                        })
                                })
                                .unwrap_or_else(|| "unfiled".to_string());

                            let fpath_str = audit.to_string_lossy().into_owned();
                            let Ok(meta) = fs::metadata(&audit) else {
                                continue;
                            };
                            let fmtime = meta
                                .modified()
                                .ok()
                                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            let fsize = meta.len();

                            let cached = cache.files.get(&fpath_str);
                            let days_data = if cached
                                .map(|e| e.mtime == fmtime && e.size == fsize)
                                .unwrap_or(false)
                            {
                                cached_files += 1;
                                cached.unwrap().days.clone()
                            } else {
                                parsed_files += 1;
                                let days = parse_jsonl_file(&audit);
                                cache.files.insert(
                                    fpath_str.clone(),
                                    FileCacheEntry {
                                        mtime: fmtime,
                                        size: fsize,
                                        days: days.clone(),
                                    },
                                );
                                days
                            };

                            let proj_map = by_project_day.entry(slug).or_default();
                            for (date, bucket) in &days_data {
                                proj_map.entry(date.clone()).or_default().add(bucket);
                            }
                        }
                    }
                }
            }
        }
    }

    // Save updated cache
    if let Ok(json) = serde_json::to_string(&cache) {
        let _ = fs::write(&cache_path, json);
    }

    // Aggregate all days across all projects
    let mut all_days: HashMap<String, DayBucket> = HashMap::new();
    for proj_days in by_project_day.values() {
        for (date, bucket) in proj_days {
            all_days.entry(date.clone()).or_default().add(bucket);
        }
    }

    // Build days vec: last 14 days (newest first for computation, sorted asc for display)
    let cutoff = (today - chrono::Duration::days(13))
        .format("%Y-%m-%d")
        .to_string();
    let mut days_vec: Vec<DayUsage> = all_days
        .iter()
        .filter(|(d, _)| d.as_str() >= cutoff.as_str())
        .map(|(date, b)| DayUsage {
            date: date.clone(),
            input: b.input,
            output: b.output,
            cache_read: b.cache_read,
            cache_write: b.cache_write,
            est_dollars: b.est_dollars,
            total_tokens: b.total_tokens(),
        })
        .collect();
    days_vec.sort_by(|a, b| a.date.cmp(&b.date));

    // Week totals
    let week = {
        let mut w = DayBucket::default();
        for (date, bucket) in &all_days {
            if date.as_str() >= week_start.as_str() {
                w.add(bucket);
            }
        }
        WeekTotals {
            input: w.input,
            output: w.output,
            cache_read: w.cache_read,
            cache_write: w.cache_write,
            est_dollars: w.est_dollars,
            total_tokens: w.total_tokens(),
            week_start: week_start.clone(),
            today: today_str,
            days_until_reset,
        }
    };

    // Per-project rollup (all time, sorted by est_dollars desc)
    let mut by_project: Vec<ProjectUsage> = by_project_day
        .iter()
        .map(|(slug, proj_days)| {
            let mut total = DayBucket::default();
            for b in proj_days.values() {
                total.add(b);
            }
            let name = if slug == "unfiled" {
                "Unfiled".to_string()
            } else {
                slug_to_name(slug, &registry)
            };
            ProjectUsage {
                slug: slug.clone(),
                name,
                input: total.input,
                output: total.output,
                cache_read: total.cache_read,
                cache_write: total.cache_write,
                est_dollars: total.est_dollars,
                total_tokens: total.total_tokens(),
            }
        })
        .collect();
    by_project.sort_by(|a, b| b.est_dollars.partial_cmp(&a.est_dollars).unwrap());

    UsageRollup {
        days: days_vec,
        week,
        by_project,
        cached_files,
        parsed_files,
    }
}

// ── Sessions ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Default)]
struct TokenTotals {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    est_dollars: f64,
}

#[derive(Serialize, Clone)]
struct SessionMeta {
    id: String,
    provider: String,           // "claude-code" | "cowork"
    repo_path: Option<String>,
    title: Option<String>,
    started_at: Option<u64>,    // unix secs
    last_activity: u64,         // unix secs
    token_totals: Option<TokenTotals>,
    status: String,             // "running" | "idle" | "needs_permission" | "waiting" | "done"
    project_slug: Option<String>,
    attention: bool,            // true when status is needs_permission or waiting
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn session_status(last_activity_secs: u64, has_live: bool) -> &'static str {
    let now = now_unix();
    let age = now.saturating_sub(last_activity_secs);
    if has_live && age < 120 {
        "running"
    } else if has_live && age < 600 {
        "waiting"
    } else if last_activity_secs >= (now / 86400) * 86400 {
        "idle"
    } else {
        "done"
    }
}

fn count_live_claude() -> usize {
    std::process::Command::new("ps")
        .args(["ax", "-o", "comm="])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| {
                    let t = l.trim();
                    t == "claude" || t.ends_with("/claude")
                })
                .count()
        })
        .unwrap_or(0)
}

fn match_basename_to_slug(basename: &str, registry: &Registry) -> Option<String> {
    for (slug, proj) in &registry.projects {
        for repo in &proj.repos {
            if repo.as_str() == basename {
                return Some(slug.clone());
            }
        }
    }
    None
}

/// Read first 8 KB of a JSONL file; extract (title, cwd, first_timestamp).
fn cc_session_cheap_parse(path: &Path) -> (Option<String>, Option<String>, Option<u64>) {
    let Ok(f) = fs::File::open(path) else {
        return (None, None, None);
    };
    let mut buf = String::new();
    let _ = BufReader::new(f).take(8192).read_to_string(&mut buf);

    let mut title: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut first_ts: Option<u64> = None;

    for line in buf.lines() {
        if title.is_some() && cwd.is_some() && first_ts.is_some() {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let typ = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if title.is_none() && typ == "ai-title" {
            title = v.get("aiTitle")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
        }
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|c| c.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if first_ts.is_none() {
            if let Some(t_str) = v.get("timestamp").and_then(|t| t.as_str()) {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(t_str) {
                    first_ts = Some(dt.timestamp() as u64);
                }
            }
        }
    }
    (title, cwd, first_ts)
}

fn scan_claude_code_sessions(
    registry: &Registry,
    has_live: bool,
    cache: &UsageCache,
) -> Vec<SessionMeta> {
    let projects_dir = home_dir().join(".claude/projects");
    let Ok(proj_dirs) = fs::read_dir(&projects_dir) else {
        return vec![];
    };
    let mut sessions = vec![];

    for proj_entry in proj_dirs.flatten() {
        let proj_dir = proj_entry.path();
        if !proj_dir.is_dir() {
            continue;
        }
        let dir_name = proj_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let Ok(files) = fs::read_dir(&proj_dir) else {
            continue;
        };
        for fe in files.flatten() {
            let fpath = fe.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let id = fpath
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let last_activity = mtime_secs(&fpath).unwrap_or(0);

            let (title, cwd, first_ts) = cc_session_cheap_parse(&fpath);

            // Project slug: prefer cwd basename, fall back to encoded dir name
            let project_slug = {
                let from_cwd = cwd
                    .as_deref()
                    .and_then(|c| Path::new(c).file_name())
                    .and_then(|n| n.to_str())
                    .and_then(|bn| match_basename_to_slug(bn, registry));
                if from_cwd.is_some() {
                    from_cwd
                } else {
                    let s = match_dir_to_slug(&dir_name, registry);
                    if s == "unfiled" { None } else { Some(s) }
                }
            };

            // Token totals from usage cache (no re-parse needed)
            let fpath_str = fpath.to_string_lossy().into_owned();
            let token_totals = cache.files.get(&fpath_str).map(|entry| {
                let mut total = DayBucket::default();
                for b in entry.days.values() {
                    total.add(b);
                }
                TokenTotals {
                    input: total.input,
                    output: total.output,
                    cache_read: total.cache_read,
                    cache_write: total.cache_write,
                    est_dollars: total.est_dollars,
                }
            });

            sessions.push(SessionMeta {
                id,
                provider: "claude-code".to_string(),
                repo_path: cwd,
                title,
                started_at: first_ts,
                last_activity,
                token_totals,
                status: session_status(last_activity, has_live).to_string(),
                project_slug,
                attention: false,
            });
        }
    }
    sessions
}

fn scan_cowork_sessions(registry: &Registry, has_live: bool, cache: &UsageCache) -> Vec<SessionMeta> {
    let cowork_root = home_dir()
        .join("Library/Application Support/Claude/local-agent-mode-sessions");
    let Ok(space_dirs) = fs::read_dir(&cowork_root) else {
        return vec![];
    };
    let mut sessions = vec![];
    let cutoff = now_unix().saturating_sub(90 * 86400);

    for space_entry in space_dirs.flatten() {
        let space_dir = space_entry.path();
        if !space_dir.is_dir() {
            continue;
        }
        let Ok(ws_dirs) = fs::read_dir(&space_dir) else {
            continue;
        };
        for ws_entry in ws_dirs.flatten() {
            let ws_dir = ws_entry.path();
            if !ws_dir.is_dir() {
                continue;
            }
            let Ok(files) = fs::read_dir(&ws_dir) else {
                continue;
            };
            for fe in files.flatten() {
                let fpath = fe.path();
                let fname = fpath.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !fname.starts_with("local_") || !fname.ends_with(".json") {
                    continue;
                }

                let file_mtime = mtime_secs(&fpath).unwrap_or(0);
                if file_mtime < cutoff {
                    continue;
                }

                let parsed = fs::read_to_string(&fpath)
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok());

                let (id, title, repo_path, started_at, cowork_la) = match parsed {
                    Some(v) => {
                        let id = v.get("sessionId")
                            .and_then(|s| s.as_str())
                            .unwrap_or(fname)
                            .to_string();
                        let title = v.get("title")
                            .and_then(|s| s.as_str())
                            .filter(|s| !s.is_empty())
                            .map(|s| s.to_string());
                        let repo_path = v.get("userSelectedFolders")
                            .and_then(|f| f.as_array())
                            .and_then(|a| a.first())
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        let started_at = v.get("createdAt")
                            .and_then(|t| t.as_u64())
                            .map(|ms| ms / 1000);
                        let la = v.get("lastActivityAt")
                            .and_then(|t| t.as_u64())
                            .map(|ms| ms / 1000);
                        (id, title, repo_path, started_at, la)
                    }
                    None => (fname.to_string(), None, None, None, None),
                };

                let effective_la = cowork_la.unwrap_or(file_mtime);
                let project_slug = repo_path
                    .as_deref()
                    .and_then(|rp| Path::new(rp).file_name())
                    .and_then(|n| n.to_str())
                    .and_then(|bn| match_basename_to_slug(bn, registry));

                // Token totals from audit.jsonl (populated into cache by usage_rollup)
                let session_dir_name = &fname[..fname.len() - 5]; // strip ".json"
                let audit_path = ws_dir.join(session_dir_name).join("audit.jsonl");
                let token_totals = {
                    let ap_str = audit_path.to_string_lossy().into_owned();
                    cache.files.get(&ap_str).map(|entry| {
                        let mut total = DayBucket::default();
                        for b in entry.days.values() {
                            total.add(b);
                        }
                        TokenTotals {
                            input: total.input,
                            output: total.output,
                            cache_read: total.cache_read,
                            cache_write: total.cache_write,
                            est_dollars: total.est_dollars,
                        }
                    })
                };

                sessions.push(SessionMeta {
                    id,
                    provider: "cowork".to_string(),
                    repo_path,
                    title,
                    started_at,
                    last_activity: effective_la,
                    token_totals,
                    status: session_status(effective_la, has_live).to_string(),
                    project_slug,
                    attention: false,
                });
            }
        }
    }
    sessions
}

#[tauri::command]
fn list_sessions(state: tauri::State<'_, EventsState>) -> Vec<SessionMeta> {
    let registry = load_registry();
    let has_live = count_live_claude() > 0;
    let cache: UsageCache = fs::read_to_string(app_data_dir().join("usage_cache.json"))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    let mut sessions = vec![];
    sessions.extend(scan_claude_code_sessions(&registry, has_live, &cache));
    sessions.extend(scan_cowork_sessions(&registry, has_live, &cache));
    sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
    // Merge event-derived statuses — overrides ps/mtime heuristic
    let event_map = state.0.lock().unwrap();
    for session in &mut sessions {
        if let Some(ev) = event_map.sessions.get(&session.id) {
            session.status = ev.status.clone();
            session.attention = ev.attention;
            // Gate: only flag attention if the session is still live by the heuristic.
            // Clears stale permission prompts from dead or timed-out sessions.
            if session.attention {
                let age = now_unix().saturating_sub(session.last_activity);
                if !has_live || age > 600 {
                    session.attention = false;
                }
            }
            if session.project_slug.is_none() {
                session.project_slug = ev.project_slug.clone();
            }
        }
    }
    sessions
}

#[tauri::command]
fn needs_you_count(state: tauri::State<'_, EventsState>) -> usize {
    state.0.lock().unwrap()
        .sessions
        .values()
        .filter(|s| s.attention)
        .count()
}

#[tauri::command]
fn active_session_count() -> usize {
    count_live_claude()
}

// ── Working tree ──────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct DirtyFile {
    path: String,
    state: String,
    mtime: Option<u64>,
}

#[derive(Serialize, Clone)]
struct ProjectWorkingTree {
    slug: String,
    dirty_count: u32,
    files: Vec<DirtyFile>,
    no_data: bool,
}

#[derive(Serialize)]
struct WorkingTreeRollup {
    by_project: Vec<ProjectWorkingTree>,
}

fn xy_to_state(x: char, y: char) -> &'static str {
    if x == '?' { return "untracked"; }
    match x {
        'A' => return "added",
        'D' => return "deleted",
        'R' | 'C' => return "renamed",
        'M' | 'T' => return "staged",
        _ => {}
    }
    match y {
        'M' | 'T' => "modified",
        'D' => "deleted",
        'A' => "added",
        _ => "changed",
    }
}

fn parse_porcelain_line(line: &str, repo_root: &Path) -> Option<DirtyFile> {
    if line.len() < 4 { return None; }
    let mut chars = line.chars();
    let x = chars.next()?;
    let y = chars.next()?;
    if x == '!' { return None; } // skip ignored entries
    if line.as_bytes().get(2) != Some(&b' ') { return None; }
    let raw = &line[3..];
    // Rename format: "orig -> new" — use the destination path
    let file_path = if let Some(idx) = raw.find(" -> ") {
        &raw[idx + 4..]
    } else {
        raw
    };
    let state = xy_to_state(x, y);
    let abs_path = repo_root.join(file_path);
    let mtime = mtime_secs(&abs_path);
    Some(DirtyFile {
        path: file_path.to_string(),
        state: state.to_string(),
        mtime,
    })
}

#[tauri::command]
fn working_tree_rollup() -> WorkingTreeRollup {
    let registry = load_registry();
    let session_paths = discover_session_repo_paths();
    let mut by_project: Vec<ProjectWorkingTree> = vec![];

    for (slug, proj) in &registry.projects {
        let mut all_files: Vec<DirtyFile> = vec![];
        let mut any_data = false;

        for repo_basename in &proj.repos {
            let Some(repo_path) = resolve_repo_path(repo_basename, &session_paths) else {
                continue;
            };
            any_data = true;

            let output = match std::process::Command::new("git")
                .args(["-C", repo_path.to_str().unwrap_or(""), "status", "--porcelain"])
                .output()
            {
                Ok(o) if o.status.success() => o,
                _ => continue,
            };

            let text = String::from_utf8_lossy(&output.stdout);
            for line in text.lines() {
                if let Some(f) = parse_porcelain_line(line, &repo_path) {
                    all_files.push(f);
                }
            }
        }

        // Sort oldest-first (lowest mtime first = sat longest); None mtime goes last
        all_files.sort_by(|a, b| match (a.mtime, b.mtime) {
            (Some(ta), Some(tb)) => ta.cmp(&tb),
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, None) => std::cmp::Ordering::Equal,
        });

        let dirty_count = all_files.len() as u32;
        by_project.push(ProjectWorkingTree {
            slug: slug.clone(),
            dirty_count,
            files: all_files,
            no_data: !any_data,
        });
    }

    WorkingTreeRollup { by_project }
}

// ── Git metrics ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
struct GitPeriodMetrics {
    commits: u32,
    lines_added: i64,
    lines_removed: i64,
    files_changed: u64,
}

#[derive(Serialize, Deserialize)]
struct GitRepoCacheEntry {
    head_sha: String,
    week_start: String,
    week: GitPeriodMetrics,
    all_time: GitPeriodMetrics,
    last_commit_ts: Option<u64>,
    last_commit_subject: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct GitMetricsCache {
    repos: HashMap<String, GitRepoCacheEntry>,
}

#[derive(Serialize, Clone)]
struct RepoResolution {
    basename: String,
    path: Option<String>,
    status: String,
}

#[derive(Serialize, Clone, Default)]
struct ProjectGitMetrics {
    slug: String,
    week: GitPeriodMetrics,
    all_time: GitPeriodMetrics,
    last_commit_ts: Option<u64>,
    last_commit_subject: Option<String>,
    no_data: bool,
}

#[derive(Serialize)]
struct GitMetricsRollup {
    by_project: Vec<ProjectGitMetrics>,
    week_total: GitPeriodMetrics,
    resolutions: Vec<RepoResolution>,
}

fn git_head_sha(repo_path: &Path) -> Option<String> {
    std::process::Command::new("git")
        .args(["-C", repo_path.to_str().unwrap_or(""), "rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn compute_git_metrics_for_repo(
    repo_path: &Path,
    week_start_epoch: i64,
) -> (GitPeriodMetrics, GitPeriodMetrics, Option<u64>, Option<String>) {
    let output = match std::process::Command::new("git")
        .args([
            "-C",
            repo_path.to_str().unwrap_or(""),
            "log",
            "--numstat",
            "--format=COMMIT %H %ct %s",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return (Default::default(), Default::default(), None, None),
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut week = GitPeriodMetrics::default();
    let mut all_time = GitPeriodMetrics::default();
    let mut last_ts: Option<u64> = None;
    let mut last_subject: Option<String> = None;
    let mut current_ts: Option<i64> = None;

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("COMMIT ") {
            // rest = "<40-char sha> <unix-ts> <subject>"
            if rest.len() > 41 {
                let after_hash = &rest[41..]; // skip sha (40 chars) + space
                let mut sp = after_hash.splitn(2, ' ');
                if let Some(ts_str) = sp.next() {
                    if let Ok(ts) = ts_str.trim().parse::<i64>() {
                        current_ts = Some(ts);
                        all_time.commits += 1;
                        if ts >= week_start_epoch {
                            week.commits += 1;
                        }
                        if last_ts.is_none() {
                            last_ts = Some(ts as u64);
                            last_subject = sp.next().map(|s| s.trim().to_string());
                        }
                    }
                }
            }
        } else if !line.is_empty() {
            // numstat line: "added\tremoved\tpath" (binary files show "-")
            let mut tabs = line.splitn(3, '\t');
            if let (Some(a_str), Some(r_str), Some(_)) =
                (tabs.next(), tabs.next(), tabs.next())
            {
                let added = a_str.parse::<i64>().unwrap_or(0);
                let removed = r_str.parse::<i64>().unwrap_or(0);
                if let Some(ts) = current_ts {
                    all_time.lines_added += added;
                    all_time.lines_removed += removed;
                    all_time.files_changed += 1;
                    if ts >= week_start_epoch {
                        week.lines_added += added;
                        week.lines_removed += removed;
                        week.files_changed += 1;
                    }
                }
            }
        }
    }

    (week, all_time, last_ts, last_subject)
}

fn add_git_metrics(a: &mut GitPeriodMetrics, b: &GitPeriodMetrics) {
    a.commits += b.commits;
    a.lines_added += b.lines_added;
    a.lines_removed += b.lines_removed;
    a.files_changed += b.files_changed;
}

fn discover_session_repo_paths() -> HashMap<String, PathBuf> {
    let mut map: HashMap<String, PathBuf> = HashMap::new();
    let projects_dir = home_dir().join(".claude/projects");
    let Ok(dirs) = fs::read_dir(&projects_dir) else {
        return map;
    };
    for dir_entry in dirs.flatten() {
        let dir = dir_entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        // Read just the first JSONL in each project dir to get a CWD
        for fe in files.flatten() {
            let fpath = fe.path();
            if fpath.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let (_, cwd_opt, _) = cc_session_cheap_parse(&fpath);
            if let Some(cwd) = cwd_opt {
                let p = PathBuf::from(&cwd);
                if let Some(basename) = p.file_name().and_then(|n| n.to_str()) {
                    map.entry(basename.to_string()).or_insert(p);
                }
            }
            break;
        }
    }
    map
}

fn resolve_repo_path(basename: &str, session_paths: &HashMap<String, PathBuf>) -> Option<PathBuf> {
    // Try exact basename and dash-stripped variant (e.g. "ant-farm" → "antfarm")
    let nodash = basename.replace('-', "");
    let mut variants = vec![basename.to_string()];
    if nodash != basename {
        variants.push(nodash);
    }

    // 1. Session-discovered CWDs
    for v in &variants {
        if let Some(p) = session_paths.get(v.as_str()) {
            if p.join(".git").exists() {
                return Some(p.clone());
            }
        }
    }
    // 2. ~/Desktop/<variant>
    for v in &variants {
        let p = home_dir().join("Desktop").join(v.as_str());
        if p.join(".git").exists() {
            return Some(p);
        }
    }
    // 3. ~/<variant>
    for v in &variants {
        let p = home_dir().join(v.as_str());
        if p.join(".git").exists() {
            return Some(p);
        }
    }
    None
}

#[tauri::command]
fn git_metrics_rollup() -> GitMetricsRollup {
    let registry = load_registry();
    let settings = get_settings();

    // Compute week start
    let today = Local::now();
    let today_dow = weekday_to_dow(today.weekday());
    let reset_dow = settings.reset_weekday.min(6);
    let days_since_reset = ((today_dow + 7 - reset_dow) % 7) as i64;
    let week_start_local = today - chrono::Duration::days(days_since_reset);
    let week_start_date = week_start_local.format("%Y-%m-%d").to_string();
    // Epoch at local midnight of the week-start day
    let secs_in_day = week_start_local.time().num_seconds_from_midnight() as i64;
    let week_start_epoch = week_start_local.timestamp() - secs_in_day;

    // Load git metrics cache
    let data_dir = app_data_dir();
    let _ = fs::create_dir_all(&data_dir);
    let git_cache_path = data_dir.join("git_metrics_cache.json");
    let mut git_cache: GitMetricsCache = fs::read_to_string(&git_cache_path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();

    let session_paths = discover_session_repo_paths();

    let mut by_project: Vec<ProjectGitMetrics> = vec![];
    let mut week_total = GitPeriodMetrics::default();
    let mut resolutions: Vec<RepoResolution> = vec![];

    for (slug, proj) in &registry.projects {
        let mut proj_week = GitPeriodMetrics::default();
        let mut proj_all_time = GitPeriodMetrics::default();
        let mut proj_last_ts: Option<u64> = None;
        let mut proj_last_subject: Option<String> = None;
        let mut any_data = false;

        for repo_basename in &proj.repos {
            let resolved = resolve_repo_path(repo_basename, &session_paths);

            resolutions.push(RepoResolution {
                basename: repo_basename.clone(),
                path: resolved.as_ref().map(|p| p.to_string_lossy().into_owned()),
                status: if resolved.is_some() {
                    "resolved".to_string()
                } else {
                    "not-found".to_string()
                },
            });

            let Some(repo_path) = resolved else {
                continue;
            };

            let Some(head_sha) = git_head_sha(&repo_path) else {
                continue;
            };

            let path_key = repo_path.to_string_lossy().into_owned();

            let (week_m, all_time_m, last_ts, last_subject) = {
                let cached = git_cache.repos.get(&path_key);
                if let Some(entry) = cached {
                    if entry.head_sha == head_sha && entry.week_start == week_start_date {
                        eprintln!("git cache hit: {}", path_key);
                        (
                            entry.week.clone(),
                            entry.all_time.clone(),
                            entry.last_commit_ts,
                            entry.last_commit_subject.clone(),
                        )
                    } else {
                        let (w, a, ts, subj) =
                            compute_git_metrics_for_repo(&repo_path, week_start_epoch);
                        git_cache.repos.insert(
                            path_key.clone(),
                            GitRepoCacheEntry {
                                head_sha,
                                week_start: week_start_date.clone(),
                                week: w.clone(),
                                all_time: a.clone(),
                                last_commit_ts: ts,
                                last_commit_subject: subj.clone(),
                            },
                        );
                        (w, a, ts, subj)
                    }
                } else {
                    let (w, a, ts, subj) =
                        compute_git_metrics_for_repo(&repo_path, week_start_epoch);
                    git_cache.repos.insert(
                        path_key.clone(),
                        GitRepoCacheEntry {
                            head_sha,
                            week_start: week_start_date.clone(),
                            week: w.clone(),
                            all_time: a.clone(),
                            last_commit_ts: ts,
                            last_commit_subject: subj.clone(),
                        },
                    );
                    (w, a, ts, subj)
                }
            };

            any_data = true;
            add_git_metrics(&mut proj_week, &week_m);
            add_git_metrics(&mut proj_all_time, &all_time_m);
            if let Some(ts) = last_ts {
                if proj_last_ts.map(|ex| ts > ex).unwrap_or(true) {
                    proj_last_ts = Some(ts);
                    proj_last_subject = last_subject;
                }
            }
        }

        add_git_metrics(&mut week_total, &proj_week);

        by_project.push(ProjectGitMetrics {
            slug: slug.clone(),
            week: proj_week,
            all_time: proj_all_time,
            last_commit_ts: proj_last_ts,
            last_commit_subject: proj_last_subject,
            no_data: !any_data,
        });
    }

    if let Ok(json) = serde_json::to_string(&git_cache) {
        let _ = fs::write(&git_cache_path, json);
    }

    by_project.sort_by(|a, b| b.week.commits.cmp(&a.week.commits));

    GitMetricsRollup {
        by_project,
        week_total,
        resolutions,
    }
}

// ── Workspace persistence ─────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct WorkspaceEntry {
    id: String,
    name: String,
    project_slug: Option<String>,
    layout_json: Option<String>,
}

fn workspaces_path() -> PathBuf {
    app_data_dir().join("workspaces.json")
}

#[tauri::command]
fn load_workspaces() -> Vec<WorkspaceEntry> {
    match fs::read_to_string(workspaces_path()) {
        Ok(c) => serde_json::from_str(&c).unwrap_or_default(),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn save_workspaces(workspaces: Vec<WorkspaceEntry>) -> Result<(), String> {
    let dir = app_data_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&workspaces).map_err(|e| e.to_string())?;
    fs::write(workspaces_path(), json).map_err(|e| e.to_string())
}

// ── Project path resolution for dispatch ─────────────────────────────────────

#[derive(Serialize)]
struct RepoPath {
    repo: String,
    path: String,
}

#[tauri::command]
fn get_project_paths(slug: String) -> Vec<RepoPath> {
    let registry = load_registry();
    let session_paths = discover_session_repo_paths();
    let empty = RegistryProject::default();
    let proj = registry.projects.get(&slug).unwrap_or(&empty);
    proj.repos
        .iter()
        .filter_map(|repo| {
            let path = resolve_repo_path(repo, &session_paths)?;
            Some(RepoPath {
                repo: repo.clone(),
                path: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let events_inner = Arc::new(Mutex::new(EventsStateInner {
        sessions: HashMap::new(),
    }));
    let events_state = EventsState(Arc::clone(&events_inner));

    let dispatch_state  = dispatch::DispatchState::default();
    let dispatch_claude = dispatch_state.claude_path.clone();

    tauri::Builder::default()
        .manage(events_state)
        .manage(dispatch_state)
        .setup(move |app| {
            // Resolve claude at startup; login shell picks up NVM/Homebrew/custom PATH.
            let path = dispatch::resolve_claude_path();
            *dispatch_claude.lock().unwrap() = path;
            spawn_events_watcher(app.handle().clone(), Arc::clone(&events_inner));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            get_project_detail,
            get_file_content,
            get_settings,
            save_settings,
            usage_rollup,
            list_sessions,
            active_session_count,
            needs_you_count,
            git_metrics_rollup,
            working_tree_rollup,
            get_project_paths,
            dispatch::dispatch_run,
            dispatch::list_runs,
            dispatch::kill_run,
            dispatch::take_over_run,
            load_workspaces,
            save_workspaces,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
