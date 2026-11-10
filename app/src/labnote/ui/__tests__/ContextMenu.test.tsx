// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setLang } from '../../../i18n/lang';
import type { CommandContext } from '../../commands/context';
import { NoteBusyError } from '../../noteErrors';
import { ContextMenu } from '../ContextMenu';
import { closeMenu, currentMenu, openMenu, type MenuItem } from '../menuStore';

function makeCtx() {
  const notify = vi.fn();
  return { ctx: { host: { notify } } as unknown as CommandContext, notify };
}

function renderMenuHost() {
  const utils = render(
    <>
      <div className="shell">
        <button type="button">trigger</button>
        <button type="button">elsewhere</button>
      </div>
      <ContextMenu />
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'trigger' });
  return { ...utils, trigger };
}

const items = (runs: Array<() => Promise<unknown>>): MenuItem[] => [
  { labelKey: 'dialog.ok', run: runs[0] },
  { label: '비활성', run: runs[1], disabled: true },
  { label: '셋째', run: runs[2] },
  { label: '넷째', run: runs[3] },
];

afterEach(() => {
  act(() => closeMenu());
  vi.restoreAllMocks();
});

describe('맥락 메뉴', () => {
  it('context menu keyboard navigation and Escape restores focus', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMenuHost();
    trigger.focus();
    const runs = [vi.fn(async () => 1), vi.fn(async () => 2), vi.fn(async () => 3), vi.fn(async () => 4)];
    act(() => openMenu(makeCtx().ctx, { x: 10, y: 20 }, items(runs)));

    const menu = screen.getByRole('menu', { name: '메뉴' });
    const entries = screen.getAllByRole('menuitem');
    expect(entries.map((e) => e.textContent)).toEqual(['확인', '비활성', '셋째', '넷째']);
    expect(entries[1].getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(entries[0]); // 첫 항목에 초점

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(entries[2]); // 비활성 항목은 건너뛴다
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(entries[0]); // 끝에서 처음으로
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(entries[3]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(entries[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(entries[3]);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(runs.every((r) => r.mock.calls.length === 0)).toBe(true);
    expect(menu.isConnected).toBe(false);
  });

  it('Enter runs the focused item through runCommand: a rejection becomes a toast, and focus goes back first', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMenuHost();
    trigger.focus();
    const { ctx, notify } = makeCtx();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runs = [vi.fn(async () => 1), vi.fn(), vi.fn(() => Promise.reject(new NoteBusyError('a.md'))), vi.fn()];
    act(() => openMenu(ctx, { x: 0, y: 0 }, items(runs)));
    await user.keyboard('{ArrowDown}{Enter}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(notify).toHaveBeenCalledWith('warn', '노트가 아직 열리는 중이거나 바깥 변경을 확인해야 해서 바꾸지 않았습니다.'));
    expect(runs[2]).toHaveBeenCalledTimes(1);
  });

  it('a click runs the item; a click on a disabled item does nothing', async () => {
    const user = userEvent.setup();
    renderMenuHost();
    const runs = [vi.fn(async () => 1), vi.fn(async () => 2), vi.fn(async () => 3), vi.fn(async () => 4)];
    act(() => openMenu(makeCtx().ctx, { x: 0, y: 0 }, items(runs)));
    fireEvent.click(screen.getByRole('menuitem', { name: '비활성' }));
    expect(runs[1]).not.toHaveBeenCalled();
    expect(currentMenu()).not.toBeNull();
    await user.click(screen.getByRole('menuitem', { name: '넷째' }));
    expect(runs[3]).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on an outside click and on blur, without running anything', async () => {
    const user = userEvent.setup();
    renderMenuHost();
    const runs = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    act(() => openMenu(makeCtx().ctx, { x: 0, y: 0 }, items(runs)));
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('menu')).toBeNull();

    act(() => openMenu(makeCtx().ctx, { x: 0, y: 0 }, items(runs)));
    await user.tab();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(runs.every((r) => r.mock.calls.length === 0)).toBe(true);
  });

  it('labels follow the language at render time', () => {
    renderMenuHost();
    act(() => openMenu(makeCtx().ctx, { x: 0, y: 0 }, items([vi.fn(), vi.fn(), vi.fn(), vi.fn()])));
    expect(screen.getAllByRole('menuitem')[0].textContent).toBe('확인');
    act(() => setLang('en'));
    expect(screen.getAllByRole('menuitem')[0].textContent).toBe('OK');
    expect(screen.getByRole('menu', { name: 'Menu' })).toBeTruthy();
  });

  it('menu has no style attribute: positioning goes through the CSSOM property, clamped to the viewport', () => {
    // 소스에 React style 속성이 없다 (CSP style-src 'self')
    const source = readFileSync('src/labnote/ui/ContextMenu.tsx', 'utf-8');
    expect(source).not.toMatch(/style=/);
    const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { width: 200, height: 100, top: 0, left: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    renderMenuHost();
    act(() => openMenu(makeCtx().ctx, { x: window.innerWidth - 10, y: window.innerHeight - 10 }, items([vi.fn(), vi.fn(), vi.fn(), vi.fn()])));
    const menu = screen.getByRole('menu');
    expect(setProperty).toHaveBeenCalledWith('left', expect.stringMatching(/px$/));
    expect(setProperty).toHaveBeenCalledWith('top', expect.stringMatching(/px$/));
    // 오른쪽 아래 모서리에서 열어도 화면 안에 남는다
    expect(parseFloat(menu.style.left) + 200).toBeLessThanOrEqual(window.innerWidth);
    expect(parseFloat(menu.style.top) + 100).toBeLessThanOrEqual(window.innerHeight);
    rect.mockRestore();
    setProperty.mockRestore();
  });

  it('opens below an element anchor', () => {
    const { trigger } = renderMenuHost();
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(
      { width: 50, height: 20, top: 30, left: 40, right: 90, bottom: 50, x: 40, y: 30, toJSON: () => ({}) } as DOMRect,
    );
    act(() => openMenu(makeCtx().ctx, { element: trigger }, items([vi.fn(), vi.fn(), vi.fn(), vi.fn()])));
    const menu = screen.getByRole('menu');
    expect(menu.style.left).toBe('40px');
    expect(menu.style.top).toBe('50px');
  });

  it('a disabled item shows its reason as a tooltip and runs nothing', () => {
    renderMenuHost();
    const run = vi.fn();
    act(() => openMenu(makeCtx().ctx, { x: 0, y: 0 }, [{ labelKey: 'menu.cut', run, disabled: true, disabledReason: 'menu.needSelection' }, { label: 'b', run: vi.fn() }]));
    const cut = screen.getByRole('menuitem', { name: '잘라내기' });
    expect(cut.getAttribute('aria-disabled')).toBe('true');
    expect(cut.getAttribute('title')).toBe('먼저 글을 선택하세요.');
    fireEvent.click(cut);
    expect(run).not.toHaveBeenCalled();
  });

  it('draws section labels, icons and a shortcut column', () => {
    renderMenuHost();
    act(() =>
      openMenu(makeCtx().ctx, { x: 0, y: 0 }, [
        { labelKey: 'menu.copy', icon: 'copy', shortcut: 'Ctrl+C', run: vi.fn() },
        { label: 'x', section: 'menu.labnote', run: vi.fn() },
      ]),
    );
    const copy = screen.getByRole('menuitem', { name: /복사/ });
    expect(copy.querySelector('svg')).not.toBeNull();
    expect(copy.querySelector('.context-menu-shortcut')?.textContent).toBe('Ctrl+C');
    const section = document.querySelector('.context-menu-section')!;
    expect(section.textContent).toBe('실험 노트');
    expect(section.getAttribute('role')).toBe('presentation');
  });

  it('a submenu opens with ArrowRight and closes with ArrowLeft, focus going in and back', async () => {
    const user = userEvent.setup();
    renderMenuHost();
    const inner = vi.fn(async () => 1);
    act(() =>
      openMenu(makeCtx().ctx, { x: 0, y: 0 }, [
        { label: 'first', run: vi.fn() },
        { labelKey: 'menu.insert', run: async () => undefined, submenu: [{ label: 'inner a', run: inner }, { label: 'inner b', run: vi.fn() }] },
      ]),
    );
    const parent = screen.getByRole('menuitem', { name: /삽입/ });
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'inner a' }));
    await user.keyboard('{ArrowLeft}');
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(document.activeElement).toBe(parent);
    // Enter 도 하위 메뉴를 연다. 안의 항목을 실행하면 메뉴 전체가 닫힌다
    await user.keyboard('{Enter}{Enter}');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('a submenu opens on hover after a short delay and flips left at the right edge', () => {
    vi.useFakeTimers();
    try {
      const setProperty = vi.spyOn(CSSStyleDeclaration.prototype, 'setProperty');
      renderMenuHost();
      act(() =>
        openMenu(makeCtx().ctx, { x: window.innerWidth - 220, y: 0 }, [
          { labelKey: 'menu.insert', run: async () => undefined, submenu: [{ label: 'inner a', run: vi.fn() }] },
        ]),
      );
      const parent = screen.getByRole('menuitem', { name: /삽입/ });
      const rect = (left: number, top: number, width: number, height: number) =>
        ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        if (this === parent) return rect(window.innerWidth - 216, 4, 200, 28);
        if (this.classList.contains('context-submenu')) return rect(0, 0, 180, 60);
        return rect(window.innerWidth - 220, 0, 208, 40);
      });
      fireEvent.mouseEnter(parent);
      expect(screen.getAllByRole('menu')).toHaveLength(1);
      act(() => void vi.advanceTimersByTime(160));
      expect(screen.getAllByRole('menu')).toHaveLength(2);
      const sub = document.querySelector<HTMLElement>('.context-submenu')!;
      // 오른쪽에 자리가 없으면 왼쪽으로 연다: 부모 메뉴의 왼쪽 끝에 붙는다
      expect(parseFloat(sub.style.left) + 180).toBeLessThanOrEqual(window.innerWidth - 220 + 4);
      expect(setProperty).toHaveBeenCalledWith('left', expect.stringMatching(/px$/));
    } finally {
      vi.useRealTimers();
    }
  });

  it('type-ahead moves focus to the next item starting with the typed letter', async () => {
    const user = userEvent.setup();
    renderMenuHost();
    act(() =>
      openMenu(makeCtx().ctx, { x: 0, y: 0 }, [
        { label: 'Alpha', run: vi.fn() },
        { label: 'Bravo', run: vi.fn() },
        { label: 'Beta', run: vi.fn() },
      ]),
    );
    await user.keyboard('b');
    expect(document.activeElement?.textContent).toBe('Bravo');
    await new Promise((r) => setTimeout(r, 600));
    await user.keyboard('b');
    expect(document.activeElement?.textContent).toBe('Beta');
  });

  it('opened by a pointer, the menu itself takes focus and ArrowDown goes to the first item', async () => {
    const user = userEvent.setup();
    const { trigger } = renderMenuHost();
    const open = (e: Event) => openMenu(makeCtx().ctx, { x: 30, y: 40 }, items([vi.fn(), vi.fn(), vi.fn(), vi.fn()]), e);
    trigger.addEventListener('contextmenu', open);
    act(() => void trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 40 })));
    expect(document.activeElement).toBe(screen.getByRole('menu'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    act(() => closeMenu());
    // 키보드로 띄운 contextmenu(좌표 0, 0)는 첫 항목에 초점
    act(() => void trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 0, clientY: 0 })));
    expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    trigger.removeEventListener('contextmenu', open);
  });
});
