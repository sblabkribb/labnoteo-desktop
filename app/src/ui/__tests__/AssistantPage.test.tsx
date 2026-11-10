// @vitest-environment jsdom
/** 설정 → 어시스턴트의 대화 기록 줄(plan Task 10): 기록이 있는 실험 수와 "모든 기록 지우기"(확인 후). */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { HistoryRow } from '../settings/AssistantPage';

afterEach(() => {
  cleanup();
  setLang('ko');
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function setup(opts: { confirm?: boolean; folders?: number } = {}) {
  let folders = opts.folders ?? 3;
  const deps = {
    stats: vi.fn(async () => ({ folders, bytes: 10 })),
    clearAll: vi.fn(async () => {
      const n = folders;
      folders = 0;
      return n;
    }),
    confirm: vi.fn(async () => opts.confirm ?? true),
    onCleared: vi.fn(),
    notify: vi.fn(),
  };
  render(<HistoryRow {...deps} />);
  return deps;
}

describe('Assistant pane: chat history row', () => {
  it('shows how many experiments have chat and that it stays out of the vault', async () => {
    setup();
    await settle();
    const row = screen.getByRole('group', { name: '대화 기록' });
    expect(row.textContent).toContain('기록이 있는 실험: 3개');
    expect(row.textContent).toContain('보관함에는 저장하지 않아요');
  });

  it('delete all asks first; refused leaves everything', async () => {
    const deps = setup({ confirm: false });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '모든 기록 지우기' }));
    expect(deps.confirm).toHaveBeenCalledWith('모든 실험의 대화 기록을 지울까요? 되돌릴 수 없어요.');
    expect(deps.clearAll).not.toHaveBeenCalled();
  });

  it('confirmed: clears all, resets the open chat and refreshes the count', async () => {
    const deps = setup();
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '모든 기록 지우기' }));
    await settle();
    expect(deps.clearAll).toHaveBeenCalledTimes(1);
    expect(deps.onCleared).toHaveBeenCalledTimes(1);
    expect(deps.notify).toHaveBeenCalledWith('info', '대화 기록을 모두 지웠어요.');
    expect(screen.getByRole('group', { name: '대화 기록' }).textContent).toContain('기록이 있는 실험: 0개');
    expect((screen.getByRole('button', { name: '모든 기록 지우기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('follows the language', async () => {
    setLang('en');
    setup();
    await settle();
    expect(screen.getByRole('group', { name: 'Chat history' }).textContent).toContain('Experiments with chat: 3');
  });
});
