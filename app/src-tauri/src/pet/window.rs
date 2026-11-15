//! The pet window: a small transparent, borderless, always-on-top window created from Rust. Positions are physical
//! px; sizes asked for by the pages are logical px multiplied by the window's own scale factor.
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
    WindowEvent,
};

use super::commands::{Geometry, LayoutArgs, PanelInfo, PetRuntime, StartResult};
use super::config::{self, PetConfig};
use super::geometry::{clamp_to_areas, default_position, Rect, MIN_VISIBLE};

pub const LABEL: &str = "pet";
const BUBBLE_GAP: u32 = 8;
const MAX_SPRITE: u32 = 512;
const WATCH_EVERY: Duration = Duration::from_secs(3);
const SAVE_AFTER_MOVE: Duration = Duration::from_millis(300);
/// The panel bubble in logical px: the size it opens at, the smallest and the largest the person can drag it to.
pub const PANEL_DEFAULT: (u32, u32) = (360, 440);
pub const PANEL_MIN: (u32, u32) = (300, 340);
pub const PANEL_MAX: (u32, u32) = (640, 900);
/// Room kept between the window and the edge of the work area.
const SCREEN_MARGIN: u32 = 16;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Sprite,
    Toast,
    Panel,
}

/// The window size of a mode in logical px: the sprite alone, or the sprite stacked with a bubble (`panel` is the
/// panel bubble's own size).
pub fn size(mode: Mode, sprite: (u32, u32), panel: (u32, u32)) -> (u32, u32) {
    let (w, h) = sprite;
    match mode {
        Mode::Sprite => (w, h),
        Mode::Toast => (w.max(240), h + BUBBLE_GAP + 72),
        Mode::Panel => (w.max(panel.0), h + BUBBLE_GAP + panel.1),
    }
}

/// Smallest and largest panel bubble (logical px) that fit a work area of `area` logical px beside a sprite of
/// `sprite`: the fixed bounds, cut down to what the monitor has room for (the smallest never exceeds the largest).
pub fn panel_bounds(area: (u32, u32), sprite: (u32, u32)) -> ((u32, u32), (u32, u32)) {
    let max_w = PANEL_MAX.0.min(area.0.saturating_sub(SCREEN_MARGIN)).max(1);
    let max_h = PANEL_MAX.1.min(area.1.saturating_sub(sprite.1 + BUBBLE_GAP + SCREEN_MARGIN)).max(1);
    ((PANEL_MIN.0.min(max_w), PANEL_MIN.1.min(max_h)), (max_w, max_h))
}

/// A wanted panel size inside `panel_bounds`.
pub fn clamp_panel(want: (u32, u32), area: (u32, u32), sprite: (u32, u32)) -> (u32, u32) {
    let (lo, hi) = panel_bounds(area, sprite);
    (want.0.clamp(lo.0, hi.0), want.1.clamp(lo.1, hi.1))
}

/// The work area that holds the sprite's centre, else the one nearest to it.
fn area_of(areas: &[Rect], sprite: Option<Rect>) -> Option<Rect> {
    let s = sprite?;
    let (cx, cy) = (s.x as i64 + s.w as i64 / 2, s.y as i64 + s.h as i64 / 2);
    let inside = areas
        .iter()
        .find(|a| cx >= a.x as i64 && cx < a.x as i64 + a.w as i64 && cy >= a.y as i64 && cy < a.y as i64 + a.h as i64);
    inside
        .or_else(|| {
            areas.iter().min_by_key(|a| {
                let (mx, my) = (a.x as i64 + a.w as i64 / 2, a.y as i64 + a.h as i64 / 2);
                (cx - mx).pow(2) + (cy - my).pow(2)
            })
        })
        .copied()
}

/// The panel bubble's size right now: the saved or default size, clamped to the monitor the sprite is on.
fn effective_panel<R: Runtime>(app: &AppHandle<R>, rt: &PetRuntime, scale: f64) -> PanelInfo {
    let sprite_logical = *lock(&rt.sprite_logical);
    let areas = work_areas(app);
    let area = area_of(&areas, *lock(&rt.sprite)).or_else(|| areas.first().copied());
    let logical = |v: i32| ((v.max(0) as f64) / scale.max(0.1)).floor() as u32;
    let area_l = area
        .map(|a| (logical(a.w), logical(a.h)))
        .unwrap_or((PANEL_MAX.0 + SCREEN_MARGIN, PANEL_MAX.1 + sprite_logical.1 + BUBBLE_GAP + SCREEN_MARGIN));
    let stored = *lock(&rt.panel);
    let want = if stored == (0, 0) { PANEL_DEFAULT } else { stored };
    let (lo, hi) = panel_bounds(area_l, sprite_logical);
    let (w, h) = clamp_panel(want, area_l, sprite_logical);
    PanelInfo { w, h, min_w: lo.0, min_h: lo.1, max_w: hi.0, max_h: hi.1 }
}

fn panel_size<R: Runtime>(app: &AppHandle<R>, rt: &PetRuntime, scale: f64) -> (u32, u32) {
    let p = effective_panel(app, rt, scale);
    (p.w, p.h)
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
    // One writer at a time: a position save and a quiet toggle must not undo each other.
    let _guard = lock(&rt.cfg_lock);
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
    if rt.hidden.load(Ordering::SeqCst) {
        return fail("hidden");
    }
    if app.get_webview_window(LABEL).is_some() {
        return StartResult { ok: true, reason: None };
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
    *lock(&rt.panel) = config_of(rt).panel.unwrap_or(PANEL_DEFAULT);
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
    let (w, h) = size(*lock(&rt.mode), sprite, panel_size(window.app_handle(), rt, scale));
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
    let scale = window.scale_factor().unwrap_or(1.0);
    Ok(Geometry { sprite, areas: work_areas(window.app_handle()), scale, panel: effective_panel(window.app_handle(), rt, scale) })
}

/// The person is dragging the bubble corner: keep the size inside the bounds for this monitor (and save it when
/// `commit`). The page then asks for a layout with the new size.
pub fn set_panel<R: Runtime>(window: &WebviewWindow<R>, rt: &PetRuntime, w: u32, h: u32, commit: bool) -> Result<PanelInfo, String> {
    (*lock(&rt.sprite)).ok_or("notStarted")?;
    let scale = window.scale_factor().unwrap_or(1.0);
    let before = effective_panel(window.app_handle(), rt, scale);
    let (cw, ch) = (w.clamp(before.min_w, before.max_w), h.clamp(before.min_h, before.max_h));
    *lock(&rt.panel) = (cw, ch);
    if commit {
        update_config(rt, |c| c.panel = Some((cw, ch)));
    }
    Ok(effective_panel(window.app_handle(), rt, scale))
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
            let (lw, lh) = size(mode, sprite_logical, panel_size(window.app_handle(), rt, scale));
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
    let (lw, lh) = size(args.mode, sprite_logical, panel_size(window.app_handle(), rt, scale));
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
            if let Some(r) = lock(&rt.sprite).as_mut() {
                r.x = pos.x + ox;
                r.y = pos.y + oy;
            }
            rt.moves.fetch_add(1, Ordering::SeqCst);
            // One saver thread per drag, not one per Moved event: it waits until the window has been still.
            if !rt.saver.swap(true, Ordering::SeqCst) {
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    let rt = app.state::<PetRuntime>();
                    loop {
                        let seen = rt.moves.load(Ordering::SeqCst);
                        std::thread::sleep(SAVE_AFTER_MOVE);
                        if rt.moves.load(Ordering::SeqCst) == seen {
                            break;
                        }
                    }
                    rt.saver.store(false, Ordering::SeqCst);
                    settle(&app, &rt);
                });
            }
        }
        WindowEvent::ScaleFactorChanged { .. } => reapply(window, &rt),
        WindowEvent::Destroyed => announce_closed(window.app_handle()),
        _ => {}
    }
}

/// After a drag: pull the whole window back into a work area when it was dropped off screen, then save where the
/// sprite is. (`startDragging` has no limits of its own.)
fn settle<R: Runtime>(app: &AppHandle<R>, rt: &PetRuntime) {
    let Some(w) = app.get_webview_window(LABEL) else { return };
    let window = w.as_ref().window();
    if let Some(r) = window_rect(&window) {
        let c = clamp_to_areas(r, &work_areas(app), MIN_VISIBLE);
        if c != r {
            let _ = window.set_position(PhysicalPosition::new(c.x, c.y));
        }
        let (ox, oy) = *lock(&rt.offset);
        let spot = {
            let mut s = lock(&rt.sprite);
            if let Some(sp) = s.as_mut() {
                sp.x = c.x + ox;
                sp.y = c.y + oy;
            }
            *s
        };
        if let Some(sp) = spot {
            update_config(rt, |cfg| cfg.pos = Some((sp.x, sp.y)));
        }
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
        assert_eq!(size(Mode::Sprite, (96, 96), (320, 260)), (96, 96));
        assert_eq!(size(Mode::Toast, (96, 96), (320, 260)), (240, 176));
        assert_eq!(size(Mode::Panel, (96, 96), (320, 260)), (320, 364));
        assert_eq!(size(Mode::Panel, (96, 96), PANEL_DEFAULT), (360, 544));
        assert_eq!(size(Mode::Toast, (300, 100), (320, 260)), (300, 180));
        // a sprite wider than the bubble keeps its own width
        assert_eq!(size(Mode::Panel, (400, 100), (320, 260)), (400, 368));
    }

    #[test]
    fn the_panel_is_kept_between_the_bounds_and_the_monitor() {
        let area = (1920, 1200);
        let sprite = (96, 96);
        assert_eq!(clamp_panel((10, 10), area, sprite), PANEL_MIN);
        assert_eq!(clamp_panel((5000, 5000), area, sprite), PANEL_MAX);
        assert_eq!(clamp_panel((400, 500), area, sprite), (400, 500));
        // a small monitor cuts the largest size down: the height leaves room for the sprite, the gap and a margin
        assert_eq!(clamp_panel((900, 900), (500, 600), sprite), (500 - SCREEN_MARGIN, 600 - 96 - BUBBLE_GAP - SCREEN_MARGIN));
        // a very small area never makes the smallest bigger than the largest, and nothing is zero
        let (lo, hi) = panel_bounds((200, 150), sprite);
        assert!(lo.0 <= hi.0 && lo.1 <= hi.1 && lo.0 >= 1 && lo.1 >= 1, "{lo:?} {hi:?}");
        assert_eq!(panel_bounds((0, 0), (500, 500)), ((1, 1), (1, 1)));
    }

    #[test]
    fn the_work_area_of_the_sprite_is_the_one_holding_it() {
        let a = Rect { x: 0, y: 0, w: 1000, h: 800 };
        let b = Rect { x: 1000, y: 0, w: 1000, h: 800 };
        let on_b = Rect { x: 1100, y: 100, w: 64, h: 64 };
        assert_eq!(area_of(&[a, b], Some(on_b)), Some(b));
        let off = Rect { x: 5000, y: 100, w: 64, h: 64 };
        assert_eq!(area_of(&[a, b], Some(off)), Some(b));
        assert_eq!(area_of(&[a, b], None), None);
        assert_eq!(area_of(&[], Some(on_b)), None);
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
        assert_eq!(config_of(&rt), PetConfig { pos: Some((5, -6)), quiet: true, panel: None });
        update_config(&rt, |c| c.panel = Some((410, 520)));
        assert_eq!(config_of(&rt).panel, Some((410, 520)));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_position_save_and_a_quiet_toggle_at_once_keep_both() {
        let d = dir("both");
        let rt = std::sync::Arc::new(PetRuntime::default());
        *rt.config_dir.lock().unwrap() = Some(d.clone());
        let hs: Vec<_> = (0..40)
            .map(|i| {
                let rt = rt.clone();
                std::thread::spawn(move || if i % 2 == 0 { update_config(&rt, |c| c.quiet = true) } else { update_config(&rt, |c| c.pos = Some((i, i))) })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let c = config_of(&rt);
        assert!(c.quiet && c.pos.is_some(), "{c:?}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
