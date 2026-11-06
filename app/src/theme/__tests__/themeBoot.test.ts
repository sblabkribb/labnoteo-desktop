// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { THEME_KEY } from '../useTheme';

/**
 * public/theme-boot.js: index.html 의 <head> 에서 React 보다 먼저, 첫 그림 전에 도는 고전 스크립트.
 * 저장된 수동 선택을 html data-theme 에 미리 걸어, 라이트 OS 에서 다크를 고른 사람이 라이트 한 프레임을 보지 않게 한다.
 * 파일을 그대로 읽어 전역(localStorage, document)에서 돌린다 — 앱이 싣는 바로 그 글자를 검사한다.
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

beforeEach(() => html.removeAttribute('data-theme'));
afterEach(() => vi.unstubAllGlobals());

describe('테마 부트 스크립트', () => {
  it('저장된 다크·라이트 선택을 첫 그림 전에 html data-theme 에 건다', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [THEME_KEY]: 'dark' }));
    run();
    expect(html.getAttribute('data-theme')).toBe('dark');
    html.removeAttribute('data-theme');
    vi.stubGlobal('localStorage', memoryStorage({ [THEME_KEY]: 'light' }));
    run();
    expect(html.getAttribute('data-theme')).toBe('light');
  });

  it('useTheme 과 같은 키를 읽는다: 다른 키의 값은 보지 않는다', () => {
    expect(BOOT).toContain(`'${THEME_KEY}'`);
    vi.stubGlobal('localStorage', memoryStorage({ 'labnoteo.other': 'dark' }));
    run();
    expect(html.hasAttribute('data-theme')).toBe(false);
  });

  it('system, 알 수 없는 값, 저장된 값 없음이면 속성을 걸지 않는다 (시스템 설정을 따른다)', () => {
    for (const stored of ['system', 'sepia', 'DARK', '', undefined]) {
      vi.stubGlobal('localStorage', memoryStorage(stored === undefined ? {} : { [THEME_KEY]: stored }));
      run();
      expect(html.hasAttribute('data-theme'), String(stored)).toBe(false);
    }
  });

  it('저장소가 없거나, 읽기가 던지거나, 저장소에 닿기만 해도 던져도 조용히 넘어간다', () => {
    const deny = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', undefined);
    expect(run).not.toThrow();
    vi.stubGlobal('localStorage', { getItem: deny });
    expect(run).not.toThrow();
    // 저장소가 막힌 WebView 는 localStorage 에 닿는 순간 SecurityError 를 던진다
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: deny });
    try {
      expect(run).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    expect(html.hasAttribute('data-theme')).toBe(false);
  });

  it('모듈이 아닌 고전 스크립트로 읽힌다: import/export 가 없고 전역을 남기지 않는다', () => {
    expect(BOOT).not.toMatch(/^\s*(import|export)\s/m);
    const before = new Set(Object.keys(globalThis));
    vi.stubGlobal('localStorage', memoryStorage({ [THEME_KEY]: 'dark' }));
    // 고전 스크립트처럼 전역 범위에서 돌린다(간접 eval): 맨 위의 var·function 은 전역이 된다
    (0, eval)(BOOT);
    expect(Object.keys(globalThis).filter((k) => !before.has(k) && k !== 'localStorage')).toEqual([]);
    expect(html.getAttribute('data-theme')).toBe('dark');
  });
});
