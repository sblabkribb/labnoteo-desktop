// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { App } from '../App';
import { clearToasts } from '../labnote/host/toastStore';
import { DEFAULT_PREFS, layoutStore } from '../ui/layoutStore';
import { setLang } from '../i18n/lang';
import { installFakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
document.execCommand ??= () => false;

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

const EXP = 'labnote/003_E_coli_host';
const README = `${EXP}/README.labnote.md`;
const WF_NAME = '002_WT020_Protein_Expression_Measurement_GFP.labnote.md';
const WF = `${EXP}/${WF_NAME}`;

function uo(id: string, name: string, end: string): string[] {
  return ['---', '', `### [${id} ${name}]`, '', '#### Meta', '- Experimenter: A', "- Start_date: '2026-11-08 10:00'", `- End_date: '${end}'`, '', '#### Method', '- x', ''];
}

const FILES: Record<string, string> = {
  [README]: [
    '---',
    'title: E. coli host',
    'status: in-progress',
    '---',
    '## 🗂️ Related Workflows',
    '',
    `- [ ] [WT020 Protein Expression Measurement GFP](./${WF_NAME})`,
    '- [x] [WB150 PCR](./001_WB150_PCR.labnote.md)',
    '- [ ] [WT030 More](./003_WT030_More.labnote.md)',
    '',
  ].join('\n'),
  [WF]: [
    '---',
    "end_date: ''",
    '---',
    '## [WT020 Protein Expression Measurement] GFP',
    '',
    ...uo('UHW180', 'Incubation', '2026-11-09 08:00'),
    ...uo('UHW380', 'Microplate Reading', ''),
  ].join('\n'),
  'Plain note.md': 'one two\nthree',
};

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  layoutStore.update({ ...DEFAULT_PREFS, leftTab: 'files' });
  // 이 보관함은 탭을 고른 적이 있다: labnote/ 가 있어도 파일 탭을 그대로 둔다
  localStorage.setItem('labnoteo-sidebar-tab:C:/fake-vault', 'files');
});
afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
  setLang('ko');
  document.documentElement.removeAttribute('data-theme');
});

async function editorView(): Promise<EditorView> {
  let view: EditorView | undefined;
  await waitFor(() => {
    const root = (document.querySelector('.editor-frame') as HTMLElement | null)?.shadowRoot;
    const el = root?.querySelector('.cm-editor') as HTMLElement | null;
    view = el ? (EditorView.findFromDOM(el) ?? undefined) : undefined;
    expect(view).toBeTruthy();
  });
  return view!;
}

const openPath = async (path: string) => {
  await waitFor(() => expect(document.querySelector(`section.editor-view[data-path="${path}"]`)).not.toBeNull());
  await waitFor(async () => expect((await editorView()).state.readOnly).toBe(false));
};

async function runFromPalette(user: ReturnType<typeof userEvent.setup>, name: string) {
  const button = screen.getAllByRole('button', { name: /^(명령 팔레트|Command palette)$/ })[0] as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await user.click(button);
  await user.type(within(await screen.findByRole('dialog')).getByRole('combobox'), name);
  await act(async () => {
    await user.keyboard('{Enter}');
  });
}

const header = () => within(document.querySelector('.view-header') as HTMLElement);
const statusbar = () => within(document.querySelector('.statusbar') as HTMLElement);

async function openVault(user: ReturnType<typeof userEvent.setup>, name = WF_NAME) {
  installFakeVault(FILES);
  render(<App />);
  await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
  // 파일 탭은 .labnote.md / .md 를 뗀 이름을 그린다(전체 이름은 title)
  await user.click(await screen.findByTitle(name));
}

describe('view header and status bar', () => {
  it('a workflow note: breadcrumb experiment › workflow with a UO menu, status chip, Add UO, Insert table, status bar position', async () => {
    const user = userEvent.setup();
    await openVault(user);
    await openPath(WF);
    const crumbs = within(screen.getByRole('navigation', { name: '노트 위치' }));
    const exp = crumbs.getByRole('button', { name: /003\s*E coli host/ });
    const wf = await crumbs.findByRole('button', { name: /WT020\s*GFP/ });
    expect(wf.getAttribute('aria-current')).toBe('page');
    // UO 진행 칩(하나 끝나고 하나 남음). Workflow 완료 체크는 머리에 없다(실험 탭, README 체크박스, 팔레트)
    await waitFor(() => expect(header().getByText('Unit Operation 1/2')).toBeTruthy());
    expect(header().queryByRole('checkbox')).toBeNull();
    expect(header().getByRole('button', { name: 'UO 추가' })).toBeTruthy();
    expect(header().getByRole('button', { name: '표 넣기' })).toBeTruthy();
    expect(header().queryByRole('button', { name: 'Workflow 추가' })).toBeNull();
    // 상태 줄
    await waitFor(() => expect(statusbar().getByRole('button', { name: /WT020 · UO 1\/2 완료/ })).toBeTruthy());
    expect(statusbar().getByText('저장됨')).toBeTruthy();
    expect(statusbar().getByText('줄 1, 열 1')).toBeTruthy();
    // 커서를 3번째 줄 5번째 칸으로
    const v = await editorView();
    act(() => v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 2 } }));
    await waitFor(() => expect(statusbar().getByText('줄 3, 열 3')).toBeTruthy());
    // UO 메뉴: 고르면 그 제목으로 간다
    await user.click(wf);
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['IncubationUHW180', 'Microplate ReadingUHW380']);
    await user.click(items[1]);
    await waitFor(() => expect(v.state.doc.lineAt(v.state.selection.main.head).text).toBe('### [UHW380 Microplate Reading]'));
    // 실험 칸은 README 를 연다: 주 동작이 "Workflow 추가" 가 되고 체크리스트 칩과 상태 칩(눌러서 바꾸기)이 보인다
    await user.click(exp);
    await openPath(README);
    await waitFor(() => expect(header().getByText('Workflow 1/3')).toBeTruthy());
    expect(header().getByRole('button', { name: 'Workflow 추가' })).toBeTruthy();
    expect(header().queryByRole('button', { name: 'UO 추가' })).toBeNull();
    expect(header().getByRole('button', { name: '진행 중' }).title).toBe('상태: 진행 중 (눌러서 바꾸기)');
    await waitFor(() => expect(statusbar().getByRole('button', { name: /003 · Workflow 1\/3/ })).toBeTruthy());
    // 뒤로 단추와 Alt+→
    const back = header().getByRole('button', { name: '뒤로' }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    await user.click(back);
    await openPath(WF);
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    await openPath(README);
  });

  it('the palette command ticks and unticks the README checklist line of the open Workflow', async () => {
    const user = userEvent.setup();
    const vault = installFakeVault(FILES);
    render(<App />);
    await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
    await user.click(await screen.findByTitle(WF_NAME));
    await openPath(WF);
    await runFromPalette(user, 'Workflow 완료 표시 바꾸기');
    await waitFor(() => expect(vault.files()[README]).toContain(`- [x] [WT020 Protein Expression Measurement GFP](./${WF_NAME})`));
    await runFromPalette(user, 'Workflow 완료 표시 바꾸기');
    await waitFor(() => expect(vault.files()[README]).toContain(`- [ ] [WT020 Protein Expression Measurement GFP](./${WF_NAME})`));
    // 다른 줄은 그대로다
    expect(vault.files()[README]).toContain('- [x] [WB150 PCR](./001_WB150_PCR.labnote.md)');
  });

  it('a bare README checklist line (no dash) ticks from its editor checkbox; only the box changes and the count follows', async () => {
    const user = userEvent.setup();
    const bare = (FILES[README] as string).replace(/^- \[/gm, '[');
    const vault = installFakeVault({ ...FILES, [README]: bare });
    render(<App />);
    await screen.findByText('fake-vault', { selector: '.vault-bar-name' });
    await user.click(await screen.findByTitle(WF_NAME));
    await openPath(WF);
    await user.click(within(screen.getByRole('navigation', { name: '노트 위치' })).getByRole('button', { name: /003\s*E coli host/ }));
    await openPath(README);
    await waitFor(() => expect(header().getByText('Workflow 1/3')).toBeTruthy());
    const v = await editorView();
    act(() => v.dispatch({ selection: { anchor: 0 } }));
    const box = await waitFor(() => {
      const el = [...v.contentDOM.querySelectorAll<HTMLElement>('input.lno-task')].find((b) =>
        v.state.doc.lineAt(v.posAtDOM(b)).text.startsWith('[ ] [WT020'),
      );
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.mouseDown(box, { button: 0 });
    expect(v.state.doc.toString()).toBe(bare.replace('[ ] [WT020', '[x] [WT020'));
    await waitFor(() => expect(header().getByText('Workflow 2/3')).toBeTruthy());
    await waitFor(() => expect(vault.files()[README]).toBe(bare.replace('[ ] [WT020', '[x] [WT020')), { timeout: 5000 });
  });

  it('a plain note has no primary action and no structure position; the status bar counts words', async () => {
    const user = userEvent.setup();
    await openVault(user, 'Plain note.md');
    await openPath('Plain note.md');
    expect(header().getByRole('button', { name: '표 넣기' })).toBeTruthy();
    expect(header().queryByRole('button', { name: 'UO 추가' })).toBeNull();
    expect(header().queryByRole('button', { name: 'Workflow 추가' })).toBeNull();
    expect(screen.getByRole('navigation', { name: '노트 위치' }).textContent).toBe('Plain note');
    await waitFor(() => expect(statusbar().getByText('단어 3')).toBeTruthy());
    expect(document.querySelector('.statusbar-position')).toBeNull();
    // ⋯ 메뉴
    await user.click(header().getByRole('button', { name: '더 보기' }));
    expect(within(await screen.findByRole('menu')).getByRole('menuitem', { name: '경로 복사' })).toBeTruthy();
  });

  it('the appearance popover switches theme and language and has the all-settings footer; no native select in the chrome', async () => {
    const user = userEvent.setup();
    await openVault(user, 'Plain note.md');
    await openPath('Plain note.md');
    expect(document.querySelectorAll('.shell select')).toHaveLength(0);
    // 실험 탭의 "묶는 기준" 도 고르기 메뉴다
    await user.click(screen.getByRole('tab', { name: '실험' }));
    expect(await screen.findByRole('button', { name: /^묶는 기준: / })).toBeTruthy();
    expect(document.querySelectorAll('.shell select')).toHaveLength(0);
    const button = statusbar().getByRole('button', { name: '모양' });
    await user.click(button);
    const pop = within(screen.getByRole('dialog', { name: '모양' }));
    expect(document.querySelectorAll('.shell select')).toHaveLength(0);
    const theme = pop.getByRole('radiogroup', { name: '테마' });
    expect(within(theme).getAllByRole('radio').map((r) => r.textContent)).toEqual(['시스템', '밝게', '어둡게']);
    await user.click(within(theme).getByRole('radio', { name: '어둡게' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(within(theme).getByRole('radio', { name: '어둡게' }).getAttribute('aria-checked')).toBe('true');
    const footer = pop.getByRole('button', { name: /모든 설정 열기/ });
    expect(footer.textContent).toContain('Ctrl+,');
    // 언어: 고르기 메뉴(listbox)
    await user.click(pop.getByRole('button', { name: '언어: 한국어' }));
    await user.click(screen.getByRole('option', { name: 'English' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Appearance' })).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Appearance' })).toBeTruthy();
    // Esc 는 닫고 단추로 초점을 돌려준다
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Appearance' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Appearance' }));
    // 모든 설정 열기: 설정 창의 일반 쪽
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    await user.click(screen.getByRole('button', { name: /Open all settings/ }));
    const settings = within(await screen.findByRole('dialog', { name: 'Settings' }));
    expect(settings.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Ctrl+, opens all settings', async () => {
    const user = userEvent.setup();
    await openVault(user, 'Plain note.md');
    await openPath('Plain note.md');
    await waitFor(() => expect((screen.getAllByRole('button', { name: '명령 팔레트' })[0] as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(window, { key: ',', code: 'Comma', ctrlKey: true });
    const settings = within(await screen.findByRole('dialog', { name: '설정' }));
    expect(settings.getByRole('tab', { name: '일반' }).getAttribute('aria-selected')).toBe('true');
    expect(settings.getByRole('radiogroup', { name: '테마' })).toBeTruthy();
  });

  it('the gear in the vault bar opens settings; Esc closes it and gives focus back to the gear', async () => {
    const user = userEvent.setup();
    await openVault(user, 'Plain note.md');
    const gear = screen.getByRole('button', { name: '설정' });
    await waitFor(() => expect((gear as HTMLButtonElement).disabled).toBe(false));
    expect(gear.getAttribute('aria-haspopup')).toBe('dialog');
    await user.click(gear);
    const settings = within(await screen.findByRole('dialog', { name: '설정' }));
    expect(settings.getByRole('tab', { name: '일반' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull());
    expect(document.activeElement).toBe(gear);
  });

  it('the integration and sample settings commands open those settings pages', async () => {
    const user = userEvent.setup();
    await openVault(user, 'Plain note.md');
    await runFromPalette(user, '연동 설정');
    let settings = within(await screen.findByRole('dialog', { name: '설정' }));
    expect(settings.getByRole('tab', { name: '연동' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '설정' })).toBeNull());
    await runFromPalette(user, '샘플 설정');
    settings = within(await screen.findByRole('dialog', { name: '설정' }));
    expect(settings.getByRole('tab', { name: '샘플' }).getAttribute('aria-selected')).toBe('true');
  });
});
