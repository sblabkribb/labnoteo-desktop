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
const rightTabs = () => within(screen.getByRole('tablist', { name: '오른쪽 사이드바 보기' }));
const vaultShown = () => screen.findByText('fake-vault', { selector: '.vault-bar-name' });

async function runFromPalette(user: ReturnType<typeof userEvent.setup>, name: string) {
  const button = within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '명령 팔레트' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await user.click(button);
  await user.type(within(await screen.findByRole('dialog', { name: '명령' })).getByRole('combobox'), name);
  await act(async () => {
    await user.keyboard('{Enter}');
  });
}

describe('사이드바 탭', () => {
  it('the Experiments tab is the default for a vault with labnote/ and no stored choice', async () => {
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    render(<App />);
    await vaultShown();
    await waitFor(() => expect(tabs().getByRole('tab', { name: '실험' }).getAttribute('aria-selected')).toBe('true'));
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('false');
    expect(await screen.findByRole('treeitem', { name: /형광 단백질/ })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: '노트' })).toBeNull();
  });

  it('a vault with labnote/ whose tab was chosen before keeps that tab', async () => {
    localStorage.setItem('labnoteo-sidebar-tab:C:/fake-vault', 'files');
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    render(<App />);
    await vaultShown();
    expect(await screen.findByRole('navigation', { name: '노트' })).toBeTruthy();
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a vault without labnote/ opens on Files; the chosen tab is remembered', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    const first = render(<App />);
    await vaultShown();
    expect(await screen.findByRole('navigation', { name: '노트' })).toBeTruthy();
    expect(tabs().getByRole('tab', { name: '파일' }).getAttribute('aria-selected')).toBe('true');

    await user.click(tabs().getByRole('tab', { name: '실험' }));
    expect(await screen.findByRole('tree', { name: '실험 목록' })).toBeTruthy();
    first.unmount();

    render(<App />);
    await vaultShown();
    await waitFor(() => expect(tabs().getByRole('tab', { name: '실험' }).getAttribute('aria-selected')).toBe('true'));
  });

  it("the palette's 'Open workflow view' switches to the Experiments tab and shows a hidden dock", async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await vaultShown();
    await user.click(within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '왼쪽 사이드바 보이기/숨기기' }));
    expect(document.documentElement.getAttribute('data-left-hidden')).toBe('true');
    await runFromPalette(user, 'Workflow 뷰 열기');
    await waitFor(() => expect(tabs().getByRole('tab', { name: '실험' }).getAttribute('aria-selected')).toBe('true'));
    expect(document.documentElement.getAttribute('data-left-hidden')).toBe('false');
  });

  it('arrow keys, Home and End move the selection and focus between the three tabs', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    render(<App />);
    await vaultShown();
    const files = () => tabs().getByRole('tab', { name: '파일' });
    const experiments = () => tabs().getByRole('tab', { name: '실험' });
    const samples = () => tabs().getByRole('tab', { name: '샘플' });
    await waitFor(() => expect(experiments().getAttribute('aria-selected')).toBe('true'));

    experiments().focus();
    await user.keyboard('{ArrowLeft}');
    expect(files().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(files());
    expect(await screen.findByRole('navigation', { name: '노트' })).toBeTruthy();

    await user.keyboard('{ArrowLeft}');
    expect(samples().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(samples());

    await user.keyboard('{Home}');
    expect(files().getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{End}');
    expect(samples().getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(files().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(files());
  });

  it('the samples tab shows the samples panel and is restored', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    const first = render(<App />);
    await vaultShown();
    expect(tabs().getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['파일', '실험', '샘플']);
    const samplesTab = () => tabs().getByRole('tab', { name: '샘플' });
    await user.click(samplesTab());
    expect(samplesTab().getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: '샘플' })).toBeTruthy();
    expect(await screen.findByText(t('samples.root.global'))).toBeTruthy();
    first.unmount();

    render(<App />);
    await vaultShown();
    await waitFor(() => expect(samplesTab().getAttribute('aria-selected')).toBe('true'));
  });

  it('Outline and Links live in the right sidebar: closed by default, the ribbon opens it, arrows switch and it is remembered', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'labnote/001_GFP/README.labnote.md': README });
    const first = render(<App />);
    await vaultShown();
    expect(screen.queryByRole('complementary', { name: '오른쪽 사이드바' })).toBeNull();
    await user.click(within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '오른쪽 사이드바 보이기/숨기기' }));
    const outline = () => rightTabs().getByRole('tab', { name: t('sidebar.outline') });
    const links = () => rightTabs().getByRole('tab', { name: t('sidebar.tab.links') });
    expect(outline().getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: t('sidebar.outline') })).toBeTruthy();
    expect(screen.getByText(t('outline.empty'))).toBeTruthy();
    outline().focus();
    await user.keyboard('{ArrowRight}');
    expect(links().getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(links());
    expect(screen.getByRole('tabpanel', { name: t('sidebar.tab.links') })).toBeTruthy();
    first.unmount();

    render(<App />);
    await vaultShown();
    await waitFor(() => expect(links().getAttribute('aria-selected')).toBe('true'));
  });

  it('links-show opens the right sidebar on links', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await vaultShown();
    await runFromPalette(user, t('cmd.linksShow'));
    await waitFor(() => expect(rightTabs().getByRole('tab', { name: t('sidebar.tab.links') }).getAttribute('aria-selected')).toBe('true'));
  });

  it('outline-show opens the right sidebar on outline', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': 'x' });
    render(<App />);
    await vaultShown();
    await runFromPalette(user, t('cmd.outlineShow'));
    await waitFor(() => expect(rightTabs().getByRole('tab', { name: t('sidebar.outline') }).getAttribute('aria-selected')).toBe('true'));
  });

  it('the Outline in the right sidebar follows the open note', async () => {
    const user = userEvent.setup();
    installFakeVault({ 'A.labnote.md': '# Alpha heading\nx\n', 'B.labnote.md': '# Beta heading\ny\n' });
    render(<App />);
    await vaultShown();
    await user.click(within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '오른쪽 사이드바 보이기/숨기기' }));
    const right = () => within(screen.getByRole('complementary', { name: '오른쪽 사이드바' }));
    await user.click(await screen.findByRole('treeitem', { name: 'A' }));
    expect(await right().findByRole('treeitem', { name: /Alpha heading/ })).toBeTruthy();
    await user.click(screen.getByRole('treeitem', { name: 'B' }));
    expect(await right().findByRole('treeitem', { name: /Beta heading/ })).toBeTruthy();
    expect(right().queryByRole('treeitem', { name: /Alpha heading/ })).toBeNull();
  });

  it("clicking an outline heading moves the open note's cursor to that heading line", async () => {
    const user = userEvent.setup();
    installFakeVault({ 'Day 1.labnote.md': '# Top\nx\ny\n## Deep\nz\n' });
    render(<App />);
    await vaultShown();
    await user.click(await screen.findByRole('treeitem', { name: 'Day 1' }));
    await user.click(within(screen.getByRole('toolbar', { name: '리본' })).getByRole('button', { name: '오른쪽 사이드바 보이기/숨기기' }));
    await user.click(await screen.findByRole('treeitem', { name: /Deep/ }));
    const root = (document.querySelector('.editor-frame') as HTMLElement).shadowRoot!;
    const view = EditorView.findFromDOM(root.querySelector('.cm-editor') as HTMLElement)!;
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4);
  });
});
