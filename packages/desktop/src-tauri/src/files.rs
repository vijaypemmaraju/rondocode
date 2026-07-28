/* ---------------------------------------------------------------------------
 * Local filesystem access: real Open/Save of a project file, plus a folder the
 * app can write renders into.
 *
 * Dialogs go through `osascript` rather than a dialog crate. That is a
 * deliberate trade: it adds no dependency, it is the system's own picker (so
 * it honours sandbox grants, recent places and iCloud like any other app), and
 * it keeps this package buildable from a cold, offline registry cache. The
 * cost is macOS-only, which matches where the DAW integration lives anyway.
 * ------------------------------------------------------------------------- */

use std::path::{Path, PathBuf};
use std::process::Command;

/// Run an AppleScript snippet and return its stdout, trimmed. An empty result
/// means the user cancelled — that is not an error, so it maps to None.
fn osascript(script: &str) -> Result<Option<String>, String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("could not run osascript: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        // "User canceled." is how AppleScript reports a dismissed dialog
        if err.contains("User canceled") || err.contains("User cancelled") {
            return Ok(None);
        }
        return Err(format!("dialog failed: {}", err.trim()));
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(if s.is_empty() { None } else { Some(s) })
}

/// A project file on disk.
#[derive(serde::Serialize)]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub code: String,
    /// which language the extension says this is: `.rondo` = rondo, else JS.
    pub lang: String,
}

/// The language a path's extension implies. `.rondo` is the terse language;
/// everything else is treated as the JavaScript DSL, which is also what an
/// extensionless file gets (the editor can still be toggled by hand).
fn lang_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("rondo") => "rondo",
        _ => "rondocode",
    }
}

fn read_at(path: &Path) -> Result<OpenedFile, String> {
    let code = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(OpenedFile {
        path: path.display().to_string(),
        name: path.file_stem().and_then(|s| s.to_str()).unwrap_or("untitled").to_string(),
        code,
        lang: lang_of(path).to_string(),
    })
}

/// Native Open dialog, then read. None when the user cancels.
pub fn open_dialog() -> Result<Option<OpenedFile>, String> {
    let script = "POSIX path of (choose file with prompt \"Open a rondocode project\" \
         of type {\"rondo\", \"js\", \"txt\"})";
    match osascript(script)? {
        None => Ok(None),
        Some(p) => read_at(Path::new(&p)).map(Some),
    }
}

/// Read a path the caller already knows (recent files, drag-and-drop).
pub fn open_path(path: String) -> Result<OpenedFile, String> {
    read_at(Path::new(&path))
}

/// Write `code` to `path`. Used by Save once a project has a home.
pub fn save_path(path: String, code: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    std::fs::write(&p, code).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p.display().to_string())
}

/// Native Save dialog, then write. None when the user cancels. `suggested` is
/// the default file name, extension included.
pub fn save_dialog(suggested: String, code: String) -> Result<Option<String>, String> {
    let safe = suggested.replace('"', "");
    let script = format!(
        "POSIX path of (choose file name with prompt \"Save project\" default name \"{safe}\")"
    );
    match osascript(&script)? {
        None => Ok(None),
        Some(p) => save_path(p, code).map(Some),
    }
}

/// Native folder picker — where renders and stems should land.
pub fn choose_folder() -> Result<Option<String>, String> {
    osascript("POSIX path of (choose folder with prompt \"Choose a render folder\")")
}

/// Write arbitrary bytes (a rendered WAV, an exported .mid) into a folder,
/// returning the full path written.
pub fn write_bytes(dir: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    let mut p = PathBuf::from(&dir);
    std::fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    // basename only: a caller-supplied name must not escape the chosen folder
    let base = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("bad file name: {name}"))?;
    p.push(base);
    std::fs::write(&p, bytes).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p.display().to_string())
}
