// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { App } from '../App';
import { baseInvoke } from './fixtures';
import { AUTOSAVE_MS, MAX_AUTOSAVE_MS } from '../editor/Editor';
import { getLang, LANG_KEY, setLang } from '../i18n/lang';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  dialog: { open: vi.fn(), save: vi.fn() },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/plugin-dialog', () => tauri.dialog);
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

const VAULT = { root: 'D:/lab', name: 'lab', hasObsidianConfig: false };
const NOTE = 'Day 1.labnote.md';

/** 보관함이 열린 채로 시작한다. 노트 하나가 트리에 있다. 쓰기는 세어 둔다(저장되면 안 되는 곳을 본다). */
function vaultReady(body = 'PCR 결과\n') {
  tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'vault_current') return VAULT;
    if (cmd === 'vault_tree') return [{ path: NOTE, name: 'Day 1', isDir: false, depth: 0 }];
    if (cmd === 'index_rebuild') return { indexed: 1, skipped: 0 };
    if (cmd === 'app_version') return '0.0.0';
    if (cmd === 'vault_read') return body;
    if (cmd === 'vault_modify') return { kind: 'ok' };
    if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
    throw new Error(`unexpected ${cmd}`);
  });
}

function picker() {
  tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === 'vault_current') return null;
    if (cmd === 'app_version') return '0.0.0';
    if (cmd === 'vault_open') throw { kind: 'vaultNotFound', message: 'vault root not found' };
    if (baseInvoke(cmd, args) !== undefined) return baseInvoke(cmd, args);
    throw new Error(`unexpected ${cmd}`);
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 화면 글과, 글이 아닌 곳에 쓰이는 이름(placeholder, aria-label, title, alt)에 남은 한글. 언어 이름 선택지(한국어)는 뺀다. */
const NAMED = ['placeholder', 'aria-label', 'title', 'alt'];
function hangulIn(root: Element | ShadowRoot): string[] {
  const out: string[] = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.matches('option[lang]')) continue;
    for (const a of NAMED) {
      const v = el.getAttribute(a);
      if (v && /[가-힣]/.test(v)) out.push(`${el.tagName.toLowerCase()}[${a}]: ${v}`);
    }
    // 자기 글자만 본다(자식 요소의 글은 그 요소 차례에 본다)
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE && /[가-힣]/.test(n.textContent ?? '')) out.push(`${el.tagName.toLowerCase()}: ${n.textContent}`);
    }
  }
  return out;
}

const languageSelect = (scope: HTMLElement, name: string) => within(scope).getByRole<HTMLSelectElement>('combobox', { name });

/** 보관함 화면에서 언어 바꾸기: 창 틀의 고르기 상자는 빠졌고(Task 5), 팔레트의 언어 명령으로 바꾼다. */
async function langFromPalette(user: ReturnType<typeof userEvent.setup>, paletteName: string, command: string) {
  const button = within(screen.getByRole('toolbar')).getByRole('button', { name: paletteName }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await user.click(button);
  await user.type(within(await screen.findByRole('dialog')).getByRole('combobox'), command);
  await act(async () => {
    await user.keyboard('{Enter}');
  });
}

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

// Node 의 자체 localStorage 가 jsdom 의 것을 가려 환경마다 다르므로, 같은 동작의 가짜 저장소를 직접 꽂는다.
beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  tauri.invoke.mockReset();
  tauri.dialog.open.mockReset();
});

describe('영어 화면', () => {
  it('첫 화면이 영어로 뜬다', async () => {
    setLang('en');
    picker();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 2, name: 'Choose where to keep your notes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create new vault' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open folder' })).toBeTruthy();
    const main = screen.getByRole('main');
    expect(languageSelect(main, 'Language').value).toBe('en');
    expect(within(main).getByRole('combobox', { name: 'Theme' })).toBeTruthy();
    expect(within(main).getByRole('option', { name: 'Match system' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('리본, 사이드바, 보관함 줄, 빈 편집기 안내가 영어로 뜬다', async () => {
    setLang('en');
    vaultReady();
    render(<App />);
    expect(await screen.findByText('lab', { selector: '.vault-bar-name' })).toBeTruthy();
    const ribbon = screen.getByRole('toolbar', { name: 'Ribbon' });
    expect(within(ribbon).getByRole('button', { name: 'New note' }).title).toBe('New note (Ctrl+N)');
    expect(within(ribbon).getByRole('button', { name: 'Show or hide left sidebar' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Sidebar view' })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Vault' })).getByRole('button', { name: 'Vault menu' })).toBeTruthy();
    const side = screen.getByRole('complementary', { name: 'Sidebar' });
    expect(within(side).getByRole('searchbox', { name: 'Search notes' })).toBeTruthy();
    expect(await within(side).findByRole('navigation', { name: 'Notes' })).toBeTruthy();
    expect(within(screen.getByRole('main')).getByText("Pick a note on the left, or start with 'New experiment' in the Experiments tab or Ctrl+P.")).toBeTruthy();
    expect(within(screen.getByRole('contentinfo')).getByText('Version 0.0.0')).toBeTruthy();
    // 한국어가 한 글자도 남지 않았다: 글자와 이름(placeholder, aria-label, title, alt) 모두.
    // 언어 이름 선택지(한국어)만은 일부러 자기 언어로 적는다.
    expect(document.body.textContent).toContain('Pick a note on the left'); // 실제 화면을 읽었다
    expect(hangulIn(document.body)).toEqual([]);
    // 검사식 자체: 한글 이름표와 글자를 실제로 잡고, 언어 이름 선택지는 건너뛴다
    const probe = document.createElement('div');
    probe.innerHTML = '<input placeholder="찾기"><p>글</p><select><option lang="ko">한국어</option></select>';
    expect(hangulIn(probe)).toEqual(['input[placeholder]: 찾기', 'p: 글']);
  });

  it('노트를 연 편집기도 영어다: 그림자 루트 안의 글과 이름까지', async () => {
    setLang('en');
    vaultReady('PCR result\n'); // 노트 본문은 사용자의 글이라 영어로 둔다: 남은 한글이 있다면 화면의 것이다
    render(<App />);
    await userEvent.setup().click(await screen.findByRole('treeitem', { name: 'Day 1' }));
    const host = screen.getByRole('main').querySelector('.editor-frame') as HTMLElement;
    await waitFor(() => expect(host.hidden).toBe(false));
    const shadow = host.shadowRoot!;
    const view = EditorView.findFromDOM(shadow.querySelector('.cm-editor') as HTMLElement)!;
    await waitFor(() => expect(view.state.readOnly).toBe(false));
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Note editor');
    expect(shadow.textContent).toContain('PCR result'); // 그림자 루트를 실제로 읽었다
    expect(hangulIn(shadow)).toEqual([]);
    expect(hangulIn(document.body)).toEqual([]);
  });
});

describe('언어 선택', () => {
  it('선택지는 자기 언어로 적힌 이름이고, 각 선택지에 그 언어의 lang 이 붙는다 (보관함을 고르는 첫 화면)', async () => {
    picker();
    render(<App />);
    await screen.findByText('노트를 둘 곳을 정하세요');
    const select = languageSelect(screen.getByRole('main'), '언어');
    const options = within(select).getAllByRole<HTMLOptionElement>('option');
    expect(options.map((o) => [o.value, o.textContent, o.lang])).toEqual([
      ['ko', '한국어', 'ko'],
      ['en', 'English', 'en'],
    ]);
  });

  it('바꾸는 즉시 화면, html lang, 저장된 선택이 따른다 (다시 띄우지 않는다)', async () => {
    const user = userEvent.setup();
    vaultReady();
    render(<App />);
    await screen.findByText('lab', { selector: '.vault-bar-name' });
    expect(document.documentElement.lang).toBe('ko');

    await langFromPalette(user, '명령 팔레트', '언어: English');
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(screen.getByText('lab', { selector: '.vault-bar-name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vault menu' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '보관함 메뉴' })).toBeNull();
    expect(getLang()).toBe('en');
    expect(localStorage.getItem(LANG_KEY)).toBe('en');

    await langFromPalette(user, 'Command palette', 'Language: Korean');
    await waitFor(() => expect(document.documentElement.lang).toBe('ko'));
    expect(screen.getByRole('button', { name: '보관함 메뉴' })).toBeTruthy();
  });

  it('첫 화면에서도 바꿀 수 있고, 이미 보이던 오류 문구도 새 언어로 바뀐다', async () => {
    const user = userEvent.setup();
    picker();
    render(<App />);
    await screen.findByText('노트를 둘 곳을 정하세요');
    tauri.dialog.open.mockResolvedValue('D:/gone');
    await user.click(screen.getByRole('button', { name: '기존 폴더 열기' }));
    expect((await screen.findByRole('alert')).textContent).toBe('폴더를 찾을 수 없습니다. 다시 선택해 주세요.');

    await user.selectOptions(languageSelect(screen.getByRole('main'), '언어'), 'en');
    expect(screen.getByText('Choose where to keep your notes')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe("Can't find this folder. Choose it again.");
  });

  it('저장 안 된 편집은 바꾼 뒤에도 같은 편집기에 그대로 있고 여전히 저장 안 됨이다', async () => {
    const user = userEvent.setup();
    vaultReady();
    render(<App />);
    await user.click(await screen.findByRole('treeitem', { name: 'Day 1' }));
    // 화면이 다시 마운트되면 main 도 새것이 된다: 매번 새로 찾아, 다시 마운트됐다면 아래 toBe(before) 가 그것을 드러내게 한다.
    const main = () => screen.getByRole('main');
    // 저장 표시는 창 아래 상태 줄에 있다(본문 밖)
    const statusbar = () => document.querySelector('.statusbar') as HTMLElement;
    // 편집기는 그림자 루트 안에 있다(CSP 때문에): 질의가 들어가지 못하므로 뷰로 직접 간다.
    const view = () => {
      const root = (main().querySelector('.editor-frame') as HTMLElement).shadowRoot!;
      return EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
    };
    await waitFor(() => expect(view().state.doc.toString()).toBe('PCR 결과\n'));
    await waitFor(() => expect(view().state.readOnly).toBe(false));
    const before = view();
    const saves = () => tauri.invoke.mock.calls.filter(([cmd]) => cmd === 'vault_modify');

    // 여기서부터 시계를 손으로 돌린다: 자동 저장(AUTOSAVE_MS 무입력, MAX_AUTOSAVE_MS 상한)이 언제 도는지를 본다.
    // (그 전에 켜면 위의 waitFor 가 돌지 않는다.)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    // userEvent 는 입력 사이에 타이머를 기다린다: 손으로 돌리는 시계 아래에서는 change 이벤트를 직접 보낸다(select 의 change 와 같다)
    // 팔레트의 언어 명령이 하는 일(setLang)을 바로 부른다: 팔레트를 타이핑하면 userEvent 가 멈춘 시계를 기다린다
    const choose = (_name: string, value: 'ko' | 'en') => act(() => setLang(value));
    await act(async () => before.dispatch({ changes: { from: before.state.doc.length, insert: 'Tm 58 °C' }, userEvent: 'input.type' }));
    expect(within(statusbar()).getByText('저장 안 됨')).toBeTruthy();

    await choose('언어', 'en');

    expect(view()).toBe(before); // 같은 편집기다: 다시 마운트하지 않았다
    expect(view().state.doc.toString()).toBe('PCR 결과\nTm 58 °C');
    expect(within(statusbar()).getByText('Unsaved')).toBeTruthy();
    expect(within(main()).queryByText('저장 안 됨')).toBeNull();
    expect(view().contentDOM.getAttribute('aria-label')).toBe('Note editor'); // 편집기 안의 이름표도 따른다

    // 바꾸기가 저장을 일으키거나 앞당기지 않았다: 자동 저장이 돌기 직전까지 쓰기가 없다.
    await act(() => vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1));
    expect(saves()).toEqual([]);
    await choose('Language', 'ko');
    expect(view()).toBe(before);
    expect(view().state.doc.toString()).toBe('PCR 결과\nTm 58 °C');
    expect(within(statusbar()).getByText('저장 안 됨')).toBeTruthy();
    expect(view().contentDOM.getAttribute('aria-label')).toBe('노트 편집기');
    expect(saves()).toEqual([]);

    // 무입력 대기와 상한을 모두 지나면: 바꾸기 전에 친 글이 정확히 한 번, 그대로 저장된다.
    await act(() => vi.advanceTimersByTimeAsync(MAX_AUTOSAVE_MS + AUTOSAVE_MS));
    expect(saves()).toHaveLength(1);
    expect(saves()[0][1]).toMatchObject({ path: NOTE, content: 'PCR 결과\nTm 58 °C' });
    expect(within(main()).queryByText('저장 안 됨')).toBeNull();
  });
});
