// @vitest-environment jsdom
/** 설정 → 어시스턴트의 대화 기록 줄(plan Task 10): 기록이 있는 실험 수와 "모든 기록 지우기"(확인 후). */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../i18n/lang';
import { HistoryRow, WebSearchRow, type WebSearchRowDeps } from '../settings/AssistantPage';

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

describe('Assistant pane: web search address row (plan Task 12)', () => {
  async function setupSearch(opts: { stored?: string; probe?: () => Promise<unknown>; save?: (url: string) => Promise<unknown> } = {}) {
    const deps = {
      read: vi.fn(async () => (opts.stored ? { searxngUrl: opts.stored } : {})),
      save: vi.fn(opts.save ?? (async (url: string) => (url ? { searxngUrl: url.replace(/\/$/, '') } : {}))),
      probe: vi.fn(opts.probe ?? (async () => ({ hits: [{ title: 'a', url: 'https://a.example/', snippet: '', engine: 'e' }], enginesDown: false }))),
    };
    render(<WebSearchRow {...(deps as unknown as WebSearchRowDeps)} />);
    await settle();
    return { deps };
  }

  it('shows the stored address and says it stays on this PC', async () => {
    await setupSearch({ stored: 'https://search.example' });
    const row = screen.getByRole('group', { name: '웹 검색 주소' });
    expect(row.textContent).toContain('이 PC에만 저장해요');
    expect((screen.getByRole('textbox', { name: '웹 검색 주소' }) as HTMLInputElement).value).toBe('https://search.example');
  });

  it('Enter saves the trimmed address; the stored form comes back', async () => {
    const { deps } = await setupSearch();
    const box = screen.getByRole('textbox', { name: '웹 검색 주소' });
    await userEvent.type(box, '  https://s.example/  {Enter}');
    await settle();
    expect(deps.save).toHaveBeenCalledWith('https://s.example/');
    expect((box as HTMLInputElement).value).toBe('https://s.example');
    expect(screen.getByRole('status').textContent).toBe('저장했어요.');
  });

  it('a refused address shows the plain hint and keeps the typed text', async () => {
    const { AssistantHistoryError } = await import('../../assistant/history');
    const { deps } = await setupSearch({
      save: async () => {
        throw new AssistantHistoryError('badUrl', 'the web search address is not valid');
      },
    });
    const box = screen.getByRole('textbox', { name: '웹 검색 주소' });
    await userEvent.type(box, 'http://search.lab{Enter}');
    await settle();
    expect(deps.save).toHaveBeenCalledTimes(1);
    expect((box as HTMLInputElement).value).toBe('http://search.lab');
    expect(screen.getByRole('status').textContent).toContain('주소가 올바르지 않아요');
  });

  it('Check probes the typed (unsaved) address and shows how many results came back', async () => {
    const { deps } = await setupSearch();
    const check = screen.getByRole('button', { name: '확인' }) as HTMLButtonElement;
    expect(check.disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: '웹 검색 주소' }), 'https://s.example');
    await userEvent.click(check);
    await settle();
    expect(deps.probe).toHaveBeenCalledWith('https://s.example');
    expect(screen.getByRole('status').textContent).toBe('연결됐어요. 결과 1개');
  });

  it('a 403 from the server (JSON turned off) shows the plain settings.yml hint', async () => {
    const { NetError } = await import('../../integrations/netIpc');
    await setupSearch({
      stored: 'http://127.0.0.1:8888',
      probe: async () => {
        throw new NetError('jsonDisabled', 'this SearXNG instance does not allow JSON results');
      },
    });
    await userEvent.click(screen.getByRole('button', { name: '확인' }));
    await settle();
    expect(screen.getByRole('status').textContent).toBe(
      '이 검색 주소는 JSON 결과를 막아 두었어요. SearXNG settings.yml의 search.formats에 json을 추가하세요.'
    );
  });

  it('follows the language', async () => {
    setLang('en');
    await setupSearch();
    expect(screen.getByRole('group', { name: 'Web search address' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy();
  });
});
