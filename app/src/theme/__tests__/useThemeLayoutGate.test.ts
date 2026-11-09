// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { useTheme } from '../useTheme';
import { DEFAULT_PREFS, layoutStore } from '../../ui/layoutStore';

/**
 * 창은 숨긴 채 뜬다. 보이기 전에 Rust ui.json 의 배치(사이드바 너비, 숨김)가 걸려야
 * 첫 프레임에 너비가 튀거나 숨긴 사이드바가 비치지 않는다.
 */
describe('useTheme waits for the layout before showing the window', () => {
  it('show() is called only after layoutStore.load() has settled', async () => {
    let resolve!: (v: unknown) => void;
    const invoke = vi.fn(() => new Promise((r) => (resolve = r)));
    void layoutStore.load(invoke as never);
    const show = vi.fn(async () => {});
    renderHook(() => useTheme({ setTheme: async () => {}, show }));
    await new Promise((r) => setTimeout(r, 20));
    expect(show).not.toHaveBeenCalled();
    resolve({ ...DEFAULT_PREFS, leftHidden: true });
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(document.documentElement.getAttribute('data-left-hidden')).toBe('true');
  });
});
