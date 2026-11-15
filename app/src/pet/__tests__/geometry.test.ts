import { readFileSync } from 'node:fs';
import { MIN_VISIBLE, clampToAreas, growWindow, isVisible, type Rect } from '../geometry';

const cases = JSON.parse(readFileSync('src-tauri/tests/pet-geometry-cases.json', 'utf-8')) as {
  minVisible: number;
  clamp: Array<{ name: string; areas: number[][]; rect: number[]; want: number[] }>;
  grow: Array<{ name: string; areas: number[][]; sprite: number[]; bubble: number[]; gap: number; want: { rect: number[]; side: string; align: string } }>;
};
const R = (a: number[]): Rect => ({ x: a[0], y: a[1], w: a[2], h: a[3] });

it('uses the same minimum as Rust', () => expect(MIN_VISIBLE).toBe(cases.minVisible));

describe.each(cases.clamp)('clampToAreas: $name', (c) => {
  it('matches the shared fixture', () => expect(clampToAreas(R(c.rect), c.areas.map(R))).toEqual(R(c.want)));
  it('is idempotent and leaves the rect visible', () => {
    const once = clampToAreas(R(c.rect), c.areas.map(R));
    expect(clampToAreas(once, c.areas.map(R))).toEqual(once);
    if (c.areas.length) expect(isVisible(once, c.areas.map(R))).toBe(true);
  });
});

describe.each(cases.grow)('growWindow: $name', (c) => {
  it('matches the shared fixture', () => {
    expect(growWindow(R(c.sprite), { w: c.bubble[0], h: c.bubble[1] }, c.gap, c.areas.map(R))).toEqual({ rect: R(c.want.rect), side: c.want.side, align: c.want.align });
  });
});

it('growWindow keeps the sprite inside the grown window', () => {
  const sprite = R([1700, 800, 96, 96]);
  const g = growWindow(sprite, { w: 320, h: 260 }, 8, [R([0, 0, 1920, 1040])]);
  expect(sprite.x).toBeGreaterThanOrEqual(g.rect.x);
  expect(sprite.x + sprite.w).toBeLessThanOrEqual(g.rect.x + g.rect.w);
  expect(sprite.y).toBeGreaterThanOrEqual(g.rect.y);
  expect(sprite.y + sprite.h).toBeLessThanOrEqual(g.rect.y + g.rect.h);
});

it('growWindow with no monitors known still returns a rect (above, right aligned)', () => {
  const g = growWindow(R([500, 500, 96, 96]), { w: 320, h: 260 }, 8, []);
  expect(g.side).toBe('above');
  expect(g.rect.w).toBe(320);
});

it('a high-DPI monitor (physical areas twice as big) behaves the same way', () => {
  const g = growWindow(R([3000, 1700, 192, 192]), { w: 640, h: 520 }, 16, [R([0, 0, 3840, 2080])]);
  expect(g.side).toBe('above');
  expect(g.rect.x + g.rect.w).toBeLessThanOrEqual(3840);
});
