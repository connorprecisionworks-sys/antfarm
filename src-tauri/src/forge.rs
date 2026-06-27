use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GateResult {
    pub passed: bool,
    pub command: String,
    pub output: String,
}

fn has_build_script(pkg_path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(pkg_path) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) else {
        return false;
    };
    v.get("scripts")
        .and_then(|s| s.get("build"))
        .is_some()
}

/// Returns (program, args, cwd) for the detected build command, or an error string.
///
/// Priority:
///   1. src-tauri/Cargo.toml  → `cargo check` with cwd=src-tauri/
///   2. Cargo.toml at root    → `cargo check` with cwd=root
///   3. package.json with a "build" script → `npm run build` with cwd=root
pub fn detect_build_command(root: &Path) -> Result<(String, Vec<String>, PathBuf), String> {
    let src_tauri = root.join("src-tauri");
    if src_tauri.join("Cargo.toml").exists() {
        return Ok(("cargo".into(), vec!["check".into()], src_tauri));
    }
    if root.join("Cargo.toml").exists() {
        return Ok(("cargo".into(), vec!["check".into()], root.to_path_buf()));
    }
    let pkg = root.join("package.json");
    if pkg.exists() && has_build_script(&pkg) {
        return Ok(("npm".into(), vec!["run".into(), "build".into()], root.to_path_buf()));
    }
    Err("no known build command".into())
}

/// Run the deterministic build/check gate for a repo and report pass/fail + output.
///
/// This is a plain std::process::Command call — NOT routed through any agent's Bash
/// tool, so the hook guard never touches it.
#[tauri::command]
pub fn run_verification_gate(repo_path: String) -> Result<GateResult, String> {
    let root = Path::new(&repo_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {repo_path}"));
    }

    let (prog, args, cwd) = detect_build_command(root)?;
    let command_str = format!("{} {}", prog, args.join(" "));

    let output = std::process::Command::new(&prog)
        .args(&args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("failed to run {command_str}: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let full = format!("{stdout}{stderr}");

    const OUTPUT_CAP: usize = 8000;
    let trimmed = if full.len() > OUTPUT_CAP {
        let start = full.len() - OUTPUT_CAP;
        // Advance to the next UTF-8 char boundary so we don't slice mid-codepoint.
        let safe_start = (start..=full.len())
            .find(|&i| full.is_char_boundary(i))
            .unwrap_or(full.len());
        full[safe_start..].to_string()
    } else {
        full
    };

    Ok(GateResult {
        passed: output.status.success(),
        command: command_str,
        output: trimmed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("gate_{}_pid{}", name, std::process::id()));
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn detects_src_tauri_cargo() {
        let root = tmp("tauri_proj");
        let src_tauri = root.join("src-tauri");
        fs::create_dir_all(&src_tauri).unwrap();
        fs::write(src_tauri.join("Cargo.toml"), "[package]\nname=\"x\"").unwrap();
        let (prog, args, cwd) = detect_build_command(&root).unwrap();
        assert_eq!(prog, "cargo");
        assert_eq!(args, ["check"]);
        assert_eq!(cwd, src_tauri);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detects_root_cargo() {
        let root = tmp("rust_proj");
        fs::write(root.join("Cargo.toml"), "[package]\nname=\"x\"").unwrap();
        let (prog, args, cwd) = detect_build_command(&root).unwrap();
        assert_eq!(prog, "cargo");
        assert_eq!(args, ["check"]);
        assert_eq!(cwd, root);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detects_npm_build_script() {
        let root = tmp("node_proj");
        fs::write(root.join("package.json"), r#"{"scripts":{"build":"echo ok"}}"#).unwrap();
        let (prog, args, cwd) = detect_build_command(&root).unwrap();
        assert_eq!(prog, "npm");
        assert_eq!(args, ["run", "build"]);
        assert_eq!(cwd, root);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn npm_without_build_script_is_unknown() {
        let root = tmp("node_no_build");
        fs::write(root.join("package.json"), r#"{"scripts":{"test":"jest"}}"#).unwrap();
        assert!(detect_build_command(&root).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_dir_is_unknown() {
        let root = tmp("empty_proj");
        assert!(detect_build_command(&root).is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn src_tauri_takes_priority_over_root_cargo() {
        let root = tmp("both_cargo");
        let src_tauri = root.join("src-tauri");
        fs::create_dir_all(&src_tauri).unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\nname=\"outer\"").unwrap();
        fs::write(src_tauri.join("Cargo.toml"), "[package]\nname=\"inner\"").unwrap();
        let (_, _, cwd) = detect_build_command(&root).unwrap();
        assert_eq!(cwd, src_tauri, "src-tauri/Cargo.toml should win over root Cargo.toml");
        let _ = fs::remove_dir_all(&root);
    }
}
