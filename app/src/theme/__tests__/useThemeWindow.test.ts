// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';

/**
 * App 은 useTheme() 을 인자 없이 부른다: 실제로 배포되는 길은 기본 이음새 getCurrentWindow() 다.
 * 주입 테스트(useTheme.test.ts)는 그 길을 지나지 않으므로, 여기서 Tauri 창 모듈을 바꿔 끼워 그 길을 그대로 탄다.
 */
const tauriWindow = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setTheme: async (theme: unknown) => {
      tauriWindow.calls.push(theme);
    },
  }),
}));

import { useTheme } from '../useTheme';

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

beforeEach(() => {
  tauriWindow.calls.length = 0;
  vi.stubGlobal('localStorage', memoryStorage());
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => vi.unstubAllGlobals());

describe('useTheme: 배포되는 기본 창 이음새', () => {
  it('인자 없이 부르면 Tauri 현재 창의 setTheme 을 쓴다: 시작할 때 null, 다크를 고르면 dark', async () => {
    const { result } = renderHook(() => useTheme());
    await waitFor(() => expect(tauriWindow.calls).toEqual([null]));
    act(() => result.current.setTheme('dark'));
    await waitFor(() => expect(tauriWindow.calls).toEqual([null, 'dark']));
  });
});
