// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { setLang } from '../../../i18n/lang';
import { Toaster } from '../Toaster';
import { MAX_TOASTS, clearToasts, currentToasts, notify, notifyStatus } from '../toastStore';
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

  it('an action toast runs its action and closes', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    const run = vi.fn();
    act(() => notify('info', '스캔: 1쪽', { ms: 15000, action: { label: '자세히', run } }));
    // 알림은 초점을 가져가지 않는다
    expect(document.activeElement).toBe(editor);
    const toast = screen.getByRole('status');
    const button = within(toast).getByRole('button', { name: '자세히' });
    expect(button.classList.contains('toast-action')).toBe(true);
    expect(button.getAttribute('type')).toBe('button');
    // ms 가 기본 6 초를 바꾼다
    act(() => vi.advanceTimersByTime(14999));
    expect(screen.queryByRole('status')).toBeTruthy();
    fireEvent.click(button);
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
    expect(currentToasts()).toEqual([]);
    editor.remove();
  });

  it('a toast with an empty message shows only its action', () => {
    render(<Toaster />);
    act(() => notify('info', '', { action: { label: '결과 다시 보기', run: () => {} } }));
    const toast = screen.getByRole('status');
    expect(toast.querySelector('.toast-message')).toBeNull();
    expect(within(toast).getByRole('button', { name: '결과 다시 보기' })).toBeTruthy();
  });

  it('a status toast stays until closed and updates its text', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    const editor = document.createElement('textarea');
    document.body.append(editor);
    editor.focus();
    let status!: ReturnType<typeof notifyStatus>;
    act(() => {
      status = notifyStatus('스캔을 처리하는 중…');
    });
    expect(document.activeElement).toBe(editor);
    expect(screen.getByRole('status').textContent).toContain('스캔을 처리하는 중…');
    expect(currentToasts()[0].sticky).toBe(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole('status')).toBeTruthy();
    act(() => status.update('스캔을 처리하는 중… 1쪽 완료 (a.jpg)'));
    expect(screen.getByRole('status').textContent).toContain('1쪽 완료 (a.jpg)');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    act(() => status.close());
    expect(screen.queryByRole('status')).toBeNull();
    // 닫은 뒤의 update 와 close 는 아무것도 하지 않는다
    act(() => {
      status.update('늦은 글');
      status.close();
    });
    expect(currentToasts()).toEqual([]);
    editor.remove();
  });

  it('no element has a style attribute', () => {
    render(<Toaster />);
    act(() => {
      notify('info', 'a');
      notify('warn', 'b');
      notify('error', 'c');
      notify('info', 'd', { action: { label: 'e', run: () => {} } });
      notifyStatus('f');
    });
    expect(styleAttributes()).toEqual([]);
  });
});
