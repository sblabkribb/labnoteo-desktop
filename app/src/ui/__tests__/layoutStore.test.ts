// @vitest-environment jsdom
import {
  applyToDom,
  createLayoutStore,
  DEFAULT_PREFS,
  LAYOUT_KEY,
  normalizePrefs,
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
