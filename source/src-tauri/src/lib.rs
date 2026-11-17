// Abyssal Garden app shell, shared by the Windows build (main.rs) and the Android build (mobile entry point).
// Everything (WebGPU rendering, audio, input, game logic) lives in the page in ../../dist. The shell provides the
// window, opening links in the system browser (update downloads), and the LAN multiplayer transport (lan.rs).
pub mod lan;

// Save & quit: the page saves first, then asks the app to exit (closing the window does not end the app on Android)
#[tauri::command]
fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![lan::lan_host, lan::lan_stop, lan::lan_scan, lan::lan_log, app_exit])
        .run(tauri::generate_context!())
        .expect("error while running Abyssal Garden");
}
