// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { setLang } from '../../i18n/lang';
import { coreT } from '../../labnote/i18n';
import { currentDialog } from '../../labnote/host/dialogStore';
import { clearToasts, currentToasts } from '../../labnote/host/toastStore';
import { cleanupDialogs, openIn, renderLayer, settled, styleAttributes } from '../../labnote/host/__tests__/harness';
import { aiAnswerDialog } from '../../labnote/port/aiAnswerDialog';

const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

beforeEach(() => {
  setLang('en');
  clearToasts();
});
afterEach(() => {
  cleanupDialogs();
  clearToasts();
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

/** 대화상자 아래 단추 줄(머리의 닫기 X 단추는 빼고). */
function actions() {
  return within(document.querySelector('.dialog-actions') as HTMLElement);
}

/** 버튼을 누르고 그 뒤의 비동기 처리(onInsert, 클립보드)가 끝날 때까지 기다린다. */
async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(actions().getByRole('button', { name }));
    await Promise.resolve();
  });
}

describe('AI answer dialog', () => {
  it('renders model output as text, never HTML', () => {
    renderLayer();
    const content = '<img src=x onerror=alert(1)>\n\n  indented line';
    void openIn(() => aiAnswerDialog({ content, sourcePath: 'a.labnote.md' }));
    const dialog = screen.getByRole('dialog', { name: coreT('AI answer') });
    expect(dialog.querySelector('img')).toBeNull();
    const pre = dialog.querySelector('pre.ai-answer');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe(content);
    expect(pre!.children.length).toBe(0);
    expect(styleAttributes()).toEqual([]);
  });

  it('Insert closes only when onInsert resolves true', async () => {
    renderLayer();
    const answers = [false, true];
    const onInsert = vi.fn(async () => answers.shift()!);
    const closed = settled(openIn(() => aiAnswerDialog({ content: 'answer', onInsert })));

    await press(coreT('Insert into note'));
    expect(onInsert).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(closed.done).toBe(false);

    await press(coreT('Insert into note'));
    expect(onInsert).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(currentDialog()).toBeNull();
    await act(async () => {});
    expect(closed.done).toBe(true);
  });

  it('a rejected onInsert keeps the dialog open', async () => {
    renderLayer();
    void openIn(() => aiAnswerDialog({ content: 'answer', onInsert: () => Promise.reject(new Error('busy')) }));
    await press(coreT('Insert into note'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Copy writes the clipboard and notifies', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    stubClipboard(writeText);
    renderLayer();
    void openIn(() => aiAnswerDialog({ content: 'the answer' }));
    await press(coreT('Copy'));
    expect(writeText).toHaveBeenCalledWith('the answer');
    expect(currentToasts().map((x) => x.message)).toEqual([coreT('Copied to clipboard.')]);
    expect(screen.getByRole('dialog')).toBeTruthy();

    clearToasts();
    stubClipboard(() => Promise.reject(new Error('denied')));
    await press(coreT('Copy'));
    expect(currentToasts().map((x) => x.message)).toEqual([coreT('Could not copy: {0}', 'denied')]);
  });

  it('Korean labels come from the plugin strings', () => {
    setLang('ko');
    renderLayer();
    void openIn(() => aiAnswerDialog({ content: 'x', onInsert: async () => true }));
    expect(screen.getByRole('dialog', { name: 'AI 답변' })).toBeTruthy();
    expect(actions().getAllByRole('button').map((b) => b.textContent)).toEqual(['노트에 넣기', '복사', '닫기']);
  });

  it('without onInsert there is no Insert button', async () => {
    renderLayer();
    const closed = settled(openIn(() => aiAnswerDialog({ content: 'answer' })));
    expect(actions().getAllByRole('button').map((b) => b.textContent)).toEqual([coreT('Copy'), coreT('Close')]);
    await press(coreT('Close'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await act(async () => {});
    expect(closed.done).toBe(true);
  });
});
