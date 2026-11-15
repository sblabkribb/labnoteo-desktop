/** Physical-pixel geometry for the desktop pet window (plan D9). Rust has the same clamp; both read pet-geometry-cases.json. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_VISIBLE = 24;

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;
const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return { w: Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)), h: Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y)) };
}

/** True when some work area shows at least `min` px of the rect in both directions (or all of it, if it is smaller). */
export function isVisible(r: Rect, areas: Rect[], min = MIN_VISIBLE): boolean {
  return areas.some((a) => {
    const o = overlap(r, a);
    return o.w >= Math.min(min, r.w) && o.h >= Math.min(min, r.h);
  });
}

function nearest(r: Rect, areas: Rect[]): Rect | undefined {
  const c = centre(r);
  let best: Rect | undefined;
  let bestD = Infinity;
  for (const a of areas) {
    const m = centre(a);
    const d = (c.x - m.x) ** 2 + (c.y - m.y) ** 2;
    if (d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best;
}

/** Left alone when visible, otherwise moved fully inside the nearest work area (pinned to its corner if it does not fit). */
export function clampToAreas(r: Rect, areas: Rect[], min = MIN_VISIBLE): Rect {
  if (areas.length === 0 || isVisible(r, areas, min)) return r;
  const a = nearest(r, areas) as Rect;
  return { ...r, x: clamp(r.x, a.x, a.x + a.w - r.w), y: clamp(r.y, a.y, a.y + a.h - r.h) };
}

export interface Grown {
  rect: Rect;
  side: 'above' | 'below';
  align: 'left' | 'right';
}

/**
 * The window rect that holds the sprite plus a bubble of `bubble` size (physical px) and a `gap`: bubble above and right aligned with
 * the sprite when that fits inside the work area holding the sprite, otherwise flipped below and/or left aligned. When neither side has
 * room, the side with more room wins and the rect is pinned inside the area.
 */
export function growWindow(sprite: Rect, bubble: { w: number; h: number }, gap: number, areas: Rect[]): Grown {
  const w = Math.max(sprite.w, bubble.w);
  const h = sprite.h + gap + bubble.h;
  const c = centre(sprite);
  const area = areas.find((a) => c.x >= a.x && c.x < right(a) && c.y >= a.y && c.y < bottom(a)) ?? nearest(sprite, areas);
  if (!area) return { rect: { x: right(sprite) - w, y: sprite.y - gap - bubble.h, w, h }, side: 'above', align: 'right' };
  const rightX = right(sprite) - w;
  const align = rightX >= area.x ? 'right' : 'left';
  const x0 = align === 'right' ? rightX : sprite.x;
  const aboveY = sprite.y - gap - bubble.h;
  const spaceAbove = sprite.y - gap - area.y;
  const spaceBelow = bottom(area) - bottom(sprite) - gap;
  const side = aboveY >= area.y ? 'above' : sprite.y + h <= bottom(area) ? 'below' : spaceAbove > spaceBelow ? 'above' : 'below';
  const y0 = side === 'above' ? aboveY : sprite.y;
  return { rect: { x: clamp(x0, area.x, right(area) - w), y: clamp(y0, area.y, bottom(area) - h), w, h }, side, align };
}
