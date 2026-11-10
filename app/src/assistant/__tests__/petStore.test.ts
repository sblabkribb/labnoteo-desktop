// @vitest-environment jsdom
import { createLayoutStore, PET_DEFAULT, type UiPrefs } from '../../ui/layoutStore';
import { BUILTIN_SKIN } from '../skins/builtin';
import { applySkinVars, createPetStore, DONE_MS, MOVE_STEP, MOVE_STEP_BIG, petArea } from '../petStore';

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

function setup(viewport = { w: 1200, h: 800 }) {
  const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => (a?.prefs as UiPrefs | undefined) ?? null);
  const layout = createLayoutStore({ storage: () => memoryStorage(), invoke });
  const store = createPetStore({ layout, viewport: () => viewport });
  return { layout, store, invoke, viewport };
}

afterEach(() => vi.useRealTimers());

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
