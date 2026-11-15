//! Commands only the pet window calls (`pet_start` and `pet_close`: only the main window). No vault, net or settings.
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

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
    /// Serialises the read-modify-write of `pet-window.json`.
    pub cfg_lock: Mutex<()>,
    /// One delayed position save at a time.
    pub saver: AtomicBool,
    /// The pet page's inbox: the main window's events reach it only through here, never through the global event bus.
    pub relay: Mutex<Option<Channel<serde_json::Value>>>,
    /// The panel bubble's size in logical px ((0, 0) until the pet starts); always clamped again when read.
    pub panel: Mutex<(u32, u32)>,
}

/// What the main window may hand to the pet, and what the pet may hand to the main window. Nothing else is relayed.
pub const TO_PET: [&str; 3] = ["pet:state", "pet:answer", "pet:reject"];
pub const TO_MAIN: [&str; 3] = ["pet:ask", "pet:clear", "pet:ready"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    pub sprite: Rect,
    pub areas: Vec<Rect>,
    pub scale: f64,
    pub panel: PanelInfo,
}

/// The panel bubble's size and the bounds for it on the sprite's monitor, in logical px.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PanelInfo {
    pub w: u32,
    pub h: u32,
    pub min_w: u32,
    pub min_h: u32,
    pub max_w: u32,
    pub max_h: u32,
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

// `async` runs it off the main thread: building a window from a synchronous command deadlocks on Windows.
#[tauri::command(async)]
pub fn pet_start<R: Runtime>(app: AppHandle<R>, rt: State<'_, PetRuntime>, sprite_w: u32, sprite_h: u32) -> StartResult {
    window::start(&app, &rt, sprite_w, sprite_h)
}

#[tauri::command]
pub fn pet_close<R: Runtime>(app: AppHandle<R>, rt: State<'_, PetRuntime>) {
    // The main window asks for this when the user switches the pet off: switching it on again starts a fresh one.
    rt.hidden.store(false, std::sync::atomic::Ordering::SeqCst);
    *rt.relay.lock().unwrap_or_else(|e| e.into_inner()) = None;
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

/// The pet page asks for a panel size (the person is dragging the bubble corner); the answer is the clamped size and bounds.
#[tauri::command]
pub fn pet_panel_size<R: Runtime>(window: WebviewWindow<R>, rt: State<'_, PetRuntime>, w: u32, h: u32, commit: bool) -> Result<PanelInfo, String> {
    window::set_panel(&window, &rt, w, h, commit)
}

#[tauri::command]
pub fn pet_hide<R: Runtime>(window: WebviewWindow<R>, rt: State<'_, PetRuntime>) {
    rt.hidden.store(true, std::sync::atomic::Ordering::SeqCst);
    // The window is destroyed, not just hidden: the destroy event tells the main window, which then draws its own sprite.
    let _ = window.destroy();
}

/// The pet page's one inbox for events from the main window (it has no event permission of its own).
#[tauri::command]
pub fn pet_subscribe(rt: State<'_, PetRuntime>, on_event: Channel<serde_json::Value>) {
    *rt.relay.lock().unwrap_or_else(|e| e.into_inner()) = Some(on_event);
}

/// Main window to pet: only the three pet events, over the pet's channel. False when the pet is not listening.
#[tauri::command]
pub fn pet_relay(rt: State<'_, PetRuntime>, event: String, payload: serde_json::Value) -> bool {
    if !TO_PET.contains(&event.as_str()) {
        return false;
    }
    let mut slot = rt.relay.lock().unwrap_or_else(|e| e.into_inner());
    match slot.as_ref().map(|c| c.send(serde_json::json!({ "event": event, "payload": payload }))) {
        Some(Ok(())) => true,
        Some(Err(_)) => {
            *slot = None;
            false
        }
        None => false,
    }
}

/// Pet to main window: only `pet:ask`, `pet:clear` and `pet:ready`, delivered to the main window alone.
#[tauri::command]
pub fn pet_to_main<R: Runtime>(app: AppHandle<R>, event: String, payload: serde_json::Value) -> bool {
    TO_MAIN.contains(&event.as_str()) && app.emit_to("main", &event, payload).is_ok()
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
