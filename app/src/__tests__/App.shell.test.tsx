// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../App';
import { clearToasts } from '../labnote/host/toastStore';
import { DEFAULT_PREFS, layoutStore } from '../ui/layoutStore';
import { getLang, setLang } from '../i18n/lang';
import { installFakeVault, type FakeVault } from './fakeVault';

vi.mock('@tauri-apps/api/core', async () => (await import('./fakeVault')).mockTauri().core);
vi.mock('@tauri-apps/api/event', async () => (await import('./fakeVault')).mockTauri().event);
vi.mock('@tauri-apps/api/window', async () => (await import('./fakeVault')).mockTauri().window);
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: async () => {} }));

// jsdom 에는 PointerEvent 가 없다: clientX 와 pointerId 를 가진 MouseEvent 로 채운다.
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
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

const html = () => document.documentElement;

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  if (typeof window.PointerEvent === 'undefined') vi.stubGlobal('PointerEvent', PointerEventPolyfill);
  layoutStore.update({ ...DEFAULT_PREFS });
});
afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
  setLang('ko');
  html().removeAttribute('data-theme');
});

async function openVault(files: Record<string, string> = { 'Day 1.labnote.md': 'x' }): Promise<FakeVault> {
  const vault = installFakeVault(files);
  render(<App />);
  await screen.findByText('fake-vault');
  return vault;
}

const ribbon = () => within(screen.getByRole('toolbar', { name: '리본' }));

async function runFromPalette(user: ReturnType<typeof userEvent.setup>, name: string) {
  const button = screen.getAllByRole('button', { name: /^(명령 팔레트|Command palette)$/ })[0] as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await user.click(button);
  await user.type(within(await screen.findByRole('dialog')).getByRole('combobox'), name);
  await act(async () => {
    await user.keyboard('{Enter}');
  });
}

function ctrlBackslash(key: string, extra: Partial<KeyboardEventInit> = {}) {
  const e = new KeyboardEvent('keydown', { key, code: 'Backslash', ctrlKey: true, bubbles: true, cancelable: true, ...extra });
  act(() => void document.body.dispatchEvent(e));
  return e;
}

describe('셸: 리본, 왼쪽 독, 보관함 줄 (상단 바 없음)', () => {
  it('there is no top bar; the ribbon, the dock and the vault bar are there', async () => {
    await openVault();
    expect(document.querySelector('.topbar')).toBeNull();
    expect(screen.queryByRole('banner')).toBeNull();
    expect(ribbon().getAllByRole('button')).toHaveLength(7);
    const dock = screen.getByRole('complementary', { name: '사이드바' });
    expect(within(dock).getByRole('group', { name: '보관함' })).toBeTruthy();
    expect(within(dock).getByText('fake-vault')).toBeTruthy();
    // 테마·언어 고르기는 창 틀에서 빠졌다(팔레트 명령으로 간다)
    expect(document.querySelectorAll('.shell select')).toHaveLength(0);
  });

  it('the dock tabs are an icon tablist of Files, Experiments and Samples; Outline and Links are not in it', async () => {
    await openVault();
    const list = screen.getByRole('tablist', { name: '사이드바 보기' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual(['파일', '실험', '샘플']);
    expect(tabs.map((tab) => tab.title)).toEqual(['파일', '실험', '샘플']);
    for (const tab of tabs) expect(tab.textContent).toBe('');
    expect(within(list).queryByRole('tab', { name: '개요' })).toBeNull();
    expect(within(list).queryByRole('tab', { name: '링크' })).toBeNull();
  });

  it('Ctrl+\\ toggles data-left-hidden, also when the key is ₩ on a Korean layout; Ctrl+Shift+\\ does not', async () => {
    await openVault();
    expect(html().getAttribute('data-left-hidden')).toBe('false');
    expect(ctrlBackslash('\\').defaultPrevented).toBe(true);
    expect(html().getAttribute('data-left-hidden')).toBe('true');
    expect(ribbon().getByRole('button', { name: '왼쪽 사이드바 보이기/숨기기' }).getAttribute('aria-expanded')).toBe('false');
    ctrlBackslash('₩');
    expect(html().getAttribute('data-left-hidden')).toBe('false');
    ctrlBackslash('|', { shiftKey: true });
    expect(html().getAttribute('data-left-hidden')).toBe('false');
    // 같은 글자라도 code 가 다른 키는 아니다
    act(() => void document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'IntlBackslash', ctrlKey: true, bubbles: true })));
    expect(html().getAttribute('data-left-hidden')).toBe('false');
    // 리본 단추도 같다
    await userEvent.setup().click(ribbon().getByRole('button', { name: '왼쪽 사이드바 보이기/숨기기' }));
    expect(html().getAttribute('data-left-hidden')).toBe('true');
    expect(layoutStore.get().leftHidden).toBe(true);
  });

  it('dragging the dock edge from 272 to 400 sets --side-w through setProperty; a drag to 120 hides the dock', async () => {
    await openVault();
    const spy = vi.spyOn(html().style, 'setProperty');
    const sep = screen.getByRole('separator', { name: '사이드바 너비' });
    fireEvent.pointerDown(sep, { clientX: 272, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 400, pointerId: 1 });
    expect(spy).toHaveBeenCalledWith('--side-w', '400px');
    expect(html().style.getPropertyValue('--side-w')).toBe('400px');
    expect(layoutStore.get().leftWidth).toBe(400);

    fireEvent.pointerDown(sep, { clientX: 400, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep, { clientX: 120, pointerId: 1 });
    fireEvent.pointerUp(sep, { clientX: 120, pointerId: 1 });
    expect(html().getAttribute('data-left-hidden')).toBe('true');
    expect(layoutStore.get().leftWidth).toBe(400); // 숨겨도 너비는 남아 다시 열면 그 너비다
    spy.mockRestore();
  });

  it('arrow keys on the dock edge move it by 16px', async () => {
    await openVault();
    const sep = screen.getByRole('separator', { name: '사이드바 너비' });
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(html().style.getPropertyValue('--side-w')).toBe('288px');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(html().style.getPropertyValue('--side-w')).toBe('256px');
  });

  it('Ctrl+N opens the new-note dialog and Esc closes it', async () => {
    const user = userEvent.setup();
    await openVault();
    const e = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => void document.body.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    const dialog = await screen.findByRole('dialog', { name: '새 노트' });
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: '노트 이름' })));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the new-note dialog creates the note and opens it', async () => {
    const user = userEvent.setup();
    const vault = await openVault();
    await user.click(ribbon().getByRole('button', { name: '새 노트' }));
    await user.type(within(await screen.findByRole('dialog', { name: '새 노트' })).getByRole('textbox', { name: '노트 이름' }), 'Day 2{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(vault.files()['Day 2.labnote.md']).toBe(''));
    await waitFor(() => expect(vault.log.some((c) => c.cmd === 'vault_read' && c.args.path === 'Day 2.labnote.md')).toBe(true));
  });

  it('the window title names the vault', async () => {
    const vault = await openVault();
    await waitFor(() => expect(vault.window.title).toBe('labnoteO — fake-vault'));
  });

  it("the vault bar's menu shows Switch vault, which goes back to the vault picker", async () => {
    const user = userEvent.setup();
    await openVault();
    const menuButton = screen.getByRole('button', { name: '보관함 메뉴' });
    expect(menuButton.getAttribute('aria-haspopup')).toBe('menu');
    await waitFor(() => expect(document.querySelector('.ribbon button:disabled')).toBeNull());
    await user.click(menuButton);
    const item = await screen.findByRole('menuitem', { name: '보관함 바꾸기' });
    await user.click(item);
    expect(await screen.findByText('노트를 둘 곳을 정하세요')).toBeTruthy();
  });

  it('theme and language are palette commands', async () => {
    const user = userEvent.setup();
    await openVault();
    await runFromPalette(user, '테마: 어둡게');
    await waitFor(() => expect(html().getAttribute('data-theme')).toBe('dark'));
    await runFromPalette(user, '언어: English');
    await waitFor(() => expect(getLang()).toBe('en'));
    expect(screen.getByRole('toolbar', { name: 'Ribbon' })).toBeTruthy();
  });

  it('outline-show opens the right sidebar on the Outline tab', async () => {
    const user = userEvent.setup();
    await openVault();
    expect(screen.queryByRole('complementary', { name: '오른쪽 사이드바' })).toBeNull();
    await runFromPalette(user, '개요 보기');
    const right = await screen.findByRole('complementary', { name: '오른쪽 사이드바' });
    expect(within(right).getByRole('tab', { name: '개요' }).getAttribute('aria-selected')).toBe('true');
    expect(html().getAttribute('data-right-open')).toBe('true');
  });
});
