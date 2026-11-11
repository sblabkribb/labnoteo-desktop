// @vitest-environment jsdom
import { createLayoutStore, PET_DEFAULT, type UiPrefs } from '../../ui/layoutStore';
import { BUILTIN_SKIN } from '../skins/builtin';
import { applySkinVars, BUBBLE_GAP, bubbleBounds, bubblePlace, createPetStore, RESIZE_STEP, RESIZE_STEP_BIG, DONE_MS, MOVE_STEP, MOVE_STEP_BIG, petArea, petSize, snapScale, windowViewport, type Viewport } from '../petStore';

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

function setup(viewport: Viewport = { w: 1200, h: 800 }) {
  const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
  const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
  const store = createPetStore({ layout, viewport: () => viewport });
  return { layout, store, invoke, viewport };
}

afterEach(() => vi.useRealTimers());

describe('the window frame the pet stays in', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('style');
    delete document.documentElement.dataset.leftHidden;
  });

  function dockAt(right: number) {
    const dock = document.createElement('aside');
    dock.className = 'sidebar dock';
    dock.getBoundingClientRect = () => ({ left: 44, right, width: right - 44, top: 0, bottom: 800, height: 800, x: 44, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(dock);
  }

  it('keeps clear of the ribbon, the open left dock (vault switcher) and the status bar (visual QA)', () => {
    document.documentElement.style.setProperty('--ribbon-w', '44px');
    document.documentElement.style.setProperty('--statusbar-h', '26px');
    dockAt(304);
    const vp = windowViewport();
    expect(vp.left).toBe(304);
    expect(vp.bottom).toBe(26);
    // with the dock open, Alt+Shift+Left stops at the dock edge instead of parking on the vault switcher
    const layout = createLayoutStore({ storage: () => memoryStorage(), invoke: vi.fn(async () => null) });
    const store = createPetStore({ layout, viewport: () => ({ ...windowViewport(), w: 1200, h: 800 }) });
    for (let i = 0; i < 60; i++) store.moveBy(-MOVE_STEP_BIG, 0);
    expect(1200 - store.get().pos.x - petSize(store.get().scale).w).toBeGreaterThanOrEqual(304);
  });

  it('a hidden dock gives the room back to the pet; only the ribbon is kept clear', () => {
    document.documentElement.style.setProperty('--ribbon-w', '44px');
    dockAt(304);
    document.documentElement.dataset.leftHidden = 'true';
    expect(windowViewport().left).toBe(44);
  });
});

describe('pet state machine', () => {
  it('starts idle and closed; done goes back to idle after 1.6 s; another state cancels that', () => {
    vi.useFakeTimers();
    const { store } = setup();
    expect(store.get()).toMatchObject({ state: 'idle', open: false, hidden: false, pos: { x: 24, y: 40 }, scale: 2 });
    expect(DONE_MS).toBe(1600);
    store.setState('think');
    expect(store.get().state).toBe('think');
    store.setState('talk');
    store.setState('done');
    vi.advanceTimersByTime(DONE_MS - 1);
    expect(store.get().state).toBe('done');
    vi.advanceTimersByTime(1);
    expect(store.get().state).toBe('idle');
    store.setState('done');
    store.setState('think');
    vi.advanceTimersByTime(DONE_MS * 2);
    expect(store.get().state).toBe('think');
  });

  it('toggle opens and closes the bubble; snapshots are stable between changes', () => {
    const { store } = setup();
    const a = store.get();
    expect(store.get()).toBe(a);
    const seen: boolean[] = [];
    const off = store.subscribe(() => seen.push(store.get().open));
    store.toggle();
    store.toggle();
    off();
    store.toggle();
    expect(seen).toEqual([true, false]);
    expect(store.get().open).toBe(true);
  });
});

describe('pet position', () => {
  it('moveBy moves on screen (offsets are from the right/bottom edges) and saves through the layout store', () => {
    const { store, layout } = setup();
    expect([MOVE_STEP, MOVE_STEP_BIG]).toEqual([8, 32]);
    store.moveBy(-MOVE_STEP, 0); // left
    expect(store.get().pos).toEqual({ x: 32, y: 40 });
    store.moveBy(0, -MOVE_STEP_BIG); // up
    expect(store.get().pos).toEqual({ x: 32, y: 72 });
    expect(layout.get().pet).toMatchObject({ x: 32, y: 72 });
    store.moveBy(500, 500); // right/down past the edge: clamped to 0
    expect(store.get().pos).toEqual({ x: 0, y: 0 });
  });

  it('dragTo clamps into the viewport without saving; commit saves; clampTo follows a resize', () => {
    const { store, layout, viewport } = setup({ w: 400, h: 300 });
    store.dragTo(10000, -50);
    // the sprite is 32 px × scale 2 = 64 px: the offset can be at most viewport − 64
    expect(store.get().pos).toEqual({ x: 336, y: 0 });
    expect(layout.get().pet).toMatchObject({ x: PET_DEFAULT.x, y: PET_DEFAULT.y });
    store.commit();
    expect(layout.get().pet).toMatchObject({ x: 336, y: 0 });
    viewport.w = 200;
    store.clampTo(200, 300);
    expect(store.get().pos).toEqual({ x: 136, y: 0 });
  });

  it('reset goes back to the default corner and saves', () => {
    const { store, layout } = setup();
    store.moveBy(-80, -80);
    store.reset();
    expect(store.get().pos).toEqual({ x: PET_DEFAULT.x, y: PET_DEFAULT.y });
    expect(layout.get().pet).toMatchObject({ x: PET_DEFAULT.x, y: PET_DEFAULT.y });
  });

  it('follows layout changes (settings pane, Rust load) for position, hidden and scale', () => {
    const { store, layout } = setup();
    layout.setPet({ x: 90, hidden: true, scale: 3 });
    expect(store.get()).toMatchObject({ pos: { x: 90, y: 40 }, hidden: true, scale: 3 });
  });

  it('toggleVisible hides and shows; hiding closes the bubble', () => {
    const { store, layout } = setup();
    store.toggle();
    store.toggleVisible();
    expect(store.get()).toMatchObject({ hidden: true, open: false });
    expect(layout.get().pet.hidden).toBe(true);
    store.toggleVisible();
    expect(store.get().hidden).toBe(false);
  });

  it('petArea names the corner for the live hint', () => {
    expect(petArea({ x: 24, y: 40 }, { w: 1200, h: 800 })).toEqual({ h: 'right', v: 'bottom' });
    expect(petArea({ x: 1100, y: 700 }, { w: 1200, h: 800 })).toEqual({ h: 'left', v: 'top' });
    expect(petArea({ x: 570, y: 370 }, { w: 1200, h: 800 })).toEqual({ h: 'middle', v: 'middle' });
  });
});

describe('applySkinVars', () => {
  it('sets the sprite variables through CSSOM from the skin and state', () => {
    const el = document.createElement('span');
    const set = vi.spyOn(el.style, 'setProperty');
    applySkinVars(el, BUILTIN_SKIN, 'think');
    expect(set).toHaveBeenCalledWith('--pet-sheet', 'url("/skins/flasko/think.png")');
    expect(el.style.getPropertyValue('--pet-w')).toBe('32px');
    expect(el.style.getPropertyValue('--pet-h')).toBe('32px');
    expect(el.style.getPropertyValue('--pet-frames')).toBe('6');
    expect(el.style.getPropertyValue('--pet-dur')).toBe('1000ms');
    applySkinVars(el, BUILTIN_SKIN, 'done');
    expect(el.style.getPropertyValue('--pet-frames')).toBe('6');
    expect(el.style.getPropertyValue('--pet-dur')).toBe('600ms');
  });
});

describe('pet stays out of the window frame (Visual QA)', () => {
  const frame: Viewport = { w: 1200, h: 800, top: 36, left: 44, bottom: 26, right: 0 };

  it('moveBy and dragTo keep the pet off the status bar, the ribbon and the view header', () => {
    const { store } = setup({ ...frame });
    store.moveBy(5000, 5000); // right/down past the edge: stops above the status bar
    expect(store.get().pos).toEqual({ x: 0, y: 26 });
    store.moveBy(-5000, -5000); // left/up: stops right of the ribbon and below the view header
    expect(store.get().pos).toEqual({ x: 1200 - 44 - 64, y: 800 - 36 - 64 });
    store.dragTo(-10, 0);
    expect(store.get().pos).toEqual({ x: 0, y: 26 });
  });

  it('clampTo uses the frame too; a window too small for the pet pins it to the bottom-right frame', () => {
    const { store } = setup({ ...frame });
    store.moveBy(-5000, -5000);
    store.clampTo(600, 400);
    expect(store.get().pos).toEqual({ x: 600 - 44 - 64, y: 400 - 36 - 64 });
    store.clampTo(100, 100);
    expect(store.get().pos).toEqual({ x: 0, y: 26 });
  });
});

describe('pet clamp follows the active skin frame (review)', () => {
  const frame: Viewport = { w: 1200, h: 800, top: 36, left: 44, bottom: 26, right: 0 };
  const big = { ...BUILTIN_SKIN, id: 'big-cat', frame: { width: 96, height: 96 } };

  it('moveBy, dragTo, reset and clampTo use the installed skin size, not the built-in 32 px', () => {
    const { store } = setup({ ...frame });
    store.setSkinManifest(big);
    store.moveBy(-5000, -5000);
    // 96 px × scale 2 = 192 px: the sprite's left/top edge stays right of the ribbon and below the view header
    expect(store.get().pos).toEqual({ x: 1200 - 44 - 192, y: 800 - 36 - 192 });
    store.dragTo(5000, 5000);
    expect(store.get().pos).toEqual({ x: 1200 - 44 - 192, y: 800 - 36 - 192 });
    store.clampTo(600, 400);
    expect(store.get().pos).toEqual({ x: 600 - 44 - 192, y: 400 - 36 - 192 });
  });

  it('re-clamps when a bigger skin becomes active', () => {
    const { store } = setup({ ...frame });
    store.moveBy(-5000, -5000);
    expect(store.get().pos).toEqual({ x: 1200 - 44 - 64, y: 800 - 36 - 64 });
    store.setSkinManifest(big);
    expect(store.get().pos).toEqual({ x: 1200 - 44 - 192, y: 800 - 36 - 192 });
  });
});

describe('snapScale (150% screens)', () => {
  it('keeps whole device pixels per art pixel', () => {
    expect(snapScale(2, 1)).toBe(2);
    expect(snapScale(3, 1)).toBe(3);
    expect(snapScale(2, 1.5)).toBe(2);
    expect(snapScale(3, 1.5) * 1.5).toBe(5);
    expect(snapScale(3, 2)).toBe(3);
    expect(snapScale(2, 0)).toBe(2);
    expect(petSize(3, undefined, 1.5)).toEqual({ w: 107, h: 107 });
    expect(petSize(2, undefined, 1)).toEqual({ w: 64, h: 64 });
  });
});

describe('bubblePlace', () => {
  const vp: Viewport = { w: 1200, h: 800, top: 36, left: 44, bottom: 26, right: 0 };
  const bubble = { w: 352, h: 400 };
  const petAt = (left: number, top: number) => ({ left, top, right: left + 64, bottom: top + 64 });

  it('opens above the pet, right edges aligned, at the default corner', () => {
    const p = bubblePlace(petAt(1112, 696), bubble, vp);
    expect(p.side).toBe('above');
    expect(p.left).toBe(1176 - 352);
    expect(p.bottom).toBe(800 - (696 - BUBBLE_GAP));
    expect(p.maxH).toBe(696 - BUBBLE_GAP - (36 + BUBBLE_GAP));
  });

  it('flips below the pet at the top edge, so it is never above the window', () => {
    const p = bubblePlace(petAt(1112, 36), bubble, vp);
    expect(p.side).toBe('below');
    expect(p.top).toBe(36 + 64 + BUBBLE_GAP);
    expect(p.maxH).toBe(800 - 26 - BUBBLE_GAP - (36 + 64 + BUBBLE_GAP));
  });

  it('is pushed right of the ribbon at the left edge', () => {
    const p = bubblePlace(petAt(44, 710), bubble, vp);
    expect(p.side).toBe('above');
    expect(p.left).toBe(44 + BUBBLE_GAP);
  });

  it('a tall bubble with more room below than above goes below and is capped to the room there', () => {
    const p = bubblePlace(petAt(600, 200), { w: 352, h: 600 }, vp);
    expect(p.side).toBe('below');
    expect(p.maxH).toBe(800 - 26 - BUBBLE_GAP - (264 + BUBBLE_GAP));
    const q = bubblePlace(petAt(600, 500), { w: 352, h: 600 }, vp);
    expect(q.side).toBe('above');
    expect(q.maxH).toBe(500 - BUBBLE_GAP - (36 + BUBBLE_GAP));
  });

  it('says which way the bubble grows: toward the window from the pet (top-left above, bottom-left below, right when pushed)', () => {
    expect(bubblePlace(petAt(1112, 696), bubble, vp)).toMatchObject({ side: 'above', growX: 'left' });
    expect(bubblePlace(petAt(1112, 36), bubble, vp)).toMatchObject({ side: 'below', growX: 'left' });
    // pushed right of the ribbon: the left edge is pinned, so it grows to the right
    expect(bubblePlace(petAt(44, 710), bubble, vp)).toMatchObject({ side: 'above', growX: 'right' });
  });

  it('a side asked for (while resizing) is kept even when the other side has more room', () => {
    const p = bubblePlace(petAt(600, 200), { w: 352, h: 600 }, vp, 'above');
    expect(p.side).toBe('above');
    expect(p.maxH).toBe(200 - BUBBLE_GAP - (36 + BUBBLE_GAP));
  });
});

describe('the assistant window size (resizable bubble)', () => {
  it('bubbleBounds: at least 280×240, at most the window minus the frame and the gaps', () => {
    const vp: Viewport = { w: 1200, h: 800, top: 36, left: 44, bottom: 26, right: 0 };
    expect(bubbleBounds(vp)).toEqual({ minW: 280, minH: 240, maxW: 1200 - 44 - 2 * BUBBLE_GAP, maxH: 800 - 36 - 26 - 2 * BUBBLE_GAP });
    // a window too small for the minimum: the maximum wins, nothing overflows the window
    expect(bubbleBounds({ w: 250, h: 200 })).toEqual({ minW: 250 - 2 * BUBBLE_GAP, minH: 200 - 2 * BUBBLE_GAP, maxW: 250 - 2 * BUBBLE_GAP, maxH: 200 - 2 * BUBBLE_GAP });
  });

  it('starts at the default size (null); setBubbleSize clamps and saves per PC through the layout store', () => {
    const { store, layout } = setup({ w: 1200, h: 800 });
    expect(store.get().bubble).toBeNull();
    expect([RESIZE_STEP, RESIZE_STEP_BIG]).toEqual([16, 64]);
    store.setBubbleSize(500, 400);
    expect(store.get().bubble).toEqual({ w: 500, h: 400 });
    expect(layout.get().pet).toMatchObject({ bubbleW: 500, bubbleH: 400 });
    store.setBubbleSize(10, 10);
    expect(store.get().bubble).toEqual({ w: 280, h: 240 });
    store.setBubbleSize(9999, 9999);
    expect(store.get().bubble).toEqual({ w: 1200 - 16, h: 800 - 16 });
    expect(layout.get().pet).toMatchObject({ bubbleW: 1184, bubbleH: 784 });
  });

  it('resizeBubbleTo (dragging) clamps without saving; commitBubble saves', () => {
    const { store, layout } = setup();
    store.resizeBubbleTo(600, 100);
    expect(store.get().bubble).toEqual({ w: 600, h: 240 });
    expect(layout.get().pet).toMatchObject({ bubbleW: 0, bubbleH: 0 });
    store.commitBubble();
    expect(layout.get().pet).toMatchObject({ bubbleW: 600, bubbleH: 240 });
  });

  it('resetBubbleSize goes back to the default size and saves', () => {
    const { store, layout } = setup();
    store.setBubbleSize(500, 400);
    store.resetBubbleSize();
    expect(store.get().bubble).toBeNull();
    expect(layout.get().pet).toMatchObject({ bubbleW: 0, bubbleH: 0 });
  });

  it('is restored from the saved size, and follows the layout store (Settings reset, Rust load)', () => {
    const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
    const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
    layout.setPet({ bubbleW: 520, bubbleH: 410 });
    const store = createPetStore({ layout, viewport: () => ({ w: 1200, h: 800 }) });
    expect(store.get().bubble).toEqual({ w: 520, h: 410 });
    layout.setPet({ bubbleW: 0, bubbleH: 0 });
    expect(store.get().bubble).toBeNull();
    layout.setPet({ bubbleW: 3000, bubbleH: 300 });
    expect(store.get().bubble).toEqual({ w: 1184, h: 300 });
  });

  it('clampTo re-clamps a set size to a smaller window without saving; a bigger window brings the saved size back', () => {
    const { store, layout, viewport } = setup({ w: 1200, h: 800 });
    store.setBubbleSize(900, 700);
    viewport.w = 600;
    viewport.h = 500;
    store.clampTo(600, 500);
    expect(store.get().bubble).toEqual({ w: 584, h: 484 });
    expect(layout.get().pet).toMatchObject({ bubbleW: 900, bubbleH: 700 });
    viewport.w = 1200;
    viewport.h = 800;
    store.clampTo(1200, 800);
    expect(store.get().bubble).toEqual({ w: 900, h: 700 });
  });
});
