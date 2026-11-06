// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { LANG_KEY } from '../lang';

/**
 * public/lang-boot.js: index.html 의 <head> 에서 React 보다 먼저, 첫 그림 전에 도는 고전 스크립트.
 * 앱이 고를 언어를 html lang 에 미리 건다(화면 낭독기와 글꼴 선택이 첫 프레임부터 맞는 언어를 본다).
 * 고르는 규칙은 src/i18n/lang.ts 와 같아야 한다: 저장된 ko/en, 없으면 navigator.language 가 ko 이거나 ko- 로 시작할 때만 ko.
 * 파일을 그대로 읽어 전역(localStorage, navigator, document)에서 돌린다 — 앱이 싣는 바로 그 글자를 검사한다.
 */
const BOOT = readFileSync('public/lang-boot.js', 'utf-8');
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

function boot(stored: Record<string, string> | undefined, language: string | undefined) {
  vi.stubGlobal('localStorage', stored === undefined ? undefined : memoryStorage(stored));
  vi.stubGlobal('navigator', language === undefined ? undefined : { language });
  html.lang = 'xx'; // index.html 의 처음 값이 무엇이든 덮어쓰는지 본다
  run();
  return html.lang;
}

afterEach(() => vi.unstubAllGlobals());

describe('언어 부트 스크립트', () => {
  it('저장된 선택을 html lang 에 건다: 브라우저 언어보다 먼저다', () => {
    expect(boot({ [LANG_KEY]: 'en' }, 'ko-KR')).toBe('en');
    expect(boot({ [LANG_KEY]: 'ko' }, 'en-US')).toBe('ko');
  });

  it('lang.ts 와 같은 키를 읽는다: 다른 키의 값은 보지 않는다', () => {
    expect(BOOT).toContain(`'${LANG_KEY}'`);
    expect(boot({ 'labnoteo.other': 'ko' }, 'en-US')).toBe('en');
  });

  it('저장된 선택이 없거나 모르는 값이면 navigator.language 가 ko 이거나 ko- 로 시작할 때만 ko, 아니면 en', () => {
    for (const stored of [{}, { [LANG_KEY]: 'fr' }, { [LANG_KEY]: 'KO' }] as Array<Record<string, string>>) {
      expect(boot(stored, 'ko-KR'), JSON.stringify(stored)).toBe('ko');
      expect(boot(stored, 'KO'), JSON.stringify(stored)).toBe('ko');
      expect(boot(stored, 'en-US'), JSON.stringify(stored)).toBe('en');
      expect(boot(stored, 'ja'), JSON.stringify(stored)).toBe('en');
      expect(boot(stored, 'kok-IN'), JSON.stringify(stored)).toBe('en'); // 콘칸어: ko 로 시작하지만 한국어가 아니다
    }
    expect(boot({}, undefined)).toBe('en');
  });

  it('저장소가 없거나, 읽기가 던지거나, 저장소에 닿기만 해도 던져도 브라우저 언어로 건다', () => {
    expect(boot(undefined, 'ko-KR')).toBe('ko');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); } });
    vi.stubGlobal('navigator', { language: 'ko-KR' });
    html.lang = 'xx';
    expect(run).not.toThrow();
    expect(html.lang).toBe('ko');
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('denied');
      },
    });
    try {
      vi.stubGlobal('navigator', { language: 'en-US' });
      html.lang = 'xx';
      expect(run).not.toThrow();
      expect(html.lang).toBe('en');
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });

  it('모듈이 아닌 고전 스크립트로 읽힌다: import/export 가 없고 전역을 남기지 않는다', () => {
    expect(BOOT).not.toMatch(/^\s*(import|export)\s/m);
    vi.stubGlobal('localStorage', memoryStorage({ [LANG_KEY]: 'en' }));
    const before = new Set(Object.keys(globalThis));
    (0, eval)(BOOT);
    expect(Object.keys(globalThis).filter((k) => !before.has(k))).toEqual([]);
    expect(html.lang).toBe('en');
  });
});
