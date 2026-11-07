// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { App } from '../App';
import { linkIndex } from '../links/linkIndex';
import { clearToasts } from '../labnote/host/toastStore';
import { installFakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

// 열기는 커서를 옮기고 초점을 준다. jsdom 에 없는 API 를 App.sidebar.test.tsx 처럼 채운다.
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

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

/** 지금 편집기의 뷰. App.sidebar.test.tsx 의 "clicking an outline heading…" 과 같은 찾기. */
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

const docIs = (text: string) => waitFor(async () => expect((await editorView()).state.doc.toString()).toBe(text));

describe('navigation history', () => {
  it('a link followed by back reopens the source note at its caret line', async () => {
    installFakeVault({ 'n.md': 'a\nb\n[[Home]]', 'Home.md': '# H' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await userEvent.click(await screen.findByText('n.md'));
    await docIs('a\nb\n[[Home]]');
    const v = await editorView();
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    v.dispatch({ selection: { anchor: v.state.doc.line(3).from + 3 } });
    expect(runScopeHandlers(v, new KeyboardEvent('keydown', { key: 'Enter', altKey: true }), 'editor')).toBe(true);
    await docIs('# H');
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    await docIs('a\nb\n[[Home]]');
    const back = await editorView();
    await waitFor(() => expect(back.state.doc.lineAt(back.state.selection.main.head).number - 1).toBe(2));
    fireEvent.mouseUp(window, { button: 4 });
    await docIs('# H');
    fireEvent.mouseUp(window, { button: 3 });
    await docIs('a\nb\n[[Home]]');
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    await docIs('# H');
  });

  it('a tree open is history too, and a note the watcher reports removed is skipped by back', async () => {
    const vault = installFakeVault({ 'a.md': 'A', 'b.md': 'B', 'c.md': 'C' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await userEvent.click(await screen.findByText('a.md'));
    await docIs('A');
    await userEvent.click(await screen.findByText('b.md'));
    await docIs('B');
    await userEvent.click(await screen.findByText('c.md'));
    await docIs('C');
    await vault.emitChange('b.md', 'removed');
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    await docIs('A');
  });

  it('the mousedown of the back and forward buttons is prevented, other buttons are not', async () => {
    installFakeVault({});
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    const nav = new MouseEvent('mousedown', { button: 3, cancelable: true, bubbles: true });
    window.dispatchEvent(nav);
    expect(nav.defaultPrevented).toBe(true);
    const plain = new MouseEvent('mousedown', { button: 0, cancelable: true, bubbles: true });
    window.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
  });
});
