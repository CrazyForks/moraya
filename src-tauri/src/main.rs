// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // PDF export subprocess child mode (Windows/Linux): the parent process
    // spawns Moraya with --print-pdf-config=<tmp.json>. Detecting that flag
    // BEFORE tauri::Builder runs is critical, otherwise tauri_plugin_single_instance
    // would forward the argv to an already-running Moraya and the spawned
    // process would exit silently with the print job never executed.
    if let Some(cfg_path) = moraya_lib::detect_print_child_arg(std::env::args()) {
        moraya_lib::run_print_child(&cfg_path);
        return;
    }

    moraya_lib::run()
}
