// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { useTheme, THEME_KEY } from '../useTheme';

const html = document.documentElement;

// Node 의 자체 localStorage 가 jsdom 의 것을 가려 환경마다 다르므로, 같은 동작의 가짜 저장소를 직접 꽂는다.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
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

let storage: Storage;
beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal('localStorage', storage);
  html.removeAttribute('data-theme');
});
afterEach(() => vi.unstubAllGlobals());

describe('useTheme', () => {
  it('저장 키는 바뀌지 않는다: 바꾸면 모든 사용자의 저장된 선택이 버려진다', () => {
    expect(THEME_KEY).toBe('labnoteo.theme');
  });

  it('선택한 테마를 html data-theme 에 반영한다', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(html.getAttribute('data-theme')).toBe('dark');
    act(() => result.current.setTheme('light'));
    expect(html.getAttribute('data-theme')).toBe('light');
    expect(result.current.theme).toBe('light');
  });

  it('system 을 고르면 data-theme 속성을 지운다', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(html.hasAttribute('data-theme')).toBe(true);
    act(() => result.current.setTheme('system'));
    expect(html.hasAttribute('data-theme')).toBe(false);
    expect(storage.getItem(THEME_KEY)).toBe('system');
  });

  it('저장된 선택을 다음 실행에서 복원한다', () => {
    const first = renderHook(() => useTheme());
    act(() => first.result.current.setTheme('dark'));
    first.unmount();
    html.removeAttribute('data-theme'); // 새 실행: 문서는 깨끗하고 저장소만 남는다
    const second = renderHook(() => useTheme());
    expect(second.result.current.theme).toBe('dark');
    expect(html.getAttribute('data-theme')).toBe('dark');
  });

  it('저장된 값이 알 수 없는 문자열이면 system 으로 시작한다', () => {
    storage.setItem(THEME_KEY, 'sepia');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
    expect(html.hasAttribute('data-theme')).toBe(false);
  });

  it('localStorage 를 쓸 수 없어도 앱이 뜬다: 읽기와 쓰기가 던져도 기본값으로 동작한다', () => {
    const deny = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: deny, setItem: deny });
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('system');
    act(() => result.current.setTheme('dark'));
    expect(result.current.theme).toBe('dark'); // 저장은 못 해도 이번 실행에는 적용된다
    expect(html.getAttribute('data-theme')).toBe('dark');
  });
});
