// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { setLang } from '../../i18n/lang';
import { createLayoutStore, PET_DEFAULT, type UiPrefs } from '../../ui/layoutStore';
import { PetLayer } from '../PetLayer';
import { createPetStore } from '../petStore';

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

const size = { w: window.innerWidth, h: window.innerHeight };
function setViewport(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
}

function setup() {
  const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
  const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
  const store = createPetStore({ layout });
  render(<PetLayer store={store} />);
  return { layout, store };
}

const pet = () => document.querySelector<HTMLButtonElement>('button.pet')!;
const wrap = () => pet().closest('.pet-wrap') as HTMLElement;
const px = (n: number) => String(n) + 'px';

// jsdom 25 has no PointerEvent: fireEvent.pointer* would then send a plain Event without clientX/pointerId.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  vi.stubGlobal('PointerEvent', PointerEventPolyfill);
}

beforeEach(() => setViewport(1024, 768));
afterEach(() => {
  cleanup();
  setViewport(size.w, size.h);
  setLang('ko');
});

describe('PetLayer', () => {
  it('is a named button that says it opens a dialog; the sprite is decorative and carries the state and skin variables', () => {
    setup();
    const b = pet();
    expect(b.getAttribute('aria-haspopup')).toBe('dialog');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+Y');
    const sprite = b.querySelector('.pet-sprite') as HTMLElement;
    expect(sprite.getAttribute('aria-hidden')).toBe('true');
    expect(sprite.getAttribute('data-state')).toBe('idle');
    expect(sprite.style.getPropertyValue('--pet-sheet')).toBe('url("/skins/flasko/idle.png")');
    expect(sprite.style.getPropertyValue('--pet-frames')).toBe('4');
    expect(wrap().style.getPropertyValue('--pet-x')).toBe('24px');
    expect(wrap().style.getPropertyValue('--pet-y')).toBe('40px');
    expect(wrap().style.getPropertyValue('--pet-scale')).toBe('2');
  });

  it('follows the language', () => {
    setLang('en');
    setup();
    expect(screen.getByRole('button', { name: 'Open assistant' })).toBeTruthy();
    fireEvent.click(pet());
    expect(screen.getByRole('button', { name: 'Close assistant' })).toBe(pet());
  });

  it('the state attribute follows the store', () => {
    const { store } = setup();
    act(() => store.setState('think'));
    const sprite = pet().querySelector('.pet-sprite') as HTMLElement;
    expect(sprite.getAttribute('data-state')).toBe('think');
    expect(sprite.style.getPropertyValue('--pet-sheet')).toBe('url("/skins/flasko/think.png")');
  });

  it('a click toggles the bubble: a non-modal dialog named by its heading, with a greeting and close', () => {
    setup();
    fireEvent.click(pet());
    const dialog = screen.getByRole('dialog', { name: '어시스턴트' });
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    expect(dialog.textContent).toContain('무엇을 도와드릴까요?');
    expect(pet().getAttribute('aria-expanded')).toBe('true');
    expect(pet().getAttribute('aria-controls')).toBe(dialog.id);
    // the name says what a press does now: close while the bubble is open (review)
    expect(screen.getByRole('button', { name: '어시스턴트 닫기' })).toBe(pet());
    fireEvent.click(pet());
    expect(screen.getByRole('button', { name: '어시스턴트 열기' })).toBe(pet());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(pet());
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pet());
  });

  it('a 5 px drag moves the pet and does not toggle; a 3 px wobble still counts as a click', () => {
    const { layout } = setup();
    const b = pet();
    fireEvent.pointerDown(b, { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 505, clientY: 500 });
    fireEvent.pointerUp(b, { pointerId: 1, clientX: 505, clientY: 500 });
    fireEvent.click(b);
    expect(screen.queryByRole('dialog')).toBeNull();
    // moved 5 px to the right: the offset from the right edge shrinks
    expect(wrap().style.getPropertyValue('--pet-x')).toBe('19px');
    expect(layout.get().pet).toMatchObject({ x: 19, y: 40 });
    fireEvent.pointerDown(b, { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: 503, clientY: 500 });
    fireEvent.pointerUp(b, { pointerId: 1, clientX: 503, clientY: 500 });
    fireEvent.click(b);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(layout.get().pet.x).toBe(19);
  });

  it('a drag is clamped to the viewport, and a window resize clamps it again', () => {
    setup();
    const b = pet();
    fireEvent.pointerDown(b, { pointerId: 1, button: 0, clientX: 900, clientY: 700 });
    fireEvent.pointerMove(b, { pointerId: 1, clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(b, { pointerId: 1, clientX: -5000, clientY: -5000 });
    expect(wrap().style.getPropertyValue('--pet-x')).toBe(px(1024 - 64));
    expect(wrap().style.getPropertyValue('--pet-y')).toBe(px(768 - 64));
    setViewport(500, 400);
    act(() => void window.dispatchEvent(new Event('resize')));
    expect(wrap().style.getPropertyValue('--pet-x')).toBe(px(500 - 64));
    expect(wrap().style.getPropertyValue('--pet-y')).toBe(px(400 - 64));
  });

  it('the left dock opening or widening moves a pet that sits over it right away, without saving', () => {
    const dock = document.createElement('aside');
    dock.className = 'sidebar dock';
    document.body.appendChild(dock);
    const seen: ResizeObserverCallback[] = [];
    const disconnect = vi.fn();
    const had = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        constructor(cb: ResizeObserverCallback) {
          seen.push(cb);
        }
        observe(el: Element) {
          expect(el).toBe(dock);
        }
        unobserve() {}
        disconnect = disconnect;
      },
    });
    try {
      const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
      const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
      let left = 0;
      const store = createPetStore({ layout, viewport: () => ({ w: window.innerWidth, h: window.innerHeight, left }) });
      const view = render(<PetLayer store={store} />);
      act(() => layout.setPet({ x: 1024 - 64, y: 40 })); // at the left edge
      expect(wrap().style.getPropertyValue('--pet-x')).toBe(px(1024 - 64));
      expect(seen).toHaveLength(1);
      left = 300; // the dock opened
      act(() => seen[0]([], {} as ResizeObserver));
      expect(wrap().style.getPropertyValue('--pet-x')).toBe(px(1024 - 300 - 64));
      expect(layout.get().pet.x).toBe(1024 - 64); // not saved, like a window resize
      view.unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally {
      if (had) Object.defineProperty(globalThis, 'ResizeObserver', had);
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      dock.remove();
    }
  });

  it('Alt+Arrow moves 8 px, Alt+Shift+Arrow 32 px, Alt+Home resets and announces; each prevents the default (WebView2 history)', () => {
    const { layout } = setup();
    const b = pet();
    expect(fireEvent.keyDown(b, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true })).toBe(false);
    expect(wrap().style.getPropertyValue('--pet-x')).toBe('32px');
    expect(fireEvent.keyDown(b, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, shiftKey: true })).toBe(false);
    expect(wrap().style.getPropertyValue('--pet-x')).toBe('64px');
    expect(fireEvent.keyDown(b, { key: 'ArrowUp', code: 'ArrowUp', altKey: true })).toBe(false);
    expect(wrap().style.getPropertyValue('--pet-y')).toBe('48px');
    expect(fireEvent.keyDown(b, { key: 'ArrowRight', code: 'ArrowRight', altKey: true })).toBe(false);
    expect(fireEvent.keyDown(b, { key: 'ArrowDown', code: 'ArrowDown', altKey: true })).toBe(false);
    expect(layout.get().pet).toMatchObject({ x: 56, y: 40 });
    expect(screen.getByRole('status').textContent).toBe('어시스턴트 위치: 오른쪽 아래');
    expect(fireEvent.keyDown(b, { key: 'Home', code: 'Home', altKey: true })).toBe(false);
    expect(layout.get().pet).toMatchObject({ x: PET_DEFAULT.x, y: PET_DEFAULT.y });
    expect(screen.getByRole('status').textContent).toBe('어시스턴트를 처음 자리로 옮겼어요: 오른쪽 아래');
    // without Alt (or with Ctrl too) the arrows are left alone
    expect(fireEvent.keyDown(b, { key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(true);
    expect(fireEvent.keyDown(b, { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true, ctrlKey: true })).toBe(true);
  });

  it('a hidden pet renders nothing; showing it again brings it back', () => {
    const { store } = setup();
    act(() => store.toggleVisible());
    expect(screen.queryByRole('button', { name: '어시스턴트 열기' })).toBeNull();
    expect(document.querySelector('.pet-wrap')).toBeNull();
    act(() => store.toggleVisible());
    expect(pet()).toBeTruthy();
  });

  it('the bubble flips below a pet at the top edge and is pushed inside the window at the left edge (Visual QA)', () => {
    const rect = (left: number, top: number) => ({ left, top, right: left + 64, bottom: top + 64, width: 64, height: 64, x: left, y: top, toJSON: () => ({}) });
    let petRect = rect(940, 0);
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.classList.contains('pet') ? petRect : rect(0, 0)) as DOMRect;
    });
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(352);
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300);
    try {
      const { store } = setup();
      fireEvent.click(pet());
      const bubble = () => screen.getByRole('dialog') as HTMLElement;
      expect(bubble().dataset.side).toBe('below');
      expect(bubble().style.getPropertyValue('--bubble-top')).toBe(px(64 + 8));
      expect(bubble().style.getPropertyValue('--bubble-max-h')).toBe(px(768 - 8 - (64 + 8)));
      // moved to the bottom-left corner: above the pet, but never left of the window
      petRect = rect(0, 704);
      act(() => store.moveBy(-8, 0));
      expect(bubble().dataset.side).toBe('above');
      expect(bubble().style.getPropertyValue('--bubble-left')).toBe(px(8));
      expect(bubble().style.getPropertyValue('--bubble-bottom')).toBe(px(768 - (704 - 8)));
    } finally {
      spy.mockRestore();
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('the bubble can hide the pet', () => {
    const { layout } = setup();
    fireEvent.click(pet());
    fireEvent.click(screen.getByRole('button', { name: '어시스턴트 숨기기' }));
    expect(layout.get().pet.hidden).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape in the bubble closes it and returns focus to the pet, or to where the command was run from', () => {
    const { store } = setup();
    fireEvent.click(pet());
    const close = screen.getByRole('button', { name: '닫기' });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '어시스턴트에게 보낼 글' }));
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pet());
    const restore = vi.fn();
    act(() => store.setOpen(true, restore));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(restore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape lands on the pet when the place the command was run from cannot take focus (the page body, a removed element)', () => {
    const { store } = setup();
    // Opened by the shortcut while nothing had focus: the restore target is the body.
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => store.setOpen(true, () => document.body.focus()));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(pet());
    // Opened from a button that is gone by the time the bubble closes.
    const gone = document.createElement('button');
    document.body.append(gone);
    gone.focus();
    act(() => store.setOpen(true, () => gone.focus()));
    gone.remove();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(document.activeElement).toBe(pet());
  });
});

describe('PetLayer skins', () => {
  it('draws an installed skin from blob: URLs, falls back to the built-in skin, and revokes on switch and unmount', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47];
    const manifest = {
      format: 1,
      id: 'flasko-blue',
      name: 'Blue',
      author: 'Hong',
      licence: 'MIT',
      version: '1.0.0',
      frame: { width: 48, height: 40 },
      states: {
        idle: { sheet: 'idle.png', frames: 2, fps: 2 },
        talk: { sheet: 'talk.png', frames: 2, fps: 2 },
        think: { sheet: 'think.png', frames: 2, fps: 2 },
        done: { sheet: 'done.png', frames: 2, fps: 2 },
      },
    };
    const skinInvoke = (async (cmd: string, a?: Record<string, unknown>) => {
      if (cmd !== 'skin_read') return null;
      if (a?.id !== 'flasko-blue') throw { kind: 'notFound' };
      return { manifest, sheets: { idle: png, talk: png, think: png, done: png } };
    }) as import('../../integrations/netIpc').InvokeFn;
    let n = 0;
    const live = new Set<string>();
    const urls = {
      create: () => {
        const u = `blob:pet/${++n}`;
        live.add(u);
        return u;
      },
      revoke: (u: string) => void live.delete(u),
    };
    const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
    const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
    layout.setPet({ skin: 'flasko-blue' });
    const store = createPetStore({ layout });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const view = render(<PetLayer store={store} skinDeps={{ invoke: skinInvoke, urls }} />);
    const sprite = () => wrap().querySelector('.pet-sprite') as HTMLElement;
    await act(async () => undefined);
    expect(sprite().style.getPropertyValue('--pet-sheet').startsWith('url("blob:pet/')).toBe(true);
    expect(sprite().style.getPropertyValue('--pet-w')).toBe('48px');
    expect(live.size).toBe(4);

    // An id that is not installed: the built-in skin, and the old URLs are revoked.
    await act(async () => layout.setPet({ skin: 'gone-skin' }));
    expect(sprite().style.getPropertyValue('--pet-sheet')).toBe('url("/skins/flasko/idle.png")');
    expect(live.size).toBe(0);

    await act(async () => layout.setPet({ skin: 'flasko-blue' }));
    expect(live.size).toBe(4);
    view.unmount();
    expect(live.size).toBe(0);
    warn.mockRestore();
  });
});

describe('PetLayer: resizing the assistant window (the bubble)', () => {
  const rect = (left: number, top: number) => ({ left, top, right: left + 64, bottom: top + 64, width: 64, height: 64, x: left, y: top, toJSON: () => ({}) });
  let petRect = rect(940, 680);
  let spies: { mockRestore(): void }[] = [];
  beforeEach(() => {
    petRect = rect(940, 680);
    spies = [
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        return (this.classList.contains('pet') ? petRect : rect(0, 0)) as DOMRect;
      }),
      // the default size as drawn: 22rem × its content
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(352),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(300),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  const bubble = () => screen.getByRole('dialog') as HTMLElement;
  const grip = () => screen.getByRole('button', { name: '어시스턴트 창 크기 조절' });
  const w = () => bubble().style.getPropertyValue('--bubble-w');
  const h = () => bubble().style.getPropertyValue('--bubble-h');
  const drag = (dx: number, dy: number, up = true) => {
    const g = grip();
    fireEvent.pointerDown(g, { pointerId: 7, button: 0, clientX: 600, clientY: 400 });
    fireEvent.pointerMove(g, { pointerId: 7, clientX: 600 + dx, clientY: 400 + dy });
    if (up) fireEvent.pointerUp(g, { pointerId: 7, clientX: 600 + dx, clientY: 400 + dy });
  };

  it('the grip is a named, focusable button inside the bubble that says how to use it; the bubble starts at the default size', () => {
    setup();
    fireEvent.click(pet());
    const g = grip();
    expect(bubble().contains(g)).toBe(true);
    expect(g.tagName).toBe('BUTTON');
    expect(g.getAttribute('type')).toBe('button');
    expect(g.tabIndex).toBe(0);
    expect(g.getAttribute('title')).toContain('Home');
    expect(g.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(g.getAttribute('aria-describedby')!)?.textContent).toContain('화살표');
    expect(bubble().dataset.sized).toBeUndefined();
    expect(w()).toBe('');
    // anchored above the right edge of the pet: the grip is on the top-left corner
    expect(bubble().dataset.side).toBe('above');
    expect(bubble().dataset.growX).toBe('left');
    // the reset button only shows once a size is set
    expect(screen.queryByRole('button', { name: '기본 크기로' })).toBeNull();
  });

  it('dragging the top-left grip resizes the bubble; nothing is saved until the pointer is let go, and the bubble stays open', () => {
    const { layout } = setup();
    fireEvent.click(pet());
    drag(-50, -30, false);
    expect(bubble().dataset.sized).toBe('true');
    expect([w(), h()]).toEqual([px(402), px(330)]);
    expect(layout.get().pet).toMatchObject({ bubbleW: 0, bubbleH: 0 });
    fireEvent.pointerUp(grip(), { pointerId: 7, clientX: 550, clientY: 370 });
    expect(layout.get().pet).toMatchObject({ bubbleW: 402, bubbleH: 330 });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(pet().getAttribute('aria-expanded')).toBe('true');
  });

  it('a drag is clamped to 280×240 and to the room in the window (width: the window frame, height: the room above the pet)', () => {
    const { layout } = setup();
    fireEvent.click(pet());
    drag(500, 500);
    expect([w(), h()]).toEqual([px(280), px(240)]);
    drag(-5000, -5000);
    // 1024 − 2 × 8 wide; above the pet at 680 there is 680 − 8 − 8 high
    expect([w(), h()]).toEqual([px(1008), px(664)]);
    expect(layout.get().pet).toMatchObject({ bubbleW: 1008, bubbleH: 664 });
  });

  it('follows the flip: below the pet the grip is on the bottom edge, pushed right of the window edge it is on the right', () => {
    petRect = rect(940, 0);
    const { store } = setup();
    fireEvent.click(pet());
    expect(bubble().dataset.side).toBe('below');
    expect(bubble().dataset.growX).toBe('left');
    drag(-20, 40);
    expect([w(), h()]).toEqual([px(372), px(340)]);
    // the pet moves to the bottom-left corner: above it, pushed right of the window edge
    petRect = rect(0, 680);
    act(() => store.moveBy(-8, 0));
    expect(bubble().dataset.side).toBe('above');
    expect(bubble().dataset.growX).toBe('right');
    drag(40, -20);
    expect([w(), h()]).toEqual([px(412), px(360)]);
  });

  it('keyboard: arrows move the grip by 16 px (Shift 64 px) and save; Home and a double-click go back to the default size; each is announced', () => {
    const { layout } = setup();
    fireEvent.click(pet());
    const g = grip();
    g.focus();
    expect(fireEvent.keyDown(g, { key: 'ArrowLeft' })).toBe(false);
    expect([w(), h()]).toEqual([px(368), px(300)]);
    expect(layout.get().pet).toMatchObject({ bubbleW: 368, bubbleH: 300 });
    expect(document.querySelector('.pet-live')?.textContent).toBe('어시스턴트 창 크기: 368×300');
    fireEvent.keyDown(g, { key: 'ArrowUp', shiftKey: true });
    expect(h()).toBe(px(364));
    fireEvent.keyDown(g, { key: 'ArrowRight' });
    fireEvent.keyDown(g, { key: 'ArrowDown' });
    expect([w(), h()]).toEqual([px(352), px(348)]);
    expect(layout.get().pet).toMatchObject({ bubbleW: 352, bubbleH: 348 });
    expect(fireEvent.keyDown(g, { key: 'Home' })).toBe(false);
    expect(bubble().dataset.sized).toBeUndefined();
    expect(w()).toBe('');
    expect(layout.get().pet).toMatchObject({ bubbleW: 0, bubbleH: 0 });
    expect(document.querySelector('.pet-live')?.textContent).toBe('어시스턴트 창을 기본 크기로 되돌렸어요');
    // the focus stays on the grip
    expect(document.activeElement).toBe(grip());
    fireEvent.keyDown(grip(), { key: 'ArrowLeft', shiftKey: true });
    expect(w()).toBe(px(416));
    fireEvent.doubleClick(grip());
    expect(layout.get().pet).toMatchObject({ bubbleW: 0, bubbleH: 0 });
    // Alt+arrow belongs to moving the pet, not to the grip
    fireEvent.keyDown(grip(), { key: 'ArrowLeft', altKey: true });
    expect(w()).toBe('');
  });

  it('the bubble menu resets a set size and moves the focus to the grip', () => {
    const { layout } = setup();
    fireEvent.click(pet());
    drag(-40, -40);
    fireEvent.click(screen.getByRole('button', { name: '기본 크기로' }));
    expect(layout.get().pet).toMatchObject({ bubbleW: 0, bubbleH: 0 });
    expect(w()).toBe('');
    expect(screen.queryByRole('button', { name: '기본 크기로' })).toBeNull();
    expect(document.activeElement).toBe(grip());
  });

  it('a size saved on this PC comes back when the bubble opens', () => {
    const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
    const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
    layout.setPet({ bubbleW: 500, bubbleH: 400 });
    const store = createPetStore({ layout });
    render(<PetLayer store={store} />);
    fireEvent.click(pet());
    expect(bubble().dataset.sized).toBe('true');
    expect([w(), h()]).toEqual([px(500), px(400)]);
  });

  it('a smaller window clamps the size (not saved); the saved size comes back when the window grows again', () => {
    const { layout } = setup();
    fireEvent.click(pet());
    drag(-300, -200);
    expect([w(), h()]).toEqual([px(652), px(500)]);
    act(() => {
      setViewport(500, 768);
      window.dispatchEvent(new Event('resize'));
    });
    expect(w()).toBe(px(500 - 16));
    expect(layout.get().pet).toMatchObject({ bubbleW: 652, bubbleH: 500 });
    act(() => {
      setViewport(1024, 768);
      window.dispatchEvent(new Event('resize'));
    });
    expect(w()).toBe(px(652));
  });

  it('the height is capped to the room on the side the bubble is on when the pet moves', () => {
    const { store } = setup();
    fireEvent.click(pet());
    drag(0, -300);
    expect(h()).toBe(px(600));
    // the pet moved up: only 400 − 16 px above it now, still more than below, so it stays above and is capped there
    petRect = rect(940, 400);
    act(() => store.moveBy(0, -8));
    expect(bubble().dataset.side).toBe('above');
    expect(bubble().style.getPropertyValue('--bubble-max-h')).toBe(px(400 - 16));
  });

  it('sets its size through CSSOM only: no style attribute in the markup of the assistant components', () => {
    for (const f of ['src/assistant/PetLayer.tsx', 'src/assistant/Bubble.tsx']) {
      expect(readFileSync(f, 'utf-8'), f).not.toMatch(/style=\{|style="/);
    }
  });
});
