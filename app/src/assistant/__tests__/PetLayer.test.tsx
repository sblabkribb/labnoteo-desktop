// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const pet = () => screen.getByRole('button', { name: '어시스턴트 열기' });
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
    fireEvent.click(pet());
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
