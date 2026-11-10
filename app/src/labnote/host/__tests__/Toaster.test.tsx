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
  it('notify info renders role=status and disappears after 4 s', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => notify('info', '실험을 만들었습니다.'));
    const toast = screen.getByRole('status');
    expect(toast.textContent).toContain('실험을 만들었습니다.');
    expect(within(toast).queryByRole('button')).toBeNull();
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.queryByRole('status')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('success is a status toast with its own stripe and the same 4 s timer', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => notify('success', '저장했습니다.'));
    const toast = screen.getByRole('status');
    expect(toast.classList.contains('toast')).toBe(true);
    expect(toast.classList.contains('toast-success')).toBe(true);
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('hovering pauses the timer and leaving resumes it with the time that was left', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => notify('info', '잠깐'));
    act(() => vi.advanceTimersByTime(3000));
    const toast = screen.getByRole('status');
    fireEvent.mouseEnter(toast);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByRole('status')).toBeTruthy();
    fireEvent.mouseLeave(toast);
    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByRole('status')).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('the stripe class follows the kind', () => {
    render(<Toaster />);
    act(() => {
      notify('info', 'i');
      notify('warn', 'w');
      notify('error', 'e');
    });
    const kinds = [...document.querySelectorAll('.toast')].map((el) =>
      ['toast-info', 'toast-success', 'toast-warn', 'toast-error'].filter((c) => el.classList.contains(c)),
    );
    expect(kinds).toEqual([['toast-info'], ['toast-warn'], ['toast-error']]);
  });

  it('notify error renders role=alert with a close button', () => {
    render(<Toaster />);
    act(() => notify('error', '저장하지 못했습니다.'));
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('저장하지 못했습니다.');
    expect(toast.classList.contains('toast-error')).toBe(true);
    fireEvent.click(within(toast).getByRole('button', { name: '알림 닫기' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('warn and error stay until closed, even with an old ms option', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => {
      notify('warn', '경고', { ms: 15000 });
      notify('error', '오류');
    });
    expect(screen.getAllByRole('alert')[0].classList.contains('toast-warn')).toBe(true);
    act(() => vi.advanceTimersByTime(10 * 60_000));
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('shows at most 3; a 4th toast drops the oldest info toast, not a warning', () => {
    render(<Toaster />);
    expect(MAX_TOASTS).toBe(3);
    act(() => {
      notify('error', '오류 1');
      notify('info', '알림 1');
      notify('info', '알림 2');
      notify('warn', '경고 1');
    });
    expect(currentToasts().map((x) => x.message)).toEqual(['오류 1', '알림 2', '경고 1']);
    expect(document.querySelectorAll('.toast')).toHaveLength(3);
  });

  it('with only warnings and errors a 4th toast drops the oldest one', () => {
    render(<Toaster />);
    act(() => {
      for (let i = 1; i <= 4; i++) notify('error', `오류 ${i}`);
    });
    expect(currentToasts().map((x) => x.message)).toEqual(['오류 2', '오류 3', '오류 4']);
  });

  it('a title is shown above the detail; without a detail the message is the detail', () => {
    render(<Toaster />);
    act(() => {
      notify('success', '쓰지 않는 글', { title: '첨부했습니다', detail: 'resources/plot.csv' });
      notify('info', '대신 보이는 글', { title: '제목만' });
    });
    const [first, second] = screen.getAllByRole('status');
    expect(first.querySelector('.toast-title')?.textContent).toBe('첨부했습니다');
    expect(first.querySelector('.toast-detail')?.textContent).toBe('resources/plot.csv');
    expect(first.textContent).not.toContain('쓰지 않는 글');
    expect(second.querySelector('.toast-title')?.textContent).toBe('제목만');
    expect(second.querySelector('.toast-detail')?.textContent).toBe('대신 보이는 글');
  });

  it('the container sits bottom-left', () => {
    render(<Toaster />);
    expect(screen.getByRole('region', { name: '알림' }).classList.contains('toaster-bottom-left')).toBe(true);
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
    // 예전 (kind, msg, { ms, action }) 부름이 그대로 된다
    // 알림은 초점을 가져가지 않는다
    expect(document.activeElement).toBe(editor);
    const toast = screen.getByRole('status');
    const button = within(toast).getByRole('button', { name: '자세히' });
    expect(button.classList.contains('toast-action')).toBe(true);
    expect(button.getAttribute('type')).toBe('button');
    // ms 가 기본 4 초를 바꾼다
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
      notify('error', 'c', { title: 't', detail: 'd' });
      notify('success', 'd', { action: { label: 'e', run: () => {} } });
      notifyStatus('f');
    });
    expect(styleAttributes()).toEqual([]);
  });
});
