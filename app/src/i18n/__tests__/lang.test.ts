// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';

/**
 * 언어 저장소(src/i18n/lang.ts). 처음 고르는 규칙은 모듈을 읽을 때 한 번 돈다:
 * 그래서 경우마다 모듈을 새로 읽는다(vi.resetModules + 동적 import).
 */

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

const KEY = 'labnoteo.lang';
const deny = () => {
  throw new Error('denied');
};

async function fresh(storage: unknown, language: string | undefined) {
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('navigator', language === undefined ? undefined : { language });
  vi.resetModules();
  const lang = await import('../lang');
  const { t } = await import('../t');
  const { useLang } = await import('../useLang');
  return { ...lang, t, useLang };
}

afterEach(() => vi.unstubAllGlobals());

describe('언어 저장소: 처음 고르기', () => {
  it('저장 키는 labnoteo.lang 이다 (바꾸면 모든 사용자의 선택이 버려진다)', async () => {
    const { LANG_KEY } = await fresh(memoryStorage(), 'en-US');
    expect(LANG_KEY).toBe(KEY);
  });

  it('저장된 선택이 없으면 navigator.language 가 ko 이거나 ko- 로 시작할 때만 한국어다', async () => {
    for (const [language, expected] of [
      ['ko-KR', 'ko'],
      ['ko', 'ko'],
      ['KO-kr', 'ko'],
      ['en-US', 'en'],
      ['ja-JP', 'en'],
      ['kok-IN', 'en'], // 콘칸어: ko 로 시작하지만 한국어가 아니다
      ['kos', 'en'],
      ['', 'en'],
    ] as const) {
      const { getLang } = await fresh(memoryStorage(), language);
      expect(getLang(), language).toBe(expected);
    }
  });

  it('navigator 가 없으면 영어다', async () => {
    const { getLang } = await fresh(memoryStorage(), undefined);
    expect(getLang()).toBe('en');
  });

  it('저장된 선택이 브라우저 언어보다 먼저다', async () => {
    expect((await fresh(memoryStorage({ [KEY]: 'en' }), 'ko-KR')).getLang()).toBe('en');
    expect((await fresh(memoryStorage({ [KEY]: 'ko' }), 'en-US')).getLang()).toBe('ko');
  });

  it('저장된 값을 모르면 무시하고 브라우저 언어를 따른다', async () => {
    for (const stored of ['fr', 'KO', 'english', '']) {
      expect((await fresh(memoryStorage({ [KEY]: stored }), 'en-US')).getLang(), stored).toBe('en');
      expect((await fresh(memoryStorage({ [KEY]: stored }), 'ko-KR')).getLang(), stored).toBe('ko');
    }
  });

  it('저장소가 없거나 읽기가 던져도 뜬다: 브라우저 언어를 따른다', async () => {
    expect((await fresh(undefined, 'ko-KR')).getLang()).toBe('ko');
    expect((await fresh({ getItem: deny, setItem: deny }, 'ko-KR')).getLang()).toBe('ko');
    expect((await fresh({ getItem: deny, setItem: deny }, 'en-US')).getLang()).toBe('en');
  });
});

describe('언어 저장소: 바꾸기', () => {
  it('바꾸면 저장하고, 다음 실행이 그 선택으로 시작한다', async () => {
    const storage = memoryStorage();
    const first = await fresh(storage, 'en-US');
    first.setLang('ko');
    expect(storage.getItem(KEY)).toBe('ko');
    expect((await fresh(storage, 'en-US')).getLang()).toBe('ko');
  });

  it('저장하지 못해도(쓰기가 던져도) 이번 실행에는 적용된다', async () => {
    const { setLang, getLang, t } = await fresh({ getItem: () => null, setItem: deny }, 'en-US');
    expect(() => setLang('ko')).not.toThrow();
    expect(getLang()).toBe('ko');
    expect(t('newNote.cancel')).toBe('취소');
  });

  it('t 는 지금 언어의 목록을 쓴다', async () => {
    const { setLang, t } = await fresh(memoryStorage(), 'en-US');
    expect(t('vault.open', 'lab')).toBe('Vault: lab');
    setLang('ko');
    expect(t('vault.open', 'lab')).toBe('보관함: lab');
    expect(t('no.such.key')).toBe('no.such.key');
    expect(t('constructor')).toBe('constructor'); // 목록 객체의 상속 속성은 번역이 아니다
  });

  it('구독자는 바뀔 때만 알림을 받고, 구독을 풀면 더 받지 않는다', async () => {
    const { setLang, subscribeLang } = await fresh(memoryStorage(), 'en-US');
    const heard = vi.fn();
    const off = subscribeLang(heard);
    setLang('ko');
    setLang('ko'); // 같은 값: 다시 그릴 이유가 없다
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    setLang('en');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('알 수 없는 값은 받지 않는다', async () => {
    const storage = memoryStorage();
    const { setLang, getLang } = await fresh(storage, 'en-US');
    setLang('fr' as never);
    expect(getLang()).toBe('en');
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('useLang 은 바꾸는 즉시 새 언어로 다시 그린다', async () => {
    const { setLang, useLang } = await fresh(memoryStorage(), 'en-US');
    const { result } = renderHook(() => useLang());
    expect(result.current).toBe('en');
    act(() => setLang('ko'));
    expect(result.current).toBe('ko');
  });

  it('html lang 을 고른 언어로 건다', async () => {
    const { applyHtmlLang } = await fresh(memoryStorage(), 'en-US');
    applyHtmlLang('en');
    expect(document.documentElement.lang).toBe('en');
    applyHtmlLang('ko');
    expect(document.documentElement.lang).toBe('ko');
  });
});
