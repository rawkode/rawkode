#[cfg(desktop)]
mod desktop;
mod preferences;
mod storage;

use preferences::Settings;
use std::{
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Emitter, Manager, State};

struct AppState {
    notes: Mutex<storage::NoteStore>,
    settings: Mutex<Settings>,
    settings_path: PathBuf,
    preview_directory: PathBuf,
    quit_requested: AtomicBool,
    allow_exit: AtomicBool,
    _instance_lock: fs::File,
}

fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only the notebook window may use this command.".into())
    }
}

#[tauri::command]
async fn load_day(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    day: String,
) -> Result<storage::LoadedDay, String> {
    main_window(&window)?;
    state
        .notes
        .lock()
        .map_err(|_| "Note storage is unavailable.")?
        .load_day(&day)
}

#[tauri::command]
async fn save_day(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    request: storage::SaveRequest,
) -> Result<storage::SaveReceipt, String> {
    main_window(&window)?;
    state
        .notes
        .lock()
        .map_err(|_| "Note storage is unavailable.")?
        .save_day(request)
}

#[tauri::command]
fn get_settings(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Settings, String> {
    main_window(&window)?;
    Ok(state
        .settings
        .lock()
        .map_err(|_| "Settings are unavailable.")?
        .clone())
}

#[tauri::command]
fn save_settings(
    window: tauri::WebviewWindow,
    _app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    main_window(&window)?;
    let mut current = state
        .settings
        .lock()
        .map_err(|_| "Settings are unavailable.")?;
    settings.save(&state.settings_path)?;
    *current = settings.clone();
    #[cfg(desktop)]
    if let Some(tray) = _app.tray_by_id("notebook") {
        tray.set_visible(settings.show_menu_bar_item)
            .map_err(|e| e.to_string())?;
    }
    Ok(settings)
}

#[tauri::command]
async fn load_preview(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    key: String,
) -> Result<Option<String>, String> {
    main_window(&window)?;
    preferences::load_preview(&state.preview_directory, &key)
}

#[tauri::command]
async fn save_preview(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    key: String,
    data_url: String,
) -> Result<(), String> {
    main_window(&window)?;
    preferences::save_preview(&state.preview_directory, &key, &data_url)
}

#[tauri::command]
fn finish_quit(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    token: Option<String>,
    sequence: u64,
) -> Result<(), String> {
    main_window(&window)?;
    if !state.quit_requested.load(Ordering::SeqCst) {
        return Err("No quit request is pending.".into());
    }
    state
        .notes
        .lock()
        .map_err(|_| "Note storage is unavailable.")?
        .can_finish_quit(token.as_deref(), sequence)?;
    state.allow_exit.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

fn request_quit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    state.quit_requested.store(true, Ordering::SeqCst);
    let _ = app.emit_to("main", "app-command", "flush-and-quit");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            fs::create_dir_all(&directory)?;
            let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(directory.join(".instance.lock"))?;
            fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| std::io::Error::other("Enchiridion is already running. Open its existing window."))?;
            #[cfg(target_os = "macos")]
            let legacy = Some(app.path().home_dir()?.join("Library/Containers/com.rawkode.enchiridion.macos/Data/Library/Application Support/Enchiridion/DailyNotes"));
            #[cfg(not(target_os = "macos"))]
            let legacy = None;
            let settings_path = directory.join("settings.json");
            let settings = Settings::load(&settings_path).map_err(std::io::Error::other)?;
            #[cfg(desktop)]
            let show_tray = settings.show_menu_bar_item;
            app.manage(AppState {
                notes: Mutex::new(storage::NoteStore::new(directory.join("DailyNotes"), legacy)),
                settings: Mutex::new(settings), settings_path,
                preview_directory: app.path().app_cache_dir()?.join("DiagramPreviews"),
                quit_requested: AtomicBool::new(false), allow_exit: AtomicBool::new(false),
                _instance_lock: lock,
            });
            #[cfg(desktop)] desktop::install(app, show_tray)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_day, save_day, get_settings, save_settings, load_preview, save_preview, finish_quit])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<AppState>().allow_exit.load(Ordering::SeqCst) {
                    api.prevent_close();
                    request_quit(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to initialize Enchiridion");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { ref api, .. } = event {
            if !app.state::<AppState>().allow_exit.load(Ordering::SeqCst) {
                api.prevent_exit();
                request_quit(app);
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            desktop::show(app);
        }
    });
}
