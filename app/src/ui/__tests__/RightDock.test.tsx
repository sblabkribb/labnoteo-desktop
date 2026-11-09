// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { setLang } from '../../i18n/lang';
import { DEFAULT_PREFS, layoutStore, RIGHT_RANGE, WRITE_DEBOUNCE_MS } from '../layoutStore';
import { RightDock } from '../RightDock';

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, args?: { prefs?: unknown }) => args?.prefs ?? null));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

// jsdom 에는 PointerEvent 가 없다: clientX 와 pointerId 를 가진 MouseEvent 로 채운다.
class PointerEventPolyfill extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') vi.stubGlobal('PointerEvent', PointerEventPolyfill);
});

const html = () => document.documentElement;

beforeEach(() => {
  layoutStore.resetForTest();
  invoke.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  setLang('ko');
});

function renderDock() {
  return render(<RightDock outline={<p>OUTLINE BODY</p>} links={<p>LINKS BODY</p>} />);
}
const aside = () => screen.getByRole('complementary', { name: '오른쪽 사이드바' });
const sep = () => screen.getByRole('separator', { name: '오른쪽 사이드바 너비' });

describe('RightDock', () => {
  it('is closed by default: nothing is rendered', () => {
    expect(DEFAULT_PREFS.rightOpen).toBe(false);
    renderDock();
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByText('OUTLINE BODY')).toBeNull();
  });

  it('opens with toggleRight on the Outline tab, with an icon header, and closes again', () => {
    renderDock();
    act(() => layoutStore.toggleRight());
    expect(aside().id).toBe('right-dock');
    const tabs = within(within(aside()).getByRole('tablist', { name: '오른쪽 사이드바 보기' })).getAllByRole('tab');
    expect(tabs.map((x) => x.getAttribute('aria-label'))).toEqual(['개요', '링크']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    // 패널 머리: Lucide 아이콘(장식) + 이름
    const head = within(aside()).getByRole('heading', { name: '개요' });
    expect(head.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('tabpanel', { name: '개요' }).textContent).toContain('OUTLINE BODY');
    expect(aside().querySelectorAll('[style]')).toHaveLength(0);
    fireEvent.click(tabs[1]);
    expect(within(aside()).getByRole('heading', { name: '링크' })).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: '링크' }).textContent).toContain('LINKS BODY');
    act(() => layoutStore.toggleRight());
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('its left edge resizes it (dragging left widens) within 220..480, and a drag below 140 closes it', () => {
    renderDock();
    act(() => layoutStore.update({ rightOpen: true }));
    expect(sep().getAttribute('aria-valuemin')).toBe(String(RIGHT_RANGE.min));
    expect(sep().getAttribute('aria-valuemax')).toBe(String(RIGHT_RANGE.max));
    const spy = vi.spyOn(html().style, 'setProperty');
    fireEvent.pointerDown(sep(), { clientX: 1000, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep(), { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: 900, pointerId: 1 });
    expect(spy).toHaveBeenCalledWith('--right-w', '380px');
    expect(layoutStore.get().rightWidth).toBe(380);
    // 넘치면 480 에서 멈춘다
    fireEvent.pointerDown(sep(), { clientX: 900, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep(), { clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: 500, pointerId: 1 });
    expect(layoutStore.get().rightWidth).toBe(480);
    // 화살표: ← 는 넓히고 → 는 좁힌다(왼쪽 가장자리)
    fireEvent.keyDown(sep(), { key: 'ArrowRight' });
    expect(html().style.getPropertyValue('--right-w')).toBe('464px');
    // 140 아래로 끌면 닫는다(너비는 남는다)
    fireEvent.pointerDown(sep(), { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(sep(), { clientX: 900, pointerId: 1 });
    fireEvent.pointerUp(sep(), { clientX: 900, pointerId: 1 });
    expect(layoutStore.get().rightOpen).toBe(false);
    expect(layoutStore.get().rightWidth).toBe(464);
    expect(screen.queryByRole('complementary')).toBeNull();
    spy.mockRestore();
  });

  it('open state, width and tab are written to the Rust settings store (ui_prefs_write)', () => {
    vi.useFakeTimers();
    renderDock();
    act(() => layoutStore.toggleRight());
    fireEvent.click(within(aside()).getByRole('tab', { name: '링크' }));
    fireEvent.keyDown(sep(), { key: 'ArrowLeft' });
    expect(invoke).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(WRITE_DEBOUNCE_MS));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('ui_prefs_write', {
      prefs: expect.objectContaining({ rightOpen: true, rightTab: 'links', rightWidth: RIGHT_RANGE.default + 16 }),
    });
  });

  it('names follow the language', () => {
    setLang('en');
    renderDock();
    act(() => layoutStore.update({ rightOpen: true }));
    expect(screen.getByRole('complementary', { name: 'Right sidebar' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Right sidebar width' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Outline' })).toBeTruthy();
  });
});
