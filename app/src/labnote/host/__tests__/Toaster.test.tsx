// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { Toaster } from '../Toaster';
import { MAX_TOASTS, clearToasts, currentToasts, notify } from '../toastStore';
import { styleAttributes } from './harness';

afterEach(() => {
  act(() => clearToasts());
  vi.useRealTimers();
  setLang('ko');
});

describe('알림(토스트)', () => {
  it('notify info renders role=status and disappears after 6 s', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => notify('info', '실험을 만들었습니다.'));
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('실험을 만들었습니다.');
    expect(within(toast).queryByRole('button')).toBeNull();
    act(() => vi.advanceTimersByTime(5999));
    expect(screen.queryByRole('status')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('notify error renders role=alert with a close button', () => {
    render(<Toaster />);
    act(() => notify('error', '저장하지 못했습니다.'));
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('저장하지 못했습니다.');
    expect(toast.classList.contains('error')).toBe(true);
    fireEvent.click(within(toast).getByRole('button', { name: '알림 닫기' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warn and error stay 15 s', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => notify('warn', '경고'));
    expect(screen.getByRole('alert').classList.contains('warn')).toBe(true);
    act(() => vi.advanceTimersByTime(14999));
    expect(screen.queryByRole('alert')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a sixth toast drops the oldest', () => {
    render(<Toaster />);
    expect(MAX_TOASTS).toBe(5);
    act(() => {
      for (let i = 1; i <= 6; i++) notify('info', `알림 ${i}`);
    });
    const texts = screen.getAllByRole('status').map((el) => el.textContent ?? '');
    expect(texts).toHaveLength(5);
    expect(texts.join('|')).not.toContain('알림 1');
    expect(texts[4]).toContain('알림 6');
    expect(currentToasts().map((x) => x.message)).toEqual(['알림 2', '알림 3', '알림 4', '알림 5', '알림 6']);
  });

  it('the region and close button follow setLang', () => {
    render(<Toaster />);
    act(() => notify('error', 'x'));
    expect(screen.getByRole('region', { name: '알림' })).toBeTruthy();
    act(() => setLang('en'));
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toBeTruthy();
  });

  it('no element has a style attribute', () => {
    render(<Toaster />);
    act(() => {
      notify('info', 'a');
      notify('warn', 'b');
      notify('error', 'c');
    });
    expect(styleAttributes()).toEqual([]);
  });
});
