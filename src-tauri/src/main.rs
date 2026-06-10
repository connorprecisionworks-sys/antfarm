#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{Datelike, Local, Weekday};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

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
        let timestamp = match obj.get("timestamp").and_then(|t| t.as_str()) {
            Some(t) if t.len() >= 10 => t,
            _ => continue,
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

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_projects,
            get_project_detail,
            get_file_content,
            get_settings,
            save_settings,
            usage_rollup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
