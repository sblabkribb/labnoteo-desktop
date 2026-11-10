// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
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

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => {};
});
afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const FILES = {
  'Plan.md': '# Plan',
  'data/gel.png': 'PNG',
  'data/plate.csv': 'a,b\n1,2',
  'data/spec.pdf': '%PDF',
  'resources/labsamples/DNA.json': '{}',
  'resources/workflows/catalog.json': '{}',
};

describe('Files tab (UI redesign Task 9)', () => {
  it('lists attachments, hides system files until the toggle, and opens a png in the image viewer without reading it as text', async () => {
    const user = userEvent.setup();
    const fake = installFakeVault(FILES);
    render(<App />);
    const tree = await screen.findByRole('tree', { name: '노트' });
    await within(tree).findByRole('treeitem', { name: 'gel.png' });
    expect(within(tree).getByRole('treeitem', { name: 'plate.csv' })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: 'Plan' })).toBeTruthy();
    expect(within(tree).queryByRole('treeitem', { name: 'labsamples' })).toBeNull();
    expect(within(tree).queryByRole('treeitem', { name: 'workflows' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '시스템 파일 표시' }));
    expect(screen.getByRole('button', { name: '시스템 파일 표시' }).getAttribute('aria-pressed')).toBe('true');
    expect(await within(tree).findByRole('treeitem', { name: 'labsamples' })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: 'workflows' })).toBeTruthy();

    await user.click(within(tree).getByRole('treeitem', { name: 'gel.png' }));
    const img = await screen.findByRole('img', { name: 'gel.png' });
    expect(img.closest('.image-viewer')).not.toBeNull();
    expect(within(tree).getByRole('treeitem', { name: 'gel.png' }).getAttribute('aria-current')).toBe('true');
    expect(fake.log.filter((c) => c.cmd === 'vault_read' && c.args.path === 'data/gel.png')).toEqual([]);
    expect(fake.log.filter((c) => c.cmd === 'vault_read_image').map((c) => c.args.path)).toEqual(['data/gel.png']);

    // a csv is a table, a pdf is a file card
    await user.click(within(tree).getByRole('treeitem', { name: 'plate.csv' }));
    expect(await screen.findByRole('columnheader', { name: 'a' })).toBeTruthy();
    expect(screen.getByText('1행 × 2열')).toBeTruthy();
    await user.click(within(tree).getByRole('treeitem', { name: 'spec.pdf' }));
    const card = await screen.findByRole('article', { name: '파일' });
    expect(within(card).getByRole('heading', { name: 'spec.pdf' })).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: '폴더에서 보기' }));
    expect(fake.log.filter((c) => c.cmd === 'vault_reveal').map((c) => c.args.path)).toEqual(['data/spec.pdf']);

    // a note brings the editor back and the card goes
    await user.click(within(tree).getByRole('treeitem', { name: 'Plan' }));
    await waitFor(() => expect(document.querySelector('section.editor-view[data-path="Plan.md"]')).not.toBeNull());
    expect(screen.queryByRole('article', { name: '파일' })).toBeNull();
  });

  it('collapse all folds every folder', async () => {
    const user = userEvent.setup();
    installFakeVault(FILES);
    render(<App />);
    const tree = await screen.findByRole('tree', { name: '노트' });
    await within(tree).findByRole('treeitem', { name: 'gel.png' });
    await user.click(screen.getByRole('button', { name: '모두 접기' }));
    expect(within(tree).queryByRole('treeitem', { name: 'gel.png' })).toBeNull();
    expect(within(tree).getByRole('treeitem', { name: 'data' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('Ctrl+click on [[plate.csv]] in live preview opens the CSV viewer', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'exp/n.md': 'see [[plate.csv]]\nx', 'exp/resources/plate.csv': 'well,od\nA1,0.5\n' });
    render(<App />);
    const tree = await screen.findByRole('tree', { name: '노트' });
    await user.click(await within(tree).findByRole('treeitem', { name: 'n' }));
    let view: EditorView | undefined;
    await waitFor(() => {
      const root = (document.querySelector('.editor-frame') as HTMLElement | null)?.shadowRoot;
      const el = root?.querySelector('.cm-editor') as HTMLElement | null;
      view = el ? (EditorView.findFromDOM(el) ?? undefined) : undefined;
      expect(view?.state.doc.toString()).toBe('see [[plate.csv]]\nx');
    });
    await waitFor(() => expect(linkIndex.ready()).toBe(true));
    view!.dispatch({ selection: { anchor: view!.state.doc.length } });
    const link = await waitFor(() => {
      const found = view!.contentDOM.querySelector('.lno-wikilink');
      expect(found).toBeTruthy();
      return found!;
    });
    fireEvent.mouseDown(link, { button: 0, ctrlKey: true });
    expect(await screen.findByRole('columnheader', { name: 'well' })).toBeTruthy();
    expect(document.querySelector('section.file-view[data-path="exp/resources/plate.csv"]')).not.toBeNull();
  });
});
