// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { LAYOUT_KEY } from '../layoutStore';

/**
 * public/theme-boot.js 는 첫 그림 전에 layoutStore 의 localStorage 거울(labnoteo.ui.layout)도 건다.
 * 브라우저 하네스의 첫 프레임용 캐시일 뿐이고, 앱에서는 Rust ui.json 이 load() 에서 이긴다.
 * 앱이 싣는 바로 그 파일을 읽어 돌린다.
 */
const BOOT = readFileSync('public/theme-boot.js', 'utf-8');
const html = document.documentElement;
const run = () => new Function(BOOT)() as unknown;

function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

beforeEach(() => {
  html.removeAttribute('style');
  for (const a of ['data-theme', 'data-left-hidden', 'data-right-open', 'data-density']) html.removeAttribute(a);
});
afterEach(() => vi.unstubAllGlobals());

describe('layout boot mirror', () => {
  it('reads the same key as layoutStore', () => {
    expect(BOOT).toContain(`'${LAYOUT_KEY}'`);
  });

  it('applies the mirrored widths through CSSOM and the attributes before first paint', () => {
    const mirror = { leftWidth: 320, leftHidden: true, rightWidth: 300, rightOpen: true, density: 'compact' };
    vi.stubGlobal('localStorage', memoryStorage({ [LAYOUT_KEY]: JSON.stringify(mirror) }));
    const setProperty = vi.spyOn(html.style, 'setProperty');
    run();
    expect(setProperty).toHaveBeenCalledWith('--side-w', '320px');
    expect(setProperty).toHaveBeenCalledWith('--right-w', '300px');
    expect(html.getAttribute('data-left-hidden')).toBe('true');
    expect(html.getAttribute('data-right-open')).toBe('true');
    expect(html.getAttribute('data-density')).toBe('compact');
    expect(BOOT).not.toMatch(/setAttribute\(\s*['"]style['"]/);
    expect(BOOT).not.toMatch(/\.style\s*=|cssText/);
  });

  it('clamps widths and ignores bad values like the store does', () => {
    vi.stubGlobal(
      'localStorage',
      memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ leftWidth: 5, rightWidth: 5000, leftHidden: 'yes', density: 'tiny' }) }),
    );
    run();
    expect(html.style.getPropertyValue('--side-w')).toBe('200px');
    expect(html.style.getPropertyValue('--right-w')).toBe('480px');
    expect(html.getAttribute('data-left-hidden')).toBe('false');
    expect(html.getAttribute('data-density')).toBe('comfortable');
  });

  it('no mirror or a corrupt one leaves the layout attributes unset (CSS defaults apply)', () => {
    for (const stored of [undefined, '{not json', '42', 'null']) {
      vi.stubGlobal('localStorage', memoryStorage(stored === undefined ? {} : { [LAYOUT_KEY]: stored }));
      expect(run).not.toThrow();
      expect(html.hasAttribute('data-left-hidden'), String(stored)).toBe(false);
      expect(html.style.getPropertyValue('--side-w')).toBe('');
    }
  });

  it('a throwing storage is tolerated and the theme part still runs', () => {
    const deny = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: deny });
    expect(run).not.toThrow();
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: deny });
    try {
      expect(run).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
    // the theme still applies when only the layout mirror is broken
    vi.stubGlobal('localStorage', memoryStorage({ 'labnoteo.theme': 'dark', [LAYOUT_KEY]: '{bad' }));
    run();
    expect(html.getAttribute('data-theme')).toBe('dark');
  });
});
