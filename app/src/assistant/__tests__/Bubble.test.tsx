// @vitest-environment jsdom
/**
 * 말풍선 대화(plan Task 10): 흘러 들어오는 답, 글 그대로 그리기, 보내기 키, 멈추기, 출처, 폴더 바꾸기, 저장되지 않는 대화,
 * 보관함 바뀜, Esc, 지우기 확인, 실행 중의 승인 대화상자.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { DialogLayer } from '../../labnote/host/DialogLayer';
import { confirmDialog } from '../../labnote/host/dialogStore';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createLayoutStore, type UiPrefs } from '../../ui/layoutStore';
import { AssistantHistoryError, emptyHistory, type HistoryDoc } from '../history';
import { resetWebHint } from '../Bubble';
import { PetLayer, type BubbleActions } from '../PetLayer';
import { createPetStore, type PetStore } from '../petStore';
import type { AssistantResult, AssistantRuntime, AssistantSink, AssistantTurn } from '../runtime';
import { createAssistantSession, type AssistantSession, type HistoryIo } from '../useAssistantSession';

const A = 'labnote/001_A';
const B = 'labnote/002_B';
const NOTE_A = `${A}/README.labnote.md`;
const NOTE_B = `${B}/README.labnote.md`;
const URL_SRC = { kind: 'web' as const, label: 'Example page', target: 'https://example.test/a?q=1#x' };
const NOTE_SRC = { kind: 'note' as const, label: 'README.labnote.md', target: NOTE_A };

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

type Plan = (turn: AssistantTurn, sink: AssistantSink, signal: AbortSignal) => Promise<Partial<AssistantResult>>;

function fakeRt(plan: Plan) {
  const turns: AssistantTurn[] = [];
  const rt: AssistantRuntime = {
    id: 'fake',
    label: () => 'Fake',
    available: async () => ({ ok: true }),
    async run(turn, sink, signal) {
      turns.push(structuredClone(turn));
      const r = await plan(turn, sink, signal);
      return { content: '', sources: [], executed: [], tainted: false, ...r };
    },
  };
  return { rt, turns };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const stored = (folder: string, texts: string[]): HistoryDoc => ({
  version: 1,
  folder,
  updated: 1,
  messages: texts.map((text, i) => ({ id: `${folder}-${i}`, role: i % 2 ? 'assistant' : 'user', text, ts: i })),
});

function Harness(props: { store: PetStore; session: AssistantSession; activePath?: string; actions?: BubbleActions }) {
  const shell = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="shell" ref={shell}>
        <button type="button">editor</button>
      </div>
      <DialogLayer blockRef={shell} />
      <div id="pet-layer">
        <PetLayer store={props.store} session={props.session} activePath={props.activePath} actions={props.actions} />
      </div>
    </>
  );
}

let vault = 'v1';
function setup(
  opts: {
    plan?: Plan;
    seed?: Record<string, HistoryDoc>;
    activePath?: string;
    confirm?: () => Promise<boolean>;
    actions?: Partial<BubbleActions>;
  } = {}
) {
  vault = 'v1';
  const docs = new Map(Object.entries(opts.seed ?? {}));
  const writes: HistoryDoc[] = [];
  const io: HistoryIo = {
    read: async (folder) => ({ doc: docs.get(folder) ?? emptyHistory(folder), token: `${vault}:${folder}` }),
    write: async (folder, token, doc) => {
      if (token !== `${vault}:${folder}`) throw new AssistantHistoryError('vaultChanged', 'changed');
      writes.push(doc);
      docs.set(folder, doc);
    },
    clear: async (folder) => void docs.delete(folder),
  };
  const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
  const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
  const store = createPetStore({ layout });
  const { rt, turns } = fakeRt(opts.plan ?? (async () => ({ content: '답' })));
  const confirm = vi.fn(opts.confirm ?? (async () => true));
  const session = createAssistantSession({
    history: io,
    runtime: () => rt,
    setPetState: (s) => store.setState(s),
    confirm,
  });
  const actions = { ...opts.actions, openSource: vi.fn(), insert: vi.fn() };
  const view = render(<Harness store={store} session={session} activePath={opts.activePath ?? NOTE_A} actions={actions} />);
  const rerender = (activePath: string | undefined) =>
    view.rerender(<Harness store={store} session={session} activePath={activePath} actions={actions} />);
  return { store, session, turns, writes, actions, confirm, rerender };
}

async function open(store: PetStore) {
  await act(async () => {
    store.setOpen(true);
  });
}

const composer = () => screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' }) as HTMLTextAreaElement;
const log = () => screen.getByRole('log');
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function type(text: string) {
  fireEvent.change(composer(), { target: { value: text } });
}

afterEach(() => {
  resetWebHint();
  cleanupDialogs();
  cleanup();
  setLang('ko');
});

describe('assistant bubble chat', () => {
  it('focuses the composer on open; the log is a polite live region that receives the streamed text', async () => {
    const gate = deferred();
    const { store } = setup({
      plan: async (_t, sink) => {
        sink.state('think');
        sink.delta('첫 조각 ');
        await gate.promise;
        sink.delta('끝');
        return { content: '첫 조각 끝' };
      },
    });
    await open(store);
    await settle();
    expect(document.activeElement).toBe(composer());
    expect(log().getAttribute('aria-live')).toBe('polite');
    expect(log().getAttribute('aria-relevant')).toBe('additions');
    await type('질문');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(log().textContent).toContain('질문');
    expect(log().textContent).toContain('첫 조각');
    expect(store.get().state).toBe('think');
    gate.resolve();
    await settle();
    expect(log().textContent).toContain('첫 조각 끝');
  });

  it('scrolls to the real end when a web answer finishes: the sources and Insert come after the last text (Visual QA)', async () => {
    const gate = deferred();
    const { store } = setup({
      plan: async (_t, sink) => {
        sink.delta('웹 답 [1]');
        await gate.promise;
        return { content: '웹 답 [1]', sources: [URL_SRC] };
      },
    });
    const scrolled: Element[] = [];
    const proto = Element.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      await open(store);
      await type('q');
      fireEvent.keyDown(composer(), { key: 'Enter' });
      await settle();
      const before = scrolled.length;
      gate.resolve();
      await settle();
      expect(screen.getByRole('list', { name: '출처' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '노트에 넣기' })).toBeTruthy();
      expect(scrolled.length).toBeGreaterThan(before);
    } finally {
      proto.scrollIntoView = had;
    }
  });

  it('shows markup in replies as literal text (no HTML, no Markdown)', async () => {
    const evil = '<img src=x onerror=alert(1)> and **bold**';
    const { store } = setup({ plan: async () => ({ content: evil }) });
    await open(store);
    await type('q');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(log().textContent).toContain(evil);
    expect(log().querySelector('img')).toBeNull();
    expect(log().querySelector('strong, b')).toBeNull();
  });

  it('Enter sends, but not while composing (IME); Shift+Enter does not send', async () => {
    const { store, turns } = setup();
    await open(store);
    await type('한글');
    fireEvent.keyDown(composer(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(composer(), { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(composer(), { key: 'Enter', shiftKey: true });
    await settle();
    expect(turns).toHaveLength(0);
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.userText).toBe('한글');
    expect(composer().value).toBe('');
  });

  it('Stop aborts the run and the pet goes idle', async () => {
    const { store, writes } = setup({
      plan: (_t, sink, signal) =>
        new Promise((resolve) => {
          sink.state('think');
          signal.addEventListener('abort', () => resolve({ cancelled: true }));
        }),
    });
    await open(store);
    await type('q');
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await settle();
    expect(store.get().state).toBe('think');
    await userEvent.click(screen.getByRole('button', { name: '멈추기' }));
    await settle();
    expect(store.get().state).toBe('idle');
    expect(log().textContent).toContain('멈췄어요.');
    expect(screen.queryByRole('button', { name: '멈추기' })).toBeNull();
    expect(writes).toHaveLength(0);
  });

  it('lists sources; a note source and a citation open through the seam with the exact ledger entry', async () => {
    const { store, actions } = setup({
      plan: async (_t, sink) => {
        sink.source(1, NOTE_SRC);
        sink.source(2, URL_SRC);
        return { content: '노트 [1], 웹 [2], 없는 [3]', sources: [NOTE_SRC, URL_SRC] };
      },
    });
    await open(store);
    await type('q');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    const list = screen.getByRole('list', { name: '출처' });
    expect(list.textContent).toContain('README.labnote.md');
    await userEvent.click(screen.getByRole('button', { name: 'README.labnote.md' }));
    expect(actions.openSource).toHaveBeenLastCalledWith(NOTE_SRC);
    await userEvent.click(screen.getByRole('button', { name: '출처 2: Example page' }));
    expect(actions.openSource).toHaveBeenLastCalledWith(URL_SRC);
    expect(actions.openSource.mock.calls.at(-1)![0].target).toBe('https://example.test/a?q=1#x');
    // [3] is not in the ledger: plain text
    expect(screen.queryByRole('button', { name: /출처 3/ })).toBeNull();
    expect(log().textContent).toContain('없는 [3]');
  });

  it("switching the active note to another experiment cancels the run and shows only that folder's history", async () => {
    let first = true;
    const { store, rerender, turns } = setup({
      seed: { [A]: stored(A, ['A 질문', 'A 답']), [B]: stored(B, ['B 질문', 'B 답']) },
      plan: (_t, sink, signal) =>
        new Promise((resolve) => {
          if (!first) return resolve({ content: 'B 새 답' });
          first = false;
          sink.delta('A 흐르는 답');
          signal.addEventListener('abort', () => resolve({ cancelled: true }));
        }),
    });
    await open(store);
    await settle();
    expect(log().textContent).toContain('A 질문');
    await type('A 더');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    rerender(NOTE_B);
    await settle();
    expect(log().textContent).not.toContain('A ');
    expect(log().textContent).toContain('B 질문');
    expect(store.get().state).toBe('idle');
    await type('B 더');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(turns[1]!.folder).toBe(B);
    expect(JSON.stringify(turns[1])).not.toContain('A ');
    expect(screen.getByText('실험: 002_B')).toBeTruthy();
  });

  it('outside experiments the bubble says the chat is not saved and has no clear button', async () => {
    const { store } = setup({ activePath: 'notes/free.md' });
    await open(store);
    expect(screen.getByText('이 대화는 저장되지 않아요.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '이 실험의 대화 기록 지우기' })).toBeNull();
  });

  it('a vaultChanged refusal shows the notice and the composer keeps working', async () => {
    const { store, turns } = setup();
    await open(store);
    await settle();
    vault = 'v2';
    await type('q');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(screen.getByText('보관함이 바뀌어서 이 대화는 저장하지 않았어요.')).toBeTruthy();
    await type('again');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(turns).toHaveLength(2);
  });

  it('Escape closes the bubble and returns focus to the pet', async () => {
    const { store } = setup();
    await open(store);
    fireEvent.keyDown(composer(), { key: 'Escape' });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '어시스턴트 열기' }));
  });

  it('clear asks first and empties the log only when confirmed', async () => {
    const { store, confirm } = setup({ seed: { [A]: stored(A, ['남은 글']) } });
    confirm.mockResolvedValueOnce(false);
    await open(store);
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '이 실험의 대화 기록 지우기' }));
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log().textContent).toContain('남은 글');
    await userEvent.click(screen.getByRole('button', { name: '이 실험의 대화 기록 지우기' }));
    await settle();
    expect(log().textContent).not.toContain('남은 글');
  });

  it('Insert into note adds the cited sources under the reply, so its [n] do not dangle in the note', async () => {
    const { store, actions } = setup({
      plan: async (_t, sink) => {
        sink.source(1, NOTE_SRC);
        sink.source(2, URL_SRC);
        return { content: '웹 [2] 에 따르면', sources: [NOTE_SRC, URL_SRC] };
      },
    });
    await open(store);
    await type('q');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '노트에 넣기' }));
    expect(actions.insert).toHaveBeenCalledWith('웹 [2] 에 따르면\n\n출처:\n- [2] [Example page](<https://example.test/a?q=1#x>)', false);
  });

  it('Insert into note passes the reply text and its taint to the action', async () => {
    const { store, actions } = setup({ plan: async () => ({ content: '넣을 답', tainted: true }) });
    await open(store);
    await type('q');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    await userEvent.click(screen.getByRole('button', { name: '노트에 넣기' }));
    expect(actions.insert).toHaveBeenCalledWith('넣을 답', true);
  });

  it('an approval during a run is a modal dialog: the pet layer is inert meanwhile and focus returns to the composer', async () => {
    let answer: boolean | undefined;
    const { store } = setup({
      plan: async () => {
        answer = await confirmDialog('허용할까요?', { confirmLabel: '허용' });
        return { content: answer ? '했어요' : '안 했어요' };
      },
    });
    await open(store);
    await type('고쳐 줘');
    fireEvent.click(screen.getByRole('button', { name: '보내기' }));
    await settle();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(document.getElementById('pet-layer')!.hasAttribute('inert')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '허용' }));
    await settle();
    expect(answer).toBe(true);
    expect(document.getElementById('pet-layer')!.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(composer());
    expect(log().textContent).toContain('했어요');
  });

  it('the end notice of an earlier answer follows a language switch (Visual QA)', async () => {
    const { store } = setup({ plan: async () => ({ content: '답', notice: () => t('pet.tools.unchanged') }) });
    await open(store);
    await type('q');
    fireEvent.keyDown(composer(), { key: 'Enter' });
    await settle();
    expect(log().textContent).toContain('보관함은 그대로예요.');
    act(() => setLang('en'));
    expect(log().textContent).toContain('Nothing in the vault changed.');
    expect(log().textContent).not.toContain('보관함은 그대로예요.');
  });

  it('follows the language', async () => {
    setLang('en');
    const { store } = setup();
    await open(store);
    expect(screen.getByRole('textbox', { name: 'Message to the assistant' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });
});

// Plan Task 14: without a search address the chat shows a one-time hint that opens Settings › Assistant.
describe('assistant bubble web search hint', () => {
  it('shows the hint in chat when no search address is set; its button opens the Assistant pane and it stays gone', async () => {
    const runCommand = vi.fn();
    const { store } = setup({ actions: { webSearchConfigured: async () => false, runCommand } });
    await open(store);
    await settle();
    const hint = screen.getByRole('note');
    expect(hint.textContent).toContain('웹 검색을 쓰려면 설정 › 어시스턴트에서 검색 주소를 넣으세요.');
    fireEvent.click(screen.getByRole('button', { name: '설정 열기' }));
    expect(runCommand).toHaveBeenCalledWith('assistant.settings');
    expect(screen.queryByRole('note')).toBeNull();
    await act(async () => store.setOpen(false));
    await open(store);
    await settle();
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('the hint can be dismissed and is not shown when an address is set', async () => {
    const a = setup({ actions: { webSearchConfigured: async () => false, runCommand: vi.fn() } });
    await open(a.store);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: '알림 닫기' }));
    expect(screen.queryByRole('note')).toBeNull();
    cleanup();
    resetWebHint();
    const b = setup({ actions: { webSearchConfigured: async () => true, runCommand: vi.fn() } });
    await open(b.store);
    await settle();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
