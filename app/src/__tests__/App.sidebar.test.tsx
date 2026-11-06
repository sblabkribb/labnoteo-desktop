// @vitest-environment jsdom
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import { App } from '../App';
import { t } from '../i18n/t';
import { clearToasts } from '../labnote/host/toastStore';
import { installFakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

// 개요에서 제목을 고르면 편집기에 초점이 간다. jsdom 에 없는 API 를 Editor.test.tsx 처럼 채운다.
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

const README = [
  '---',
  'title: 형광 단백질',
  'status: in-progress',
  '---',
  '',
  '## 🗂️ Related Workflows',
  '',
  '## Summary and Discussion',
  '',
].join('\n');

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const tabs = () => within(screen.getByRole('tablist', { name: '사이드바 보기' }));

describe('사이드바 탭', () => {
  it('the Workflows tab is the default for a vault with labnote/ and no stored choice', async () => {
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await waitFor(() => expect(tabs().getByRole('tab', { name: '워크플로' }).getAttribute('aria-selected')).toBe('true'));
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('false');
    expect(await screen.findByRole('treeitem', { name: /형광 단백질/ })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '노트' })).toBeNull();
  });

  it('a vault without labnote/ opens on Files; the chosen tab is kept per vault', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    const first = render(<App />);
    await screen.findByText('보관함: fake-vault');
    expect(await screen.findByRole('navigation', { name: '노트' })).toBeTruthy();
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('true');

    await user.click(tabs().getByRole('tab', { name: '워크플로' }));
    expect(await screen.findByRole('tree', { name: '실험 목록' })).toBeTruthy();
    first.unmount();

    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await waitFor(() => expect(tabs().getByRole('tab', { name: '워크플로' }).getAttribute('aria-selected')).toBe('true'));
  });

  it("the palette's 'Open workflow view' switches to the Workflows tab", async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    const button = within(screen.getByRole('banner')).getByRole('button', { name: '명령 팔레트 (Ctrl+P)' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await user.type(within(await screen.findByRole('dialog', { name: '명령' })).getByRole('combobox'), '워크플로 뷰 열기');
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(tabs().getByRole('tab', { name: '워크플로' }).getAttribute('aria-selected')).toBe('true'));
  });
  it('arrow keys, Home and End move the selection and focus between tabs', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    const files = () => tabs().getByRole('tab', { name: '파일' });
    const workflows = () => tabs().getByRole('tab', { name: '워크플로' });
    const outline = () => tabs().getByRole('tab', { name: t('sidebar.outline') });
    const links = () => tabs().getByRole('tab', { name: t('sidebar.tab.links') });
    await waitFor(() => expect(workflows().getAttribute('aria-selected')).toBe('true'));

    workflows().focus();
    await user.keyboard('{ArrowLeft}');
    expect(files().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(files());
    expect(await screen.findByRole('navigation', { name: '노트' })).toBeTruthy();

    await user.keyboard('{ArrowLeft}');
    expect(links().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(links());

    await user.keyboard('{ArrowLeft}');
    expect(outline().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(outline());

    await user.keyboard('{Home}');
    expect(files().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(files());

    await user.keyboard('{End}');
    expect(links().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(links());

    await user.keyboard('{ArrowRight}');
    expect(files().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(files());
  });

  it('the Outline tab is reachable with ArrowRight and remembered per vault', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    const first = render(<App />);
    await screen.findByText('보관함: fake-vault');
    const workflows = () => tabs().getByRole('tab', { name: '워크플로' });
    const outline = () => tabs().getByRole('tab', { name: t('sidebar.outline') });
    await waitFor(() => expect(workflows().getAttribute('aria-selected')).toBe('true'));
    workflows().focus();
    await user.keyboard('{ArrowRight}');
    expect(outline().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(outline());
    expect(screen.getByRole('tabpanel', { name: t('sidebar.outline') })).toBeTruthy();
    expect(screen.getByText(t('outline.empty'))).toBeTruthy();
    first.unmount();

    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await waitFor(() => expect(outline().getAttribute('aria-selected')).toBe('true'));
  });

  it('the Links tab is reachable with ArrowRight and remembered per vault', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    const first = render(<App />);
    await screen.findByText('보관함: fake-vault');
    const outline = () => tabs().getByRole('tab', { name: t('sidebar.outline') });
    const links = () => tabs().getByRole('tab', { name: t('sidebar.tab.links') });
    outline().click();
    outline().focus();
    await user.keyboard('{ArrowRight}');
    expect(links().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(links());
    expect(screen.getByRole('tabpanel', { name: t('sidebar.tab.links') })).toBeTruthy();
    first.unmount();

    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await waitFor(() => expect(links().getAttribute('aria-selected')).toBe('true'));
  });

  it('links-show switches the sidebar to links', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    const button = within(screen.getByRole('banner')).getByRole('button', { name: '명령 팔레트 (Ctrl+P)' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await user.type(within(await screen.findByRole('dialog', { name: '명령' })).getByRole('combobox'), t('cmd.linksShow'));
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(tabs().getByRole('tab', { name: t('sidebar.tab.links') }).getAttribute('aria-selected')).toBe('true'));
  });

  it('outline-show switches the sidebar to outline', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    const button = within(screen.getByRole('banner')).getByRole('button', { name: '명령 팔레트 (Ctrl+P)' }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    await user.click(button);
    await user.type(within(await screen.findByRole('dialog', { name: '명령' })).getByRole('combobox'), t('cmd.outlineShow'));
    await act(async () => {
      await user.keyboard('{Enter}');
    });
    await waitFor(() => expect(tabs().getByRole('tab', { name: t('sidebar.outline') }).getAttribute('aria-selected')).toBe('true'));
  });

  it("clicking an outline heading moves the open note's cursor to that heading line", async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': '# Top\nx\ny\n## Deep\nz\n' });
    render(<App />);
    await screen.findByText('보관함: fake-vault');
    await user.click(await screen.findByText('Day 1.labnote.md'));
    await user.click(tabs().getByRole('tab', { name: t('sidebar.outline') }));
    await user.click(await screen.findByRole('treeitem', { name: /Deep/ }));
    const root = (document.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
    const view = EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
  });
});
