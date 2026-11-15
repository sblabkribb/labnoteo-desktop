//! The pet window: a small transparent, borderless, always-on-top window created from Rust. Positions are physical
//! px; sizes asked for by the pages are logical px multiplied by the window's own scale factor.
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use super::commands::{Geometry, LayoutArgs, PetRuntime, StartResult};
use super::config::{self, PetConfig};
use super::geometry::{clamp_to_areas, default_position, Rect, MIN_VISIBLE};

pub const LABEL: &str = "pet";
const BUBBLE_GAP: u32 = 8;
const MAX_SPRITE: u32 = 512;
const WATCH_EVERY: Duration = Duration::from_secs(3);
const SAVE_AFTER_MOVE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Sprite,
    Toast,
    Panel,
}

/// The window size of a mode in logical px: the sprite alone, or the sprite stacked with a bubble.
pub fn size(mode: Mode, sprite: (u32, u32)) -> (u32, u32) {
    let (w, h) = sprite;
    match mode {
        Mode::Sprite => (w, h),
        Mode::Toast => (w.max(240), h + BUBBLE_GAP + 72),
        Mode::Panel => (w.max(320), h + BUBBLE_GAP + 260),
    }
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn config_of(rt: &PetRuntime) -> PetConfig {
    let dir = lock(&rt.config_dir).clone();
    match dir {
        Some(dir) => config::read(&dir),
        None => PetConfig::default(),
    }
}

/// Reads, changes and writes `pet-window.json`. With no config dir known nothing is written.
pub fn update_config(rt: &PetRuntime, f: impl FnOnce(&mut PetConfig)) {
    let dir = lock(&rt.config_dir).clone();
    if let Some(dir) = dir {
        let mut c = config::read(&dir);
        f(&mut c);
        let _ = config::write(&dir, &c);
    }
}

fn rect_of(x: i32, y: i32, w: u32, h: u32) -> Rect {
    Rect { x, y, w: w.min(i32::MAX as u32) as i32, h: h.min(i32::MAX as u32) as i32 }
}

fn work_areas<R: Runtime>(app: &AppHandle<R>) -> Vec<Rect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            rect_of(a.position.x, a.position.y, a.size.width, a.size.height)
        })
        .collect()
}

/// A change of monitors, resolution, position or scale shows up as a different signature.
fn signature<R: Runtime>(app: &AppHandle<R>) -> Vec<(i32, i32, u32, u32, u64)> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor().to_bits()))
        .collect()
}

fn px(logical: u32, scale: f64) -> i32 {
    (logical as f64 * scale).round() as i32
}

fn fail(reason: &'static str) -> StartResult {
    StartResult { ok: false, reason: Some(reason) }
}

pub fn start<R: Runtime>(app: &AppHandle<R>, rt: &PetRuntime, w: u32, h: u32) -> StartResult {
    if w == 0 || h == 0 || w > MAX_SPRITE || h > MAX_SPRITE {
        return fail("size");
    }
    if app.get_webview_window(LABEL).is_some() {
        return StartResult { ok: true, reason: None };
    }
    if rt.hidden.load(Ordering::SeqCst) {
        return fail("hidden");
    }
    match build(app, rt, w, h) {
        Some(()) => {
            watch(app);
            StartResult { ok: true, reason: None }
        }
        None => fail("build"),
    }
}

fn build<R: Runtime>(app: &AppHandle<R>, rt: &PetRuntime, w: u32, h: u32) -> Option<()> {
    let areas = work_areas(app);
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("pet.html".into()))
        .title("labnoteO pet")
        .inner_size(w as f64, h as f64)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .build()
        .ok()?;
    *lock(&rt.sprite_logical) = (w, h);
    *lock(&rt.offset) = (0, 0);
    *lock(&rt.mode) = Mode::Sprite;
    let scale = window.scale_factor().unwrap_or(1.0);
    let (sw, sh) = (px(w, scale), px(h, scale));
    let (x, y) = config_of(rt).pos.unwrap_or_else(|| default_position(sw, sh, &areas));
    let spot = clamp_to_areas(Rect { x, y, w: sw, h: sh }, &areas, MIN_VISIBLE);
    let _ = window.set_position(PhysicalPosition::new(spot.x, spot.y));
    // The target monitor may have another scale than the one the window was built on.
    let scale = window.scale_factor().unwrap_or(scale);
    let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
    let spot = Rect { w: px(w, scale), h: px(h, scale), ..spot };
    *lock(&rt.sprite) = Some(spot);
    window.show().ok()?;
    update_config(rt, |c| c.pos = Some((spot.x, spot.y)));
    Some(())
}

/// Tauri has no monitor-changed event: compare a signature every few seconds and re-clamp on a change.
fn watch<R: Runtime>(app: &AppHandle<R>) {
    let rt = app.state::<PetRuntime>();
    if rt.watcher.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last = signature(&app);
        loop {
            std::thread::sleep(WATCH_EVERY);
            let now = signature(&app);
            if now != last {
                last = now;
                if let Some(w) = app.get_webview_window(LABEL) {
                    let rt = app.state::<PetRuntime>();
                    reapply(&w.as_ref().window(), &rt);
                }
            }
        }
    });
}

/// The window rect right now, in physical px.
fn window_rect<R: Runtime>(window: &Window<R>) -> Option<Rect> {
    let p = window.outer_position().ok()?;
    let s = window.outer_size().ok()?;
    Some(rect_of(p.x, p.y, s.width, s.height))
}

/// Re-applies the logical size of the current mode at the window's own scale and re-clamps the whole window rect.
fn reapply<R: Runtime>(window: &Window<R>, rt: &PetRuntime) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let sprite = *lock(&rt.sprite_logical);
    let (w, h) = size(*lock(&rt.mode), sprite);
    let _ = window.set_size(LogicalSize::new(w as f64, h as f64));
    let areas = work_areas(window.app_handle());
    if let Some(r) = window_rect(window) {
        let r = Rect { w: px(w, scale), h: px(h, scale), ..r };
        let c = clamp_to_areas(r, &areas, MIN_VISIBLE);
        if c != r {
            let _ = window.set_position(PhysicalPosition::new(c.x, c.y));
        }
        let (ox, oy) = *lock(&rt.offset);
        *lock(&rt.sprite) = Some(Rect { x: c.x + ox, y: c.y + oy, w: px(sprite.0, scale), h: px(sprite.1, scale) });
    }
}

pub fn geometry<R: Runtime>(window: &WebviewWindow<R>, rt: &PetRuntime) -> Result<Geometry, String> {
    let sprite = (*lock(&rt.sprite)).ok_or("notStarted")?;
    Ok(Geometry { sprite, areas: work_areas(window.app_handle()), scale: window.scale_factor().unwrap_or(1.0) })
}

pub fn set_layout<R: Runtime>(window: &WebviewWindow<R>, rt: &PetRuntime, args: LayoutArgs) -> Result<(), String> {
    let scale = window.scale_factor().unwrap_or(1.0);
    let sprite_logical = *lock(&rt.sprite_logical);
    let sprite = (*lock(&rt.sprite)).ok_or("notStarted")?;
    let areas = work_areas(window.app_handle());
    let (target, offset) = match args.mode {
        Mode::Sprite => {
            let r = Rect { w: px(sprite_logical.0, scale), h: px(sprite_logical.1, scale), ..sprite };
            (clamp_to_areas(r, &areas, MIN_VISIBLE), (0, 0))
        }
        mode => {
            let want = args.rect.ok_or("rect")?;
            let (lw, lh) = size(mode, sprite_logical);
            if want.w <= 0 || want.h <= 0 || want.w > px(lw, scale) + 2 || want.h > px(lh, scale) + 2 {
                return Err("size".into());
            }
            let offset = (sprite.x - want.x, sprite.y - want.y);
            if offset.0 < 0 || offset.1 < 0 || offset.0 > want.w || offset.1 > want.h {
                return Err("rect".into());
            }
            (clamp_to_areas(want, &areas, MIN_VISIBLE), offset)
        }
    };
    let (lw, lh) = size(args.mode, sprite_logical);
    let growing = window_rect(&window.as_ref().window()).map(|c| target.w > c.w || target.h > c.h).unwrap_or(true);
    *lock(&rt.offset) = offset;
    *lock(&rt.mode) = args.mode;
    *lock(&rt.sprite) = Some(Rect { x: target.x + offset.0, y: target.y + offset.1, ..sprite });
    let pos = PhysicalPosition::new(target.x, target.y);
    let dim = LogicalSize::new(lw as f64, lh as f64);
    // The sprite never jumps: growing moves first, shrinking resizes first.
    if growing {
        let _ = window.set_position(pos);
        let _ = window.set_size(dim);
    } else {
        let _ = window.set_size(dim);
        let _ = window.set_position(pos);
    }
    if args.mode == Mode::Panel {
        let _ = window.set_focusable(true);
        let _ = window.set_focus();
    } else {
        let _ = window.set_focusable(false);
    }
    Ok(())
}

/// Forwarded from the app's window events; only for the pet window.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    let rt = window.state::<PetRuntime>();
    match event {
        WindowEvent::Moved(pos) => {
            let (ox, oy) = *lock(&rt.offset);
            let at = {
                let mut s = lock(&rt.sprite);
                if let Some(r) = s.as_mut() {
                    r.x = pos.x + ox;
                    r.y = pos.y + oy;
                }
                *s
            };
            let n = rt.moves.fetch_add(1, Ordering::SeqCst) + 1;
            let app = window.app_handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SAVE_AFTER_MOVE);
                let rt = app.state::<PetRuntime>();
                if rt.moves.load(Ordering::SeqCst) == n {
                    if let Some(r) = at {
                        update_config(&rt, |c| c.pos = Some((r.x, r.y)));
                    }
                }
            });
        }
        WindowEvent::ScaleFactorChanged { .. } => reapply(window, &rt),
        WindowEvent::Destroyed => announce_closed(window.app_handle()),
        _ => {}
    }
}

/// Tells the main window the desktop pet is gone (it then draws its own sprite again).
pub fn announce_closed<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.emit_to("main", "pet:closed", serde_json::json!({ "v": 1 }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("labnoteo-petwin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn the_three_sizes_for_a_96_sprite() {
        assert_eq!(size(Mode::Sprite, (96, 96)), (96, 96));
        assert_eq!(size(Mode::Toast, (96, 96)), (240, 176));
        assert_eq!(size(Mode::Panel, (96, 96)), (320, 364));
        assert_eq!(size(Mode::Toast, (300, 100)), (300, 180));
    }

    #[test]
    fn an_unknown_mode_or_field_is_refused() {
        assert!(serde_json::from_str::<Mode>("\"evil\"").is_err());
        assert_eq!(serde_json::from_str::<Mode>("\"panel\"").unwrap(), Mode::Panel);
        assert!(serde_json::from_str::<LayoutArgs>(r#"{"mode":"sprite","cmd":"x"}"#).is_err());
        assert!(serde_json::from_str::<LayoutArgs>(r#"{"mode":"toast","rect":{"x":1,"y":2,"w":3,"h":4}}"#).is_ok());
    }

    #[test]
    fn config_round_trips_through_the_runtime() {
        let d = dir("cfg");
        let rt = PetRuntime::default();
        // No dir known: defaults, and nothing is written.
        update_config(&rt, |c| c.quiet = true);
        assert_eq!(config_of(&rt), PetConfig::default());
        *rt.config_dir.lock().unwrap() = Some(d.clone());
        update_config(&rt, |c| c.quiet = true);
        update_config(&rt, |c| c.pos = Some((5, -6)));
        assert_eq!(config_of(&rt), PetConfig { pos: Some((5, -6)), quiet: true });
        let _ = std::fs::remove_dir_all(&d);
    }
}
