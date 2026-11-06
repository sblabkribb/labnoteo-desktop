// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
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

describe('useTheme: 창 제목 표시줄', () => {
  // 부른 값은 calls 로 센다. setTheme 자체를 vi.fn 으로 감싸지 않는다: vi.fn 은 돌려준 약속에 처리기를 달아(settledResults)
  // 훅이 거부를 받아 주지 않아도 처리된 것처럼 보이게 한다.
  const fakeWindow = (impl: (t: 'light' | 'dark' | null) => Promise<void> = async () => {}) => {
    const calls = vi.fn();
    return { calls, setTheme: (t: 'light' | 'dark' | null) => (calls(t), impl(t)), show: async () => {} };
  };

  it('시작할 때 저장된 선택을 창에도 건다 (다크를 고른 사람의 제목 표시줄도 다크로 뜬다)', async () => {
    storage.setItem(THEME_KEY, 'dark');
    const win = fakeWindow();
    renderHook(() => useTheme(win));
    await waitFor(() => expect(win.calls).toHaveBeenCalledWith('dark'));
    expect(win.calls).toHaveBeenCalledTimes(1);
  });

  it('고를 때마다 창에 같은 값을 건다: system 은 null(다시 OS 를 따른다)', async () => {
    const win = fakeWindow();
    const { result } = renderHook(() => useTheme(win));
    await waitFor(() => expect(win.calls).toHaveBeenLastCalledWith(null)); // 저장값 없음 = system
    for (const [choice, sent] of [['dark', 'dark'], ['light', 'light'], ['system', null]] as const) {
      act(() => result.current.setTheme(choice));
      await waitFor(() => expect(win.calls).toHaveBeenLastCalledWith(sent));
    }
    expect(win.calls.mock.calls.map((c) => c[0])).toEqual([null, 'dark', 'light', null]);
  });

  it('창 API 가 거부하거나 던져도 토글은 그대로 동작한다 (제목 표시줄만 못 바뀐다)', async () => {
    // 거부를 받아 주지 않으면 처리되지 않은 거부가 된다. 이 환경의 vitest 는 그것을 실패로 치지 않으므로 직접 센다.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await toggleSurvives();
      await new Promise((r) => setTimeout(r, 20)); // 거부 추적은 마이크로태스크가 다 돈 뒤에 알린다
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  async function toggleSurvives() {
    for (const win of [
      fakeWindow(async () => Promise.reject(new Error('not allowed: set_theme'))),
      fakeWindow(() => {
        throw new Error('no window');
      }),
    ]) {
      html.removeAttribute('data-theme');
      const { result, unmount } = renderHook(() => useTheme(win));
      act(() => result.current.setTheme('dark'));
      await waitFor(() => expect(win.calls).toHaveBeenLastCalledWith('dark'));
      expect(result.current.theme).toBe('dark');
      expect(html.getAttribute('data-theme')).toBe('dark');
      expect(storage.getItem(THEME_KEY)).toBe('dark');
      act(() => result.current.setTheme('system'));
      expect(html.hasAttribute('data-theme')).toBe(false);
      unmount();
    }
  }

  it('Tauri 창이 없는 환경(주입 없음)에서도 훅이 뜬다', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('dark'));
    expect(html.getAttribute('data-theme')).toBe('dark');
  });
});

// 창은 숨긴 채 뜬다(tauri.conf.json visible:false): 첫 테마가 걸린 뒤에 보여야 제목 표시줄이 OS 테마로 한 번 비치지 않는다.
describe('useTheme: 차가운 시작의 창 보이기', () => {
  const win = (setTheme: (t: 'light' | 'dark' | null) => Promise<void>) => {
    const show = vi.fn(async () => {});
    return { show, api: { setTheme, show } };
  };

  afterEach(() => vi.useRealTimers());

  it('shows the window once after the first setTheme resolves', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((r) => (resolve = r));
    const { show, api } = win(() => pending);
    const { result } = renderHook(() => useTheme(api));
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled(); // 테마가 걸리기 전에는 숨긴 채다
    resolve();
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    api.setTheme = async () => {};
    act(() => result.current.setTheme('dark'));
    act(() => result.current.setTheme('light'));
    await new Promise((r) => setTimeout(r, 20));
    expect(show).toHaveBeenCalledTimes(1); // 다음 선택에서는 다시 부르지 않는다
  });

  it('shows the window even when setTheme rejects', async () => {
    const { show, api } = win(async () => Promise.reject(new Error('not allowed: set_theme')));
    renderHook(() => useTheme(api));
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  });

  it('shows the window even when setTheme throws synchronously', async () => {
    const { show, api } = win(() => {
      throw new Error('no window');
    });
    renderHook(() => useTheme(api));
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
  });

  it('shows the window after 1500 ms if setTheme hangs', () => {
    vi.useFakeTimers();
    const { show, api } = win(() => new Promise<void>(() => {}));
    renderHook(() => useTheme(api));
    vi.advanceTimersByTime(1499);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('a rejecting show() is swallowed (no unhandled rejection)', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const show = vi.fn(() => Promise.reject(new Error('not allowed: show')));
      renderHook(() => useTheme({ setTheme: async () => {}, show }));
      await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
