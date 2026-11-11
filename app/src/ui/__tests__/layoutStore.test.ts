// @vitest-environment jsdom
import {
  applyToDom,
  createLayoutStore,
  DEFAULT_PREFS,
  LAYOUT_KEY,
  normalizePrefs,
  PET_DEFAULT,
  BUBBLE_MIN,
  PET_OFFSET_MAX,
  WRITE_DEBOUNCE_MS,
  type UiPrefs,
} from '../layoutStore';

function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
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

const throwing = (): Storage => {
  const deny = () => {
    throw new Error('denied');
  };
  return { getItem: deny, setItem: deny, removeItem: deny, clear: deny, key: deny, length: 0 } as unknown as Storage;
};

const html = document.documentElement;
beforeEach(() => {
  html.removeAttribute('style');
  for (const a of ['data-left-hidden', 'data-right-open', 'data-density']) html.removeAttribute(a);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalizePrefs (the same rules as Rust ui_prefs.rs)', () => {
  it('fills defaults, clamps widths, rejects unknown tabs and density, drops unknown fields', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs('x')).toEqual(DEFAULT_PREFS);
    const p = normalizePrefs({ leftWidth: 10, rightWidth: 9999, leftTab: 'outline', rightTab: 'links', density: 'tiny', extra: 1 });
    expect(p).toEqual({ ...DEFAULT_PREFS, leftWidth: 200, rightWidth: 480, rightTab: 'links' });
    expect(normalizePrefs({ leftWidth: 333.6, leftHidden: 'yes', rightOpen: true }).leftWidth).toBe(334);
    expect(normalizePrefs({ leftHidden: 'yes' }).leftHidden).toBe(false);
    expect(DEFAULT_PREFS).toMatchObject({ leftWidth: 272, rightWidth: 280, rightOpen: false, density: 'comfortable' });
  });
});

describe('applyToDom', () => {
  it('sets the width variables through style.setProperty and never writes the style attribute string', () => {
    const el = document.createElement('div');
    const setProperty = vi.spyOn(el.style, 'setProperty');
    const setAttribute = vi.spyOn(el, 'setAttribute');
    applyToDom({ ...DEFAULT_PREFS, leftWidth: 300, rightWidth: 250, leftHidden: true, rightOpen: true, density: 'compact' }, el);
    expect(setProperty).toHaveBeenCalledWith('--side-w', '300px');
    expect(setProperty).toHaveBeenCalledWith('--right-w', '250px');
    expect(setAttribute.mock.calls.map((c) => c[0])).not.toContain('style');
    expect(el.getAttribute('data-left-hidden')).toBe('true');
    expect(el.getAttribute('data-right-open')).toBe('true');
    expect(el.getAttribute('data-density')).toBe('compact');
  });

  it('defaults to <html>', () => {
    applyToDom(DEFAULT_PREFS);
    expect(html.style.getPropertyValue('--side-w')).toBe('272px');
    expect(html.getAttribute('data-left-hidden')).toBe('false');
    expect(html.getAttribute('data-right-open')).toBe('false');
    expect(html.getAttribute('data-density')).toBe('comfortable');
  });
});

describe('layout store', () => {
  it('update applies to the DOM at once, notifies, mirrors, and debounces the Rust write', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const invoke = vi.fn(async (_cmd: string, args?: Record<string, unknown>) => (args?.prefs as UiPrefs | undefined) ?? null);
    const store = createLayoutStore({ storage: () => storage, invoke });
    const seen: UiPrefs[] = [];
    const off = store.subscribe((p) => seen.push(p));
    store.update({ leftWidth: 300 });
    store.update({ leftWidth: 320 });
    store.update({ leftWidth: 340 });
    expect(html.style.getPropertyValue('--side-w')).toBe('340px');
    expect(store.get().leftWidth).toBe(340);
    expect(seen.map((p) => p.leftWidth)).toEqual([300, 320, 340]);
    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!).leftWidth).toBe(340);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS - 1);
    expect(invoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('ui_prefs_write', { prefs: expect.objectContaining({ leftWidth: 340 }) });
    expect(WRITE_DEBOUNCE_MS).toBe(300);
    off();
    store.update({ leftHidden: true });
    expect(seen).toHaveLength(3);
  });

  it('on a narrow window the left dock yields while the right sidebar is open, and comes back when it closes', () => {
    const width = window.innerWidth;
    try {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
      const s = createLayoutStore({ storage: () => memoryStorage(), invoke: async () => DEFAULT_PREFS });
      s.toggleRight();
      expect([s.get().rightOpen, s.get().leftHidden]).toEqual([true, true]);
      s.toggleRight();
      expect([s.get().rightOpen, s.get().leftHidden]).toEqual([false, false]);
      // showing the dock again by hand keeps it: closing the right sidebar then leaves the dock as it is
      s.toggleRight();
      s.toggleLeft();
      s.toggleRight();
      expect([s.get().rightOpen, s.get().leftHidden]).toEqual([false, false]);
      // a wide window keeps both
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1400 });
      s.toggleRight();
      expect([s.get().rightOpen, s.get().leftHidden]).toEqual([true, false]);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('update clamps what it is given', () => {
    const store = createLayoutStore({ storage: () => memoryStorage(), invoke: vi.fn(async () => null) });
    store.update({ leftWidth: 50 });
    expect(store.get().leftWidth).toBe(200);
  });

  it('a throwing or missing localStorage is tolerated', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => null);
    const store = createLayoutStore({ storage: throwing, invoke });
    expect(store.get()).toEqual(DEFAULT_PREFS);
    expect(() => store.update({ leftHidden: true })).not.toThrow();
    expect(html.getAttribute('data-left-hidden')).toBe('true');
    const none = createLayoutStore({
      storage: () => {
        throw new Error('SecurityError');
      },
      invoke,
    });
    expect(() => none.update({ rightOpen: true })).not.toThrow();
    await expect(none.load(invoke)).resolves.toEqual(DEFAULT_PREFS);
  });

  it('starts from the localStorage mirror, but load prefers Rust over it', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ ...DEFAULT_PREFS, leftWidth: 400 }) });
    const invoke = vi.fn(async () => ({ ...DEFAULT_PREFS, leftWidth: 260, density: 'compact' }));
    const store = createLayoutStore({ storage: () => storage, invoke });
    expect(store.get().leftWidth).toBe(400);
    const loaded = await store.load(invoke);
    expect(invoke).toHaveBeenCalledWith('ui_prefs_read');
    expect(loaded.leftWidth).toBe(260);
    expect(store.get().leftWidth).toBe(260);
    expect(html.style.getPropertyValue('--side-w')).toBe('260px');
    expect(html.getAttribute('data-density')).toBe('compact');
    expect(JSON.parse(storage.getItem(LAYOUT_KEY)!).leftWidth).toBe(260);
  });

  it('a failing Rust read keeps the mirror and still applies it', async () => {
    const storage = memoryStorage({ [LAYOUT_KEY]: JSON.stringify({ leftWidth: 410, leftHidden: true }) });
    const invoke = vi.fn(async () => {
      throw new Error('no ipc');
    });
    const store = createLayoutStore({ storage: () => storage, invoke });
    await expect(store.load(invoke)).resolves.toMatchObject({ leftWidth: 410, leftHidden: true });
    expect(html.getAttribute('data-left-hidden')).toBe('true');
  });

  it('a change made while load is in flight is not overwritten by it', async () => {
    let resolve!: (v: unknown) => void;
    const invoke = vi.fn((cmd: string) => (cmd === 'ui_prefs_read' ? new Promise((r) => (resolve = r)) : Promise.resolve(null)));
    const store = createLayoutStore({ storage: () => memoryStorage(), invoke: invoke as never });
    const p = store.load(invoke as never);
    store.update({ leftHidden: true });
    resolve({ ...DEFAULT_PREFS, leftWidth: 300 });
    await p;
    expect(store.get().leftHidden).toBe(true);
  });

  it('ready() resolves at once without a load and waits for one in flight', async () => {
    const store = createLayoutStore({ storage: () => memoryStorage(), invoke: vi.fn(async () => null) });
    await expect(store.ready()).resolves.toBeUndefined();
    let resolve!: (v: unknown) => void;
    const invoke = vi.fn(() => new Promise((r) => (resolve = r)));
    void store.load(invoke as never);
    let done = false;
    void store.ready().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    resolve(DEFAULT_PREFS);
    await vi.waitFor(() => expect(done).toBe(true));
  });
});

describe('pet prefs (floating assistant, assistant spec §4.1/§4.3)', () => {
  it('normalizePrefs applies the Rust rules to pet: clamped offsets, scale 2|3, skin id pattern, junk gives defaults', () => {
    expect(DEFAULT_PREFS.pet).toEqual({ x: PET_DEFAULT.x, y: PET_DEFAULT.y, hidden: false, scale: 2, skin: 'flasko', bubbleW: 0, bubbleH: 0 });
    expect(PET_DEFAULT).toEqual({ x: 24, y: 40, hidden: false, scale: 2, skin: 'flasko', bubbleW: 0, bubbleH: 0 });
    expect(normalizePrefs({ pet: { x: -5, y: 1e9, hidden: true, scale: 7, skin: '../evil' } }).pet).toEqual({
      x: 0,
      y: PET_OFFSET_MAX,
      hidden: true,
      scale: 2,
      skin: 'flasko',
      bubbleW: 0,
      bubbleH: 0,
    });
    expect(normalizePrefs({ pet: { x: 33.6, y: 'far', scale: 3, skin: 'my-skin-2', extra: 1 } }).pet).toEqual({
      x: 34,
      y: 40,
      hidden: false,
      scale: 3,
      skin: 'my-skin-2',
      bubbleW: 0,
      bubbleH: 0,
    });
    for (const bad of ['ab', 'Flasko', 'a_b_c', 'x'.repeat(33), '', '가나다'])
      expect(normalizePrefs({ pet: { skin: bad } }).pet.skin, bad).toBe('flasko');
    for (const junk of ['junk', 42, null, [1, 2], true]) {
      const p = normalizePrefs({ leftWidth: 300, pet: junk });
      expect(p.pet).toEqual(PET_DEFAULT);
      expect(p.leftWidth).toBe(300);
    }
  });

  it('the assistant window size: 0 is the default size, a set size is clamped to 280×240 … 4096 (same rules as ui_prefs.rs)', () => {
    expect([BUBBLE_MIN.w, BUBBLE_MIN.h]).toEqual([280, 240]);
    const pet = (o: Record<string, unknown>) => normalizePrefs({ pet: o }).pet;
    expect(pet({ bubbleW: 500.4, bubbleH: 420 })).toMatchObject({ bubbleW: 500, bubbleH: 420 });
    expect(pet({ bubbleW: 100, bubbleH: 1 })).toMatchObject({ bubbleW: 280, bubbleH: 240 });
    expect(pet({ bubbleW: 1e9, bubbleH: 99999 })).toMatchObject({ bubbleW: PET_OFFSET_MAX, bubbleH: PET_OFFSET_MAX });
    for (const junk of [0, -5, 'wide', null, true, Number.NaN])
      expect(pet({ bubbleW: junk, bubbleH: junk }), String(junk)).toMatchObject({ bubbleW: 0, bubbleH: 0 });
    // one side alone is not a size: both go back to the default
    expect(pet({ bubbleW: 500 })).toMatchObject({ bubbleW: 0, bubbleH: 0 });
  });

  it('setPet merges into pet, and a pet write and a sidebar-width change in quick succession both reach Rust (single writer)', () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async (_cmd: string, args?: Record<string, unknown>) => (args?.prefs as UiPrefs | undefined) ?? null);
    const store = createLayoutStore({ storage: () => memoryStorage(), invoke });
    store.setPet({ x: 100, y: 60 });
    store.update({ leftWidth: 330 });
    store.setPet({ hidden: true });
    expect(store.get().pet).toEqual({ ...PET_DEFAULT, x: 100, y: 60, hidden: true });
    vi.advanceTimersByTime(WRITE_DEBOUNCE_MS);
    expect(invoke).toHaveBeenCalledTimes(1);
    const sent = invoke.mock.calls[0][1]!.prefs as UiPrefs;
    expect(sent.leftWidth).toBe(330);
    expect(sent.pet).toEqual({ ...PET_DEFAULT, x: 100, y: 60, hidden: true });
  });

  it('the pet is not in the first-frame localStorage mirror', () => {
    const storage = memoryStorage();
    const store = createLayoutStore({ storage: () => storage, invoke: vi.fn(async () => null) });
    store.setPet({ x: 200 });
    const mirror = JSON.parse(storage.getItem(LAYOUT_KEY)!);
    expect(mirror.pet).toBeUndefined();
    expect(Object.keys(mirror)).not.toContain('pet');
  });

  it('a layout change during load still takes the pet from Rust (the mirror never had it)', async () => {
    let resolve!: (v: unknown) => void;
    const invoke = vi.fn((cmd: string) => (cmd === 'ui_prefs_read' ? new Promise((r) => (resolve = r)) : Promise.resolve(null)));
    const store = createLayoutStore({ storage: () => memoryStorage(), invoke: invoke as never });
    const p = store.load(invoke as never);
    store.update({ leftHidden: true });
    resolve({ ...DEFAULT_PREFS, pet: { ...PET_DEFAULT, x: 300, hidden: true } });
    await p;
    expect(store.get().leftHidden).toBe(true);
    expect(store.get().pet).toMatchObject({ x: 300, hidden: true });
    // ...but a pet change made during load wins over the loaded pet
    const q = store.load(invoke as never);
    store.setPet({ x: 50 });
    resolve({ ...DEFAULT_PREFS, pet: { ...PET_DEFAULT, x: 999 } });
    await q;
    expect(store.get().pet.x).toBe(50);
  });
});
