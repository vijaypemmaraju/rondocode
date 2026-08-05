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

/* ---- workspace: a directory IS the project list -------------------------- *
 * The browser keeps projects in IndexedDB because it has nowhere else to put
 * them. On the desktop that would be a second source of truth sitting next to
 * the real one, so instead a folder of .rondo/.js files IS the library: git
 * works on it, other editors work on it, and there is nothing to import or
 * export. */

#[derive(serde::Serialize)]
pub struct WorkspaceEntry {
    pub path: String,
    /// file stem — what the library shows as the project name.
    pub name: String,
    pub lang: String,
    /// modified time, ms since epoch, for "most recent first".
    pub modified: u64,
}

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Every project file directly inside `dir`, newest first.
///
/// Deliberately NOT recursive and not hidden-file-aware: a workspace is a flat
/// folder of tunes, and silently walking into node_modules or .git would turn
/// the library into noise.
pub fn list_workspace(dir: String) -> Result<Vec<WorkspaceEntry>, String> {
    let root = PathBuf::from(&dir);
    let rd = std::fs::read_dir(&root).map_err(|e| format!("{}: {e}", root.display()))?;
    let mut out: Vec<WorkspaceEntry> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext, "rondo" | "js") {
            continue;
        }
        let name = match path.file_stem().and_then(|s| s.to_str()) {
            Some(n) if !n.starts_with('.') => n.to_string(),
            _ => continue, // dotfiles are editor droppings, not tunes
        };
        let modified = entry.metadata().map(|m| modified_ms(&m)).unwrap_or(0);
        out.push(WorkspaceEntry {
            path: path.display().to_string(),
            name,
            lang: lang_of(&path).to_string(),
            modified,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// Create a new project file in `dir`, refusing to clobber an existing one.
/// Returns the path written.
pub fn create_in_workspace(dir: String, name: String, ext: String, code: String) -> Result<String, String> {
    let base = sanitize_stem(&name)?;
    let mut p = PathBuf::from(&dir);
    std::fs::create_dir_all(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    p.push(format!("{base}{ext}"));
    if p.exists() {
        return Err(format!("{} already exists", p.display()));
    }
    std::fs::write(&p, code).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p.display().to_string())
}

/// A file name with no path separators and no leading dot: a project name comes
/// from a text field, and must not be able to write outside the workspace.
fn sanitize_stem(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("a project needs a name".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.starts_with('.') || trimmed == ".." {
        return Err(format!("'{trimmed}' is not a usable file name"));
    }
    Ok(trimmed.to_string())
}

/// Rename a project in place, keeping its extension. Returns the new path.
pub fn rename_in_workspace(path: String, new_name: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let base = sanitize_stem(&new_name)?;
    let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("js").to_string();
    let to = from.with_file_name(format!("{base}.{ext}"));
    if to.exists() && to != from {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(to.display().to_string())
}

/// Re-extension a project, keeping its name. Returns the new path (or the old
/// one, unchanged, when it already ends in `ext`).
///
/// This exists because on the desktop the EXTENSION IS THE LANGUAGE: the
/// workspace listing reads `.rondo` vs `.js` back as the project's language,
/// with no database row involved. So the editor's language toggle has to move
/// the file, or the next open hands rondo source to the JavaScript evaluator.
/// `rename_in_workspace` deliberately preserves the extension (renaming a tune
/// must never change what it is), which is why this is a separate command.
pub fn set_workspace_ext(path: String, ext: String) -> Result<String, String> {
    if !matches!(ext.as_str(), ".rondo" | ".js") {
        return Err(format!("'{ext}' is not a project extension"));
    }
    let from = PathBuf::from(&path);
    let stem = from
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("{} has no name", from.display()))?;
    let to = from.with_file_name(format!("{stem}{ext}"));
    if to == from {
        return Ok(path); // already in that language
    }
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    std::fs::rename(&from, &to).map_err(|e| format!("{}: {e}", from.display()))?;
    Ok(to.display().to_string())
}

/// Move a project to the TRASH rather than unlinking it. A library delete
/// should be undoable in Finder; std::fs::remove_file is not.
pub fn trash_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let script = format!(
        "tell application \"Finder\" to delete POSIX file \"{}\"",
        p.display().to_string().replace('"', "")
    );
    osascript(&script).map(|_| ())
}

/* ---- a project's samples, beside the project ---------------------------- *
 * The browser stores a project's takes in IndexedDB next to the project row.
 * A workspace project has no row: it is a FILE, and the whole point of the
 * workspace is that the file is the thing you copy, commit and hand to
 * someone. Samples kept in a database beside it would be lost by every one of
 * those, so `tune.rondo` keeps its samples in `tune.samples/` next to it.
 *
 * Deliberately a sibling FOLDER and not a bundle: it stays visible in Finder,
 * `git add` takes it, and a WAV in there opens in anything. */

/// `tune.rondo` -> `tune.samples`. Rejects a path with no file stem.
fn samples_dir(project: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(project);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("bad project path: {project}"))?;
    let parent = p.parent().ok_or_else(|| format!("bad project path: {project}"))?;
    Ok(parent.join(format!("{stem}.samples")))
}

/// The sample files beside `project`, as (name, bytes). Missing folder is not
/// an error: a project simply has no samples yet, which is the common case.
pub fn list_project_samples(project: String) -> Result<Vec<(String, Vec<u8>)>, String> {
    let dir = samples_dir(&project)?;
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("wav") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        match std::fs::read(&path) {
            Ok(bytes) => out.push((name.to_string(), bytes)),
            // one unreadable take must not cost the project every other one
            Err(e) => eprintln!("[samples] skipping {}: {e}", path.display()),
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Write one sample beside `project`, creating the folder on first use.
pub fn write_project_sample(project: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    let dir = samples_dir(&project)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // basename only: a sample name comes from user text and must not escape
    let base = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("bad sample name: {name}"))?;
    let p = dir.join(format!("{base}.wav"));
    std::fs::write(&p, bytes).map_err(|e| format!("{}: {e}", p.display()))?;
    Ok(p.display().to_string())
}

/// Delete one sample beside `project`. Unlinked, not trashed: unlike a project
/// this is a derived file the user just asked to drop from the list, and
/// filling the Trash with takes is noise.
pub fn delete_project_sample(project: String, name: String) -> Result<(), String> {
    let dir = samples_dir(&project)?;
    let base = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("bad sample name: {name}"))?;
    let p = dir.join(format!("{base}.wav"));
    match std::fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), // already gone
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch dir under the system temp, removed on drop.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("rondocode-ws-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Tmp(p)
        }
        fn s(&self) -> String {
            self.0.display().to_string()
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_only_project_files_and_reads_language_from_the_extension() {
        let t = Tmp::new("list");
        std::fs::write(t.0.join("acid.rondo"), "saw").unwrap();
        std::fs::write(t.0.join("pad.js"), "//").unwrap();
        // none of these are tunes and must not appear in the library
        std::fs::write(t.0.join("notes.txt"), "x").unwrap();
        std::fs::write(t.0.join(".hidden.rondo"), "x").unwrap();
        std::fs::create_dir(t.0.join("subdir")).unwrap();
        std::fs::write(t.0.join("subdir").join("deep.rondo"), "x").unwrap();

        let mut got: Vec<(String, String)> =
            list_workspace(t.s()).unwrap().into_iter().map(|e| (e.name, e.lang)).collect();
        got.sort();
        assert_eq!(got, vec![
            ("acid".to_string(), "rondo".to_string()),
            ("pad".to_string(), "rondocode".to_string()),
        ]);
    }

    #[test]
    fn a_missing_workspace_is_an_error_not_an_empty_library() {
        // silently showing "no projects" for a folder that was moved or
        // unmounted would look like data loss
        assert!(list_workspace("/nope/not/here".to_string()).is_err());
    }

    #[test]
    fn create_refuses_to_clobber_and_refuses_to_escape() {
        let t = Tmp::new("create");
        let p = create_in_workspace(t.s(), "tune".into(), ".rondo".into(), "saw".into()).unwrap();
        assert!(p.ends_with("tune.rondo"));
        assert!(create_in_workspace(t.s(), "tune".into(), ".rondo".into(), "x".into()).is_err());
        for bad in ["../escape", "a/b", ".dotfile", ""] {
            assert!(
                create_in_workspace(t.s(), bad.into(), ".rondo".into(), "x".into()).is_err(),
                "should refuse {bad:?}"
            );
        }
    }

    #[test]
    fn rename_keeps_the_extension_and_the_contents() {
        let t = Tmp::new("rename");
        let p = create_in_workspace(t.s(), "before".into(), ".rondo".into(), "saw note".into()).unwrap();
        let moved = rename_in_workspace(p, "after".into()).unwrap();
        assert!(moved.ends_with("after.rondo"), "got {moved}");
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "saw note");
        // and the language it reads back as is unchanged
        assert_eq!(open_path(moved).unwrap().lang, "rondo");
    }

    #[test]
    fn switching_language_moves_the_file_to_the_other_extension() {
        // The extension IS the language here, so a toggle that only wrote a
        // database row would leave rondo source in a .js file, and the next
        // open would hand it to the JavaScript evaluator.
        let t = Tmp::new("relang");
        let p = create_in_workspace(t.s(), "tune".into(), ".js".into(), "saw(220)".into()).unwrap();
        let moved = set_workspace_ext(p.clone(), ".rondo".into()).unwrap();
        assert!(moved.ends_with("tune.rondo"), "got {moved}");
        assert_eq!(std::fs::read_to_string(&moved).unwrap(), "saw(220)");
        assert_eq!(open_path(moved.clone()).unwrap().lang, "rondo");
        assert!(!PathBuf::from(&p).exists(), "the old file must not linger");
        // and the same language twice is a no-op, not an error
        assert_eq!(set_workspace_ext(moved.clone(), ".rondo".into()).unwrap(), moved);
    }

    #[test]
    fn switching_language_will_not_clobber_the_other_file_or_take_a_junk_extension() {
        let t = Tmp::new("relang-clash");
        let js = create_in_workspace(t.s(), "tune".into(), ".js".into(), "1".into()).unwrap();
        create_in_workspace(t.s(), "tune".into(), ".rondo".into(), "2".into()).unwrap();
        // tune.rondo is someone else's project: refuse rather than overwrite it
        assert!(set_workspace_ext(js.clone(), ".rondo".into()).is_err());
        assert_eq!(std::fs::read_to_string(&js).unwrap(), "1");
        for bad in [".txt", ".sh", "", "rondo"] {
            assert!(set_workspace_ext(js.clone(), bad.into()).is_err(), "should refuse {bad:?}");
        }
    }

    #[test]
    fn rename_will_not_overwrite_another_project() {
        let t = Tmp::new("clash");
        let a = create_in_workspace(t.s(), "a".into(), ".js".into(), "1".into()).unwrap();
        create_in_workspace(t.s(), "b".into(), ".js".into(), "2".into()).unwrap();
        assert!(rename_in_workspace(a, "b".into()).is_err());
    }

    #[test]
    fn save_then_open_round_trips_through_the_extension() {
        let t = Tmp::new("round");
        let js = t.0.join("x.js").display().to_string();
        save_path(js.clone(), "const a = 1".into()).unwrap();
        let f = open_path(js).unwrap();
        assert_eq!(f.code, "const a = 1");
        assert_eq!(f.lang, "rondocode");
        assert_eq!(f.name, "x");
    }

    #[test]
    fn write_bytes_cannot_escape_the_chosen_folder() {
        let t = Tmp::new("bytes");
        // a caller-supplied name is reduced to its basename
        let p = write_bytes(t.s(), "../../evil.wav".into(), vec![1, 2, 3]).unwrap();
        assert!(p.starts_with(&t.s()), "escaped the folder: {p}");
        assert!(p.ends_with("evil.wav"));
    }

    /* A project's samples live in `<stem>.samples/` beside it, so that copying
     * or committing the tune takes its takes with it. */

    #[test]
    fn samples_round_trip_beside_the_project() {
        let t = Tmp::new("samples");
        let project = format!("{}/tune.rondo", t.s());
        std::fs::write(&project, "play a\n  c3\n").unwrap();

        // nothing yet, and that is not an error: most projects have no takes
        assert!(list_project_samples(project.clone()).unwrap().is_empty());

        let written = write_project_sample(project.clone(), "take1".into(), vec![1, 2, 3, 4]).unwrap();
        assert!(written.ends_with("tune.samples/take1.wav"), "wrote {written}");
        write_project_sample(project.clone(), "take2".into(), vec![9]).unwrap();

        let got = list_project_samples(project.clone()).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "take1");
        assert_eq!(got[0].1, vec![1, 2, 3, 4]);
        assert_eq!(got[1].0, "take2");

        delete_project_sample(project.clone(), "take1".into()).unwrap();
        let got = list_project_samples(project.clone()).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "take2");

        // deleting what is already gone is success, not an error to handle
        delete_project_sample(project, "take1".into()).unwrap();
    }

    #[test]
    fn a_sample_name_cannot_escape_its_project_folder() {
        let t = Tmp::new("escape");
        let project = format!("{}/tune.rondo", t.s());
        let p = write_project_sample(project, "../../evil".into(), vec![1]).unwrap();
        assert!(p.contains("tune.samples"), "escaped the project folder: {p}");
        assert!(p.ends_with("evil.wav"));
    }

    #[test]
    fn only_wavs_count_as_samples() {
        let t = Tmp::new("nonwav");
        let project = format!("{}/tune.rondo", t.s());
        write_project_sample(project.clone(), "take1".into(), vec![1]).unwrap();
        // a README, a .DS_Store, anything else a folder collects
        std::fs::write(format!("{}/tune.samples/notes.txt", t.s()), "hi").unwrap();
        let got = list_project_samples(project).unwrap();
        assert_eq!(got.iter().map(|s| s.0.as_str()).collect::<Vec<_>>(), vec!["take1"]);
    }

    #[test]
    fn each_project_in_a_workspace_keeps_its_own_samples() {
        let t = Tmp::new("perproject");
        let a = format!("{}/one.rondo", t.s());
        let b = format!("{}/two.js", t.s());
        write_project_sample(a.clone(), "take1".into(), vec![1]).unwrap();
        write_project_sample(b.clone(), "take1".into(), vec![2]).unwrap();
        // same NAME, different projects, different audio — the bug the browser
        // side had before the project id was threaded through
        assert_eq!(list_project_samples(a).unwrap()[0].1, vec![1]);
        assert_eq!(list_project_samples(b).unwrap()[0].1, vec![2]);
    }
}
