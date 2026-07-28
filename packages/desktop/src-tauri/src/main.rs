// Desktop shell for rondocode. The web app is the whole UI; this process adds
// the two things a browser cannot give it: real files, and a virtual MIDI port
// a DAW can see. Commands stay thin — no music logic lives here.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod midi;

use files::{OpenedFile, WorkspaceEntry};

#[tauri::command]
fn open_project_dialog() -> Result<Option<OpenedFile>, String> {
    files::open_dialog()
}

#[tauri::command]
fn open_project_path(path: String) -> Result<OpenedFile, String> {
    files::open_path(path)
}

#[tauri::command]
fn save_project(path: String, code: String) -> Result<String, String> {
    files::save_path(path, code)
}

#[tauri::command]
fn save_project_dialog(suggested: String, code: String) -> Result<Option<String>, String> {
    files::save_dialog(suggested, code)
}

#[tauri::command]
fn choose_render_folder() -> Result<Option<String>, String> {
    files::choose_folder()
}

#[tauri::command]
fn write_render(dir: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    files::write_bytes(dir, name, bytes)
}

/// The project files in a workspace folder, newest first.
#[tauri::command]
fn list_workspace(dir: String) -> Result<Vec<WorkspaceEntry>, String> {
    files::list_workspace(dir)
}

#[tauri::command]
fn create_in_workspace(dir: String, name: String, ext: String, code: String) -> Result<String, String> {
    files::create_in_workspace(dir, name, ext, code)
}

#[tauri::command]
fn rename_in_workspace(path: String, new_name: String) -> Result<String, String> {
    files::rename_in_workspace(path, new_name)
}

#[tauri::command]
fn trash_file(path: String) -> Result<(), String> {
    files::trash_file(path)
}

/// Publish the virtual MIDI source. Idempotent: calling twice keeps one port,
/// so a DAW never sees a duplicate device.
#[tauri::command]
fn midi_open(name: Option<String>) -> Result<String, String> {
    midi::open(name.as_deref().unwrap_or("rondocode"))
}

#[tauri::command]
fn midi_is_open() -> bool {
    midi::is_open()
}

/// Raw MIDI bytes out of the virtual source. The app already builds MIDI for
/// its WebMIDI output and clock, so this takes the same bytes.
#[tauri::command]
fn midi_send(bytes: Vec<u8>) -> Result<(), String> {
    midi::send(&bytes)
}

/// Send so the bytes LAND `delay_ms` from now. CoreMIDI holds the packet until
/// its timestamp, which is what makes a DAW recording land on the grid.
#[tauri::command]
fn midi_send_at(bytes: Vec<u8>, delay_ms: f64) -> Result<(), String> {
    midi::send_after(&bytes, delay_ms)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            open_project_dialog,
            open_project_path,
            save_project,
            save_project_dialog,
            choose_render_folder,
            list_workspace,
            create_in_workspace,
            rename_in_workspace,
            trash_file,
            write_render,
            midi_open,
            midi_is_open,
            midi_send,
            midi_send_at,
        ])
        .run(tauri::generate_context!())
        .expect("error while running rondocode desktop");
}
