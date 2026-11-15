//! Commands only the pet window calls (`pet_start` and `pet_close`: only the main window). No vault, net or settings.
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

use super::{geometry::Rect, window};

#[derive(Default)]
pub struct PetRuntime {
    /// Hidden until the next start ("Hide for now"). Never saved.
    pub hidden: AtomicBool,
    /// The sprite's rect (physical px); the grown window keeps it as its anchor.
    pub sprite: Mutex<Option<Rect>>,
    /// The sprite's size in logical px, as the main window asked for it at start.
    pub sprite_logical: Mutex<(u32, u32)>,
    /// Where the sprite sits inside the window right now (physical px), for `Moved`.
    pub offset: Mutex<(i32, i32)>,
    pub mode: Mutex<window::Mode>,
    pub config_dir: Mutex<Option<std::path::PathBuf>>,
    /// Bumped on every move; a delayed save runs only if nothing moved since.
    pub moves: AtomicU64,
    /// The monitor watcher thread runs once per process.
    pub watcher: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub sprite: Rect,
    pub areas: Vec<Rect>,
    pub scale: f64,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutArgs {
    pub mode: window::Mode,
    /// The window rect the pet page computed with `growWindow` (physical px); required for toast and panel.
    pub rect: Option<Rect>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub ok: bool,
    pub reason: Option<&'static str>,
}

#[tauri::command]
pub fn pet_start<R: Runtime>(app: AppHandle<R>, rt: State<'_, PetRuntime>, sprite_w: u32, sprite_h: u32) -> StartResult {
    window::start(&app, &rt, sprite_w, sprite_h)
}

#[tauri::command]
pub fn pet_close<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window("pet") {
        let _ = w.destroy();
    }
}

#[tauri::command]
pub fn pet_geometry<R: Runtime>(window: WebviewWindow<R>, rt: State<'_, PetRuntime>) -> Result<Geometry, String> {
    window::geometry(&window, &rt)
}

#[tauri::command]
pub fn pet_set_layout<R: Runtime>(window: WebviewWindow<R>, rt: State<'_, PetRuntime>, args: LayoutArgs) -> Result<(), String> {
    window::set_layout(&window, &rt, args)
}

#[tauri::command]
pub fn pet_hide<R: Runtime>(window: WebviewWindow<R>, rt: State<'_, PetRuntime>) {
    rt.hidden.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = window.hide();
}

/// The one place the main window is raised.
#[tauri::command]
pub fn pet_open_main<R: Runtime>(app: AppHandle<R>) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

#[tauri::command]
pub fn pet_quiet_get(rt: State<'_, PetRuntime>) -> bool {
    window::config_of(&rt).quiet
}

#[tauri::command]
pub fn pet_quiet_set(rt: State<'_, PetRuntime>, quiet: bool) {
    window::update_config(&rt, |c| c.quiet = quiet);
}

/// The pet page could not draw even the built-in skin: close the window and tell the main window (it shows its own sprite).
#[tauri::command]
pub fn pet_start_failed<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) {
    let _ = window.destroy();
    window::announce_closed(&app);
}
