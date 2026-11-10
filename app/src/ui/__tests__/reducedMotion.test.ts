// @vitest-environment jsdom
/** prefers-reduced-motion 을 <html data-reduced-motion> 으로 비춘다: 미디어 쿼리를 쓸 수 없는 코드(스프라이트, 끌기)가 읽는다. */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startReducedMotionMirror } from '../reducedMotion';

type Listener = (e: { matches: boolean }) => void;

function fakeMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: vi.fn((_: string, l: Listener) => void listeners.add(l)),
    removeEventListener: vi.fn((_: string, l: Listener) => void listeners.delete(l)),
  };
  const matchMedia = vi.fn(() => mql);
  return {
    win: { matchMedia } as unknown as Window,
    matchMedia,
    set(v: boolean) {
      mql.matches = v;
      for (const l of [...listeners]) l({ matches: v });
    },
    listeners,
  };
}

const attr = () => document.documentElement.getAttribute('data-reduced-motion');

afterEach(() => document.documentElement.removeAttribute('data-reduced-motion'));

describe('reduced-motion mirror', () => {
  it('sets data-reduced-motion when the user asks for reduced motion, and follows change events', () => {
    const f = fakeMatchMedia(true);
    const stop = startReducedMotionMirror(f.win, document.documentElement);
    expect(f.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(attr()).toBe('');
    f.set(false);
    expect(attr()).toBeNull();
    f.set(true);
    expect(attr()).toBe('');
    stop();
    expect(f.listeners.size).toBe(0);
    expect(attr()).toBeNull();
  });

  it('leaves the attribute off when motion is fine', () => {
    const f = fakeMatchMedia(false);
    const stop = startReducedMotionMirror(f.win, document.documentElement);
    expect(attr()).toBeNull();
    stop();
  });

  it('does nothing (and does not throw) where matchMedia is missing', () => {
    const stop = startReducedMotionMirror({} as Window, document.documentElement);
    expect(attr()).toBeNull();
    stop();
  });

  it('main.tsx starts the mirror', () => {
    expect(readFileSync('src/main.tsx', 'utf-8')).toMatch(/startReducedMotionMirror\(\)/);
  });
});
