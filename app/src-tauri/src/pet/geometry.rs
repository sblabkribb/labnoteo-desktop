//! Position clamp for the pet window, physical px. Same rule and same cases as `src/pet/geometry.ts`
//! (`tests/pet-geometry-cases.json`).
use serde::{Deserialize, Serialize};

pub const MIN_VISIBLE: i32 = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    fn right(&self) -> i64 {
        self.x as i64 + self.w as i64
    }
    fn bottom(&self) -> i64 {
        self.y as i64 + self.h as i64
    }
    /// Twice the centre, so no division.
    fn centre2(&self) -> (i128, i128) {
        (2 * self.x as i128 + self.w as i128, 2 * self.y as i128 + self.h as i128)
    }
}

fn overlap(a: &Rect, b: &Rect) -> (i64, i64) {
    let w = a.right().min(b.right()) - (a.x as i64).max(b.x as i64);
    let h = a.bottom().min(b.bottom()) - (a.y as i64).max(b.y as i64);
    (w.max(0), h.max(0))
}

pub fn is_visible(r: &Rect, areas: &[Rect], min: i32) -> bool {
    areas.iter().any(|a| {
        let (w, h) = overlap(r, a);
        w >= min.min(r.w) as i64 && h >= min.min(r.h) as i64
    })
}

fn clamp_i(n: i64, lo: i64, hi: i64) -> i32 {
    n.max(lo).min(hi.max(lo)).clamp(i32::MIN as i64, i32::MAX as i64) as i32
}

/// Left alone when `min` px of it show on some work area in both directions, otherwise moved fully inside the work
/// area with the nearest centre (pinned to its corner when it does not fit). No areas: unchanged.
pub fn clamp_to_areas(r: Rect, areas: &[Rect], min: i32) -> Rect {
    if areas.is_empty() || is_visible(&r, areas, min) {
        return r;
    }
    let c = r.centre2();
    let a = areas
        .iter()
        .min_by_key(|a| {
            let m = a.centre2();
            (c.0 - m.0).pow(2) + (c.1 - m.1).pow(2) // i128: i32 extremes squared overflow i64
        })
        .expect("areas is not empty");
    Rect {
        x: clamp_i(r.x as i64, a.x as i64, a.right() - r.w as i64),
        y: clamp_i(r.y as i64, a.y as i64, a.bottom() - r.h as i64),
        ..r
    }
}

/// First start: bottom right of the first work area, 24 px from the edges.
pub fn default_position(sprite_w: i32, sprite_h: i32, areas: &[Rect]) -> (i32, i32) {
    const MARGIN: i64 = 24;
    match areas.first() {
        Some(a) => (
            clamp_i(a.right() - sprite_w as i64 - MARGIN, a.x as i64, i64::MAX / 4),
            clamp_i(a.bottom() - sprite_h as i64 - MARGIN, a.y as i64, i64::MAX / 4),
        ),
        None => (100, 100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn rect(v: &Value) -> Rect {
        let a: Vec<i32> = v.as_array().unwrap().iter().map(|n| n.as_i64().unwrap() as i32).collect();
        Rect { x: a[0], y: a[1], w: a[2], h: a[3] }
    }

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../tests/pet-geometry-cases.json")).unwrap()
    }

    #[test]
    fn min_matches_the_typescript_side() {
        assert_eq!(cases()["minVisible"].as_i64().unwrap() as i32, MIN_VISIBLE);
    }

    #[test]
    fn every_shared_clamp_case_matches_and_is_idempotent() {
        for c in cases()["clamp"].as_array().unwrap() {
            let areas: Vec<Rect> = c["areas"].as_array().unwrap().iter().map(rect).collect();
            let got = clamp_to_areas(rect(&c["rect"]), &areas, MIN_VISIBLE);
            assert_eq!(got, rect(&c["want"]), "{}", c["name"]);
            assert_eq!(clamp_to_areas(got, &areas, MIN_VISIBLE), got, "idempotent: {}", c["name"]);
        }
    }

    #[test]
    fn extreme_coordinates_do_not_overflow() {
        let areas = [Rect { x: 0, y: 0, w: 1920, h: 1080 }];
        for (x, y) in [(i32::MAX, i32::MIN), (i32::MIN, i32::MAX), (i32::MAX, i32::MAX)] {
            let r = clamp_to_areas(Rect { x, y, w: 96, h: 96 }, &areas, MIN_VISIBLE);
            assert!(is_visible(&r, &areas, MIN_VISIBLE));
        }
    }

    #[test]
    fn default_position_is_bottom_right_with_a_margin() {
        assert_eq!(default_position(96, 96, &[Rect { x: 0, y: 0, w: 1920, h: 1040 }]), (1800, 920));
        assert_eq!(default_position(96, 96, &[]), (100, 100));
    }
}
