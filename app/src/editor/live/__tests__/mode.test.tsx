// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { Editor } from '../../Editor';
import { activeCellView, focusCell } from '../../table/cellEditor';
import { insertTable } from '../../table/commands';
import { catalogs } from '../../../i18n/t';
import { VAULT_CHANGED, type VaultChange } from '../../../vault/useVaultEvents';
import { getMode, MODE_KEY, setMode, subscribeMode, toggleMode } from '../mode';

// jsdom 에는 레이아웃이 없다. CodeMirror 가 측정에 쓰는 API 만 빈 값으로 채운다.
const emptyRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
// 그림자 루트 안에서 포커스를 주면 CodeMirror 가 선택을 읽으려고 execCommand 를 부른다(jsdom 에는 없다).
document.execCommand ??= () => false;

// Node 의 자체 localStorage 가 jsdom 의 것을 가려 환경마다 다르므로, 같은 동작의 가짜 저장소를 직접 꽂는다(useTheme.test.ts 와 같다).
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

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  localStorage.clear();
  setMode('live');
});
afterEach(() => vi.unstubAllGlobals());

const TABLE = '| a | b |\n| - | - |\n';
const P = 'a.labnote.md';

/** 키를 누른다: 실제 keydown 사건을 그 요소에 보낸다. keyCode 는 jsdom 의 초기화 사전이 받지 않을 수 있어 직접 붙인다. */
function pressKey(el: HTMLElement, init: { key: string; code: string; keyCode: number; ctrlKey?: boolean }): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: init.key, code: init.code, ctrlKey: !!init.ctrlKey, bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
  Object.defineProperty(ev, 'which', { value: init.keyCode });
  el.dispatchEvent(ev);
  return ev;
}
const CTRL_E = { key: 'e', code: 'KeyE', keyCode: 69, ctrlKey: true };

/** 앱의 편집기를 띄운다. reload() 는 디스크의 노트를 조용히 다시 읽게 한다(바깥 변경, 저장 안 된 편집 없음). */
async function mountWithTable(text = TABLE) {
  const files: Record<string, string> = { [P]: text };
  let onChange: ((e: { payload: VaultChange }) => void) | undefined;
  const invoke = (async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === 'vault_read') return files[args.path as string];
    throw new Error(`unexpected ${cmd}`);
  }) as never;
  const listen = (async (name: string, fn: (e: { payload: VaultChange }) => void) => {
    if (name === VAULT_CHANGED) onChange = fn;
    return () => {};
  }) as never;
  const windowApi = { onCloseRequested: async () => () => {}, destroy: async () => {} };
  const utils = render(<Editor path={P} invoke={invoke} listen={listen} windowApi={windowApi} autosaveMs={60_000} />);
  const shadow = (utils.container.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
  await waitFor(() => expect(shadow.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('true'));
  const view = () => EditorView.findFromDOM(shadow.querySelector('.cm-editor') as HTMLElement)!;
  const reload = async () => {
    const before = view().state;
    files[P] = `${text}\n본문`;
    await act(async () => onChange!({ payload: { path: P } as VaultChange }));
    await waitFor(() => expect(view().state.doc.toString()).toBe(`${text}\n본문`));
    expect(view().state).not.toBe(before);
  };
  return { view: view(), viewNow: view, shadow, reload, utils };
}

describe('편집기 모드 저장소', () => {
  it('defaults to live and survives a throwing localStorage', async () => {
    vi.resetModules();
    const deny = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: deny, setItem: deny });
    const fresh = await import('../mode');
    expect(fresh.getMode()).toBe('live');
    // 저장하지 못해도 이번 실행에는 바뀐다
    expect(fresh.toggleMode()).toBe('source');
    expect(fresh.getMode()).toBe('source');
  });

  it('reads a stored mode at start and ignores unknown values', async () => {
    localStorage.setItem(MODE_KEY, 'source');
    vi.resetModules();
    expect((await import('../mode')).getMode()).toBe('source');
    localStorage.setItem(MODE_KEY, 'weird');
    vi.resetModules();
    expect((await import('../mode')).getMode()).toBe('live');
  });

  it('setMode persists and notifies; toggleMode flips; unsubscribe stops notifications', () => {
    const seen: string[] = [];
    const off = subscribeMode((m) => seen.push(m));
    setMode('source');
    expect(localStorage.getItem(MODE_KEY)).toBe('source');
    expect(toggleMode()).toBe('live');
    setMode('live'); // 같은 값: 알리지 않는다
    off();
    toggleMode();
    expect(seen).toEqual(['source', 'live']);
    expect(getMode()).toBe('source');
  });
});

describe('Ctrl+E 와 모드 칸', () => {
  it('Ctrl+E toggles source: tables show raw pipes, mode persists across a silent reload', async () => {
    const { view, viewNow, shadow, reload, utils } = await mountWithTable();
    expect(shadow.querySelector('.lno-table-wrap')).not.toBeNull();
    act(() => void pressKey(view.contentDOM, CTRL_E));
    expect(shadow.querySelector('.lno-table-wrap')).toBeNull();
    expect(view.contentDOM.textContent).toContain('| a | b |');
    expect(localStorage.getItem(MODE_KEY)).toBe('source');
    await reload();
    expect(shadow.querySelector('.lno-table-wrap')).toBeNull();
    expect(getMode()).toBe('source');
    // 다시 누르면 격자가 돌아온다
    act(() => void pressKey(viewNow().contentDOM, CTRL_E));
    expect(shadow.querySelector('.lno-table-wrap')).not.toBeNull();
    utils.unmount();
  });

  it('a mode change from elsewhere reconfigures every mounted editor', async () => {
    const a = await mountWithTable();
    const b = await mountWithTable();
    act(() => setMode('source'));
    expect(a.shadow.querySelector('.lno-table-wrap')).toBeNull();
    expect(b.shadow.querySelector('.lno-table-wrap')).toBeNull();
    a.utils.unmount();
    act(() => setMode('live'));
    expect(b.shadow.querySelector('.lno-table-wrap')).not.toBeNull();
    b.utils.unmount();
  });

  it('a newly mounted editor starts in the stored mode', async () => {
    setMode('source');
    const { shadow, utils } = await mountWithTable();
    expect(shadow.querySelector('.lno-table-wrap')).toBeNull();
    utils.unmount();
  });

  it('Ctrl+E on the Korean layout (key "ㄷ") toggles too', async () => {
    const { view, utils } = await mountWithTable();
    act(() => void pressKey(view.contentDOM, { key: 'ㄷ', code: 'KeyE', keyCode: 69, ctrlKey: true }));
    expect(getMode()).toBe('source');
    utils.unmount();
  });

  it('Ctrl+E is preventDefault-ed', async () => {
    const { view, utils } = await mountWithTable();
    let ev!: KeyboardEvent;
    act(() => void (ev = pressKey(view.contentDOM, CTRL_E)));
    expect(ev.defaultPrevented).toBe(true);
    utils.unmount();
  });

  it('Ctrl+E fires while a table cell has focus and focus returns to the outer editor', async () => {
    const { view: outer, shadow, utils } = await mountWithTable('| a | b |\n| - | - |\n| 1 | 2 |\n');
    await act(async () => void focusCell(outer, 0, 1, 0));
    const cell = activeCellView(outer)!;
    expect(cell).not.toBeNull();
    let ev!: KeyboardEvent;
    await act(async () => {
      ev = pressKey(cell.contentDOM, CTRL_E);
      await Promise.resolve();
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(getMode()).toBe('source'); // 한 번만 바뀌었다(바깥 편집기가 같은 키를 또 받지 않았다)
    expect(activeCellView(outer)).toBeNull();
    expect(shadow.querySelector('.lno-table-wrap')).toBeNull();
    expect(shadow.activeElement).toBe(outer.contentDOM);
    utils.unmount();
  });

  it('in source mode insertTable still inserts raw table text', async () => {
    setMode('source');
    const { view, shadow, utils } = await mountWithTable('본문');
    act(() => void insertTable(view));
    expect(view.state.doc.toString()).toContain('| --- | --- | --- |');
    expect(shadow.querySelector('.lno-table-wrap')).toBeNull();
    utils.unmount();
  });

  it('the path line shows the current mode and follows changes', async () => {
    const { utils } = await mountWithTable();
    const label = () => utils.container.querySelector('.editor-path .editor-mode');
    expect(label()?.getAttribute('role')).toBe('status');
    expect(label()?.textContent).toBe(catalogs.ko['editor.mode.live']);
    act(() => setMode('source'));
    expect(label()?.textContent).toBe(catalogs.ko['editor.mode.source']);
    expect(screen.getByText(catalogs.ko['editor.mode.source'])).toBe(label());
    utils.unmount();
  });

  it('mode labels exist in ko and en', () => {
    expect(catalogs.ko['editor.mode.live']).toBe('라이브 미리보기');
    expect(catalogs.ko['editor.mode.source']).toBe('소스 보기');
    expect(catalogs.en['editor.mode.live']).toBe('Live preview');
    expect(catalogs.en['editor.mode.source']).toBe('Source view');
  });
});
