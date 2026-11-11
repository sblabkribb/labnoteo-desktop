// @vitest-environment jsdom
/**
 * 말풍선의 칩 줄과 칩 흐름(assistant spec §4.4, plan Task 11B): 칩 줄은 roving tabindex 도구 막대, 제공자가 없으면
 * ai.configureFirst 와 연동 설정 단추(사용법은 빼고), 실험 밖이면 "실험 노트를 먼저 열어 주세요" 와 실험 목록 단추,
 * 사용법은 모델을 부르지 않는 도움말, 섹션·Unit Operation·Workflow는 고른 대상과 글로 칩 실행을 보낸다.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef } from 'react';
import { setLang } from '../../i18n/lang';
import { t } from '../../i18n/t';
import { DialogLayer } from '../../labnote/host/DialogLayer';
import { cleanupDialogs } from '../../labnote/host/__tests__/harness';
import { createLayoutStore, type UiPrefs } from '../../ui/layoutStore';
import { emptyHistory } from '../history';
import { PetLayer, type BubbleActions } from '../PetLayer';
import { createPetStore, type PetStore } from '../petStore';
import type { AssistantRuntime, AssistantTurn } from '../runtime';
import { createAssistantSession, type AssistantSession, type HistoryIo } from '../useAssistantSession';

const A = 'labnote/001_A';
const README_A = `${A}/README.labnote.md`;
const WF_A = `${A}/001_WD010_Design.labnote.md`;
const WF_A2 = `${A}/002_WD020_Clone.labnote.md`;
const MD = ['## [WD010 Design]', '', '### [UHW010 Liquid handling]', '', '#### Method', '', '- pipette', '', '## 메모', ''].join('\n');

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

function setup(opts: { provider?: boolean; activePath?: string; actions?: Partial<BubbleActions> } = {}) {
  const io: HistoryIo = {
    read: async (folder) => ({ doc: emptyHistory(folder), token: `v:${folder}` }),
    write: async () => {},
    clear: async () => {},
  };
  const turns: AssistantTurn[] = [];
  const rt: AssistantRuntime = {
    id: 'fake',
    label: () => 'Fake',
    available: async () => (opts.provider === false ? { ok: false, reason: t('ai.configureFirst') } : { ok: true }),
    async run(turn) {
      turns.push(structuredClone(turn));
      return { content: '했어요', sources: [], executed: [], tainted: false };
    },
  };
  const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
  const store = createPetStore({ layout: createLayoutStore({ storage: () => memoryStorage(), invoke }) });
  const session = createAssistantSession({ history: io, runtime: () => rt, setPetState: (s) => store.setState(s), confirm: async () => true });
  const actions: BubbleActions = {
    openSource: vi.fn(),
    insert: vi.fn(),
    runCommand: vi.fn(),
    activeNote: vi.fn(async () => ({ path: opts.activePath ?? WF_A, text: MD, cursorLine: 6 })),
    workflowNotes: vi.fn(async () => [WF_A, WF_A2]),
    ...opts.actions,
  };
  render(<Harness store={store} session={session} activePath={opts.activePath ?? WF_A} actions={actions} />);
  return { store, session, turns, actions };
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function open(store: PetStore) {
  await act(async () => store.setOpen(true));
  await settle();
}
const toolbar = () => screen.getByRole('toolbar', { name: '어시스턴트 할 일' });
const chip = (name: string) => within(toolbar()).getByRole('button', { name });
async function pick(name: string) {
  fireEvent.click(chip(name));
  await settle();
}

afterEach(() => {
  cleanupDialogs();
  cleanup();
  setLang('ko');
});

describe('chip toolbar', () => {
  it('is a toolbar of the five chips with one tab stop (the chosen chip, 대화 at first) and aria-pressed', async () => {
    const { store } = setup();
    await open(store);
    const buttons = within(toolbar()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['사용법', '섹션 만들기', 'Unit Operation 만들기', 'Workflow 만들기', '대화']);
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
    expect(chip('대화').getAttribute('aria-pressed')).toBe('true');
    expect(chip('사용법').getAttribute('aria-pressed')).toBe('false');
  });

  it('lays the five chips out as an even 3 + 2, not 4 + 1 (visual QA)', async () => {
    const { store } = setup();
    await open(store);
    const rows = [...toolbar().querySelectorAll('.pet-chips-row')];
    expect(rows.map((r) => r.querySelectorAll('button').length)).toEqual([3, 2]);
  });

  it('arrows, Home and End move focus and the tab stop (roving tabindex), wrapping at the ends', async () => {
    const { store } = setup();
    await open(store);
    const buttons = within(toolbar()).getAllByRole('button');
    buttons[4].focus();
    fireEvent.keyDown(buttons[4], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[0]);
    expect(buttons[0].tabIndex).toBe(0);
    expect(buttons[4].tabIndex).toBe(-1);
    fireEvent.keyDown(buttons[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons[4]);
    fireEvent.keyDown(buttons[4], { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'End' });
    expect(document.activeElement).toBe(buttons[4]);
    expect(within(toolbar()).getAllByRole('button').filter((b) => b.tabIndex === 0)).toEqual([buttons[4]]);
  });

  it('clicking a chip chooses it (session state) and moves the tab stop to it', async () => {
    const { store, session } = setup();
    await open(store);
    await pick('Workflow 만들기');
    expect(session.get().chip).toBe('workflow');
    expect(chip('Workflow 만들기').getAttribute('aria-pressed')).toBe('true');
    expect(chip('Workflow 만들기').tabIndex).toBe(0);
  });
});

describe('chip gates', () => {
  it('without a provider every chip but 사용법 shows ai.configureFirst with a button to the Integrations settings', async () => {
    const { store, actions, turns } = setup({ provider: false });
    await open(store);
    for (const name of ['섹션 만들기', 'Unit Operation 만들기', 'Workflow 만들기', '대화']) {
      await pick(name);
      expect(screen.getByText(t('ai.configureFirst')), name).toBeTruthy();
      expect(screen.queryByRole('textbox', { name: '어시스턴트에게 보낼 글' }), name).toBeNull();
    }
    fireEvent.click(screen.getByRole('button', { name: '연동 설정 열기' }));
    expect(actions.runCommand).toHaveBeenCalledWith('app.integration-settings');
    await pick('사용법');
    expect(screen.queryByText(t('ai.configureFirst'))).toBeNull();
    expect(screen.getByRole('region', { name: '사용법' })).toBeTruthy();
    expect(turns).toHaveLength(0);
  });

  it('outside an experiment the section, unit op and workflow chips ask to open an experiment note first', async () => {
    const { store, actions, turns } = setup({ activePath: 'notes/free.md' });
    await open(store);
    for (const name of ['섹션 만들기', 'Unit Operation 만들기', 'Workflow 만들기']) {
      await pick(name);
      expect(screen.getByText('실험 노트를 먼저 열어 주세요.'), name).toBeTruthy();
    }
    fireEvent.click(screen.getByRole('button', { name: '실험 목록 열기' }));
    expect(actions.runCommand).toHaveBeenCalledWith('open-workflow-view');
    await pick('대화');
    expect(screen.queryByText('실험 노트를 먼저 열어 주세요.')).toBeNull();
    expect(turns).toHaveLength(0);
  });
});

describe('chip flows', () => {
  it('사용법 shows the help card with command buttons and calls no model', async () => {
    const { store, session, turns, actions } = setup({ provider: false });
    await open(store);
    await pick('사용법');
    const card = screen.getByRole('region', { name: '사용법' });
    expect(card.textContent).toContain('Alt+');
    fireEvent.click(within(card).getByRole('button', { name: '어시스턴트 설정' }));
    expect(actions.runCommand).toHaveBeenCalledWith('assistant.settings');
    fireEvent.click(within(card).getByRole('button', { name: '대화하기' }));
    await settle();
    expect(session.get().chip).toBe('chat');
    expect(turns).toHaveLength(0);
  });

  it('섹션 만들기: pick a heading of the open note, add a hint, and the chip run goes out with that section', async () => {
    const { store, turns } = setup();
    await open(store);
    await pick('섹션 만들기');
    const select = screen.getByRole('combobox', { name: '어떤 섹션?' }) as HTMLSelectElement;
    const method = [...select.options].find((o) => o.textContent?.startsWith('Method'))!;
    fireEvent.change(select, { target: { value: method.value } });
    const box = screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' });
    fireEvent.change(box, { target: { value: '희석 포함' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(turns).toHaveLength(1);
    expect(turns[0].mode).toEqual({
      kind: 'chip',
      chip: 'section',
      params: { documentPath: WF_A, heading: 'Method', parentHeading: '[UHW010 Liquid handling]', existing: 'yes' },
    });
    expect(screen.getByRole('log').textContent).toContain('[섹션 만들기] Method — 희석 포함');
  });

  it('섹션 만들기 does not send before a section is chosen', async () => {
    const { store, turns } = setup();
    await open(store);
    await pick('섹션 만들기');
    const send = screen.getByRole('button', { name: '보내기' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' }), { key: 'Enter' });
    await settle();
    expect(turns).toHaveLength(0);
  });

  it('Unit Operation 만들기 targets the open workflow note', async () => {
    const { store, turns } = setup();
    await open(store);
    await pick('Unit Operation 만들기');
    expect(screen.getByText(t('chip.target', '001_WD010_Design.labnote.md'))).toBeTruthy();
    const box = screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' });
    fireEvent.change(box, { target: { value: 'PCR 산물 정제 추가' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(turns[0].mode).toEqual({ kind: 'chip', chip: 'unitOp', params: { documentPath: WF_A } });
    expect(screen.getByRole('log').textContent).toContain('[Unit Operation 만들기] PCR 산물 정제 추가');
  });

  it('Unit Operation 만들기 from the README picks one of the experiment workflow notes', async () => {
    const { store, turns, actions } = setup({ activePath: README_A });
    await open(store);
    await pick('Unit Operation 만들기');
    expect(actions.workflowNotes).toHaveBeenCalledWith(A);
    const select = screen.getByRole('combobox', { name: '어느 Workflow 노트에?' }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['001_WD010_Design.labnote.md', '002_WD020_Clone.labnote.md']);
    fireEvent.change(select, { target: { value: WF_A2 } });
    const box = screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' });
    fireEvent.change(box, { target: { value: 'PCR' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(turns[0].mode).toEqual({ kind: 'chip', chip: 'unitOp', params: { documentPath: WF_A2 } });
  });

  it('a long workflow note name is shortened in the middle in the select; the full name is its title (Visual QA)', async () => {
    const long = `${A}/001_WD090_Genome_Editing_Design_test.labnote.md`;
    const { store } = setup({ activePath: README_A, actions: { workflowNotes: vi.fn(async () => [long]) } });
    await open(store);
    await pick('Unit Operation 만들기');
    const select = (await screen.findByRole('combobox', { name: '어느 Workflow 노트에?' })) as HTMLSelectElement;
    const option = select.options[0];
    expect(option.title).toBe('001_WD090_Genome_Editing_Design_test.labnote.md');
    expect([...option.textContent!].length).toBe(36);
    expect(option.textContent!.startsWith('001_WD090_Genome_')).toBe(true);
    expect(option.textContent!.endsWith('test.labnote.md')).toBe(true);
    expect(option.textContent).toContain('…');
    expect(select.title).toBe('001_WD090_Genome_Editing_Design_test.labnote.md');
  });

  it('Workflow 만들기 sends the goal in the current experiment', async () => {
    const { store, turns } = setup({ activePath: README_A });
    await open(store);
    await pick('Workflow 만들기');
    const box = screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' });
    fireEvent.change(box, { target: { value: '플라스미드 클로닝' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await settle();
    expect(turns[0].mode).toEqual({ kind: 'chip', chip: 'workflow', params: { documentPath: README_A } });
    expect(turns[0].folder).toBe(A);
  });
});
